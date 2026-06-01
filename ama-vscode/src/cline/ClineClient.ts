import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ClineService } from '../services/ClineService';

/**
 * CLINE communication client.
 * Supports MCP (HTTP), WebSocket, and REST transports.
 * Priority: MCP > WebSocket > REST (fallback).
 */
export type ClineTransportType = 'mcp' | 'websocket' | 'rest';

export interface ClineClientConfig {
    /** Transport type to use */
    transport: ClineTransportType;
    /** MCP HTTP endpoint URL (e.g., http://localhost:5050) */
    mcpUrl: string;
    /** WebSocket URL (e.g., ws://localhost:5051) */
    wsUrl: string;
    /** REST API base URL (e.g., http://localhost:5052) */
    restUrl: string;
    /** Connection timeout in ms */
    timeoutMs: number;
}

export interface ClineTaskResult {
    success: boolean;
    taskId?: string;
    output?: string;
    logs?: string[];
    error?: string;
    status?: string;
    startedAt?: string;
    completedAt?: string;
}

export interface ClineStatus {
    connected: boolean;
    version?: string;
    uptime?: number;
    currentTask?: string;
    taskQueue?: number;
    memoryUsage?: number;
}

/**
 * CLINE client that communicates with the CLINE MCP server.
 * Reads configuration from .env file (CLINE_MCP_URL, CLINE_WS_URL).
 */
export class ClineClient {
    private static instance: ClineClient;
    private config: ClineClientConfig;
    private _isConnected: boolean = false;
    private _connectionCheckTimer: NodeJS.Timeout | null = null;
    private _onConnectionChanged = new vscode.EventEmitter<boolean>();
    private _onLogReceived = new vscode.EventEmitter<string>();

    readonly onConnectionChanged: vscode.Event<boolean> = this._onConnectionChanged.event;
    readonly onLogReceived: vscode.Event<string> = this._onLogReceived.event;

    private constructor() {
        this.config = this.loadConfig();
    }

    static getInstance(): ClineClient {
        if (!ClineClient.instance) {
            ClineClient.instance = new ClineClient();
        }
        return ClineClient.instance;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /**
     * Load configuration from .env file.
     */
    private loadConfig(): ClineClientConfig {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let envPath = '.env';
        if (workspaceFolders && workspaceFolders.length > 0) {
            envPath = path.join(workspaceFolders[0].uri.fsPath, '.env');
        }

        const envVars: Record<string, string> = {};
        try {
            if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf-8');
                for (const line of content.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const eqIndex = trimmed.indexOf('=');
                        if (eqIndex > 0) {
                            const key = trimmed.substring(0, eqIndex).trim();
                            let value = trimmed.substring(eqIndex + 1).trim();
                            if ((value.startsWith('"') && value.endsWith('"')) ||
                                (value.startsWith("'") && value.endsWith("'"))) {
                                value = value.slice(1, -1);
                            }
                            envVars[key] = value;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to load .env file for ClineClient:', err);
        }

        const mcpUrl = envVars['CLINE_MCP_URL'] || process.env['CLINE_MCP_URL'] || 'http://localhost:5050';
        const wsUrl = envVars['CLINE_WS_URL'] || process.env['CLINE_WS_URL'] || 'ws://localhost:5051';
        const restUrl = envVars['CLINE_REST_URL'] || process.env['CLINE_REST_URL'] || 'http://localhost:5052';

        // Determine transport: prefer MCP if URL is set and not default
        let transport: ClineTransportType = 'mcp';
        if (envVars['CLINE_TRANSPORT']) {
            transport = envVars['CLINE_TRANSPORT'] as ClineTransportType;
        }

        return {
            transport,
            mcpUrl,
            wsUrl,
            restUrl,
            timeoutMs: parseInt(envVars['CLINE_TIMEOUT_MS'] || '30000', 10),
        };
    }

    /**
     * Reload configuration from .env (useful after .env changes).
     */
    reloadConfig(): void {
        this.config = this.loadConfig();
    }

    /**
     * Connect to CLINE by checking the MCP endpoint health.
     */
    async connect(): Promise<boolean> {
        const service = ClineService.getInstance();
        service.addLog('info', `🔌 [ClineClient] 正在连接 CLINE (${this.config.transport}: ${this.config.mcpUrl})...`);

        try {
            const status = await this.getStatus();
            if (status && status.connected !== false) {
                this._isConnected = true;
                this._onConnectionChanged.fire(true);
                service.addLog('success', `✅ [ClineClient] 成功连接到 CLINE (v${status.version || 'unknown'})`);
                this.startHealthCheck();
                return true;
            }
            this._isConnected = false;
            this._onConnectionChanged.fire(false);
            service.addLog('error', '❌ [ClineClient] CLINE 返回了非健康状态');
            return false;
        } catch (err: any) {
            this._isConnected = false;
            this._onConnectionChanged.fire(false);
            service.addLog('error', `❌ [ClineClient] 连接失败: ${err.message}`);
            return false;
        }
    }

    /**
     * Disconnect from CLINE.
     */
    disconnect(): void {
        this.stopHealthCheck();
        this._isConnected = false;
        this._onConnectionChanged.fire(false);
        ClineService.getInstance().addLog('info', '🔌 [ClineClient] 已断开与 CLINE 的连接');
    }

    /**
     * Start periodic health check.
     */
    private startHealthCheck(): void {
        this.stopHealthCheck();
        this._connectionCheckTimer = setInterval(async () => {
            try {
                const status = await this.getStatus();
                if (!status || status.connected === false) {
                    this._isConnected = false;
                    this._onConnectionChanged.fire(false);
                } else if (!this._isConnected) {
                    this._isConnected = true;
                    this._onConnectionChanged.fire(true);
                }
            } catch {
                if (this._isConnected) {
                    this._isConnected = false;
                    this._onConnectionChanged.fire(false);
                }
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Stop health check timer.
     */
    private stopHealthCheck(): void {
        if (this._connectionCheckTimer) {
            clearInterval(this._connectionCheckTimer);
            this._connectionCheckTimer = null;
        }
    }

    // ============================================================
    // MCP HTTP Transport
    // ============================================================

    /**
     * Make an HTTP request to the MCP endpoint.
     */
    private async mcpRequest(method: string, endpoint: string, body?: any): Promise<any> {
        const baseUrl = this.config.mcpUrl.endsWith('/') ? this.config.mcpUrl.slice(0, -1) : this.config.mcpUrl;
        const url = new URL(baseUrl + endpoint);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + (url.search || ''),
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'AMA-VSCode-Extension',
                    'Accept': 'application/json',
                },
                timeout: this.config.timeoutMs,
            };

            const bodyStr = body ? JSON.stringify(body) : undefined;
            if (bodyStr && options.headers) {
                (options.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(bodyStr).toString();
            }

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve({
                            statusCode: res.statusCode,
                            body: data ? JSON.parse(data) : null,
                            rawBody: data,
                        });
                    } catch {
                        resolve({
                            statusCode: res.statusCode,
                            body: null,
                            rawBody: data,
                        });
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`MCP request failed: ${err.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`MCP request timed out after ${this.config.timeoutMs}ms`));
            });

            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Get CLINE server status.
     */
    async getStatus(): Promise<ClineStatus> {
        try {
            const response = await this.mcpRequest('GET', '/status');
            if (response.statusCode === 200 && response.body) {
                return {
                    connected: true,
                    version: response.body.version,
                    uptime: response.body.uptime,
                    currentTask: response.body.currentTask,
                    taskQueue: response.body.taskQueue,
                    memoryUsage: response.body.memoryUsage,
                };
            }
            return { connected: false };
        } catch {
            return { connected: false };
        }
    }

    /**
     * Run a task on CLINE.
     * @param task - Task object with at least a `name` and `description`.
     */
    async runTask(task: { name: string; description: string; [key: string]: any }): Promise<ClineTaskResult> {
        const service = ClineService.getInstance();
        service.addLog('info', `🚀 [ClineClient] 正在向 CLINE 提交任务: ${task.name}`);

        try {
            const response = await this.mcpRequest('POST', '/task/run', {
                name: task.name,
                description: task.description,
                params: task.params || {},
            });

            if (response.statusCode === 200 || response.statusCode === 201) {
                const result = response.body;
                const taskResult: ClineTaskResult = {
                    success: true,
                    taskId: result.taskId || result.id,
                    output: result.output || result.result,
                    logs: result.logs || [],
                    status: result.status || 'completed',
                    startedAt: result.startedAt,
                    completedAt: result.completedAt,
                };

                service.addLog('success', `✅ [ClineClient] 任务完成: ${task.name} (ID: ${taskResult.taskId})`);

                // Log the output
                if (taskResult.output) {
                    const lines = taskResult.output.split('\n').filter((l: string) => l.trim());
                    for (const line of lines.slice(0, 20)) {
                        service.addLog('info', `  📄 ${line}`);
                    }
                    if (lines.length > 20) {
                        service.addLog('info', `  ... 还有 ${lines.length - 20} 行输出`);
                    }
                }

                // Log any execution logs
                if (taskResult.logs && taskResult.logs.length > 0) {
                    for (const log of taskResult.logs) {
                        service.addLog('info', `  📋 ${log}`);
                        this._onLogReceived.fire(log);
                    }
                }

                return taskResult;
            } else {
                const errorMsg = response.body?.error || response.rawBody || `HTTP ${response.statusCode}`;
                service.addLog('error', `❌ [ClineClient] 任务执行失败: ${errorMsg}`);
                return {
                    success: false,
                    error: errorMsg,
                    status: 'failed',
                };
            }
        } catch (err: any) {
            service.addLog('error', `❌ [ClineClient] 任务执行异常: ${err.message}`);
            return {
                success: false,
                error: err.message,
                status: 'failed',
            };
        }
    }

    /**
     * Get execution logs for a specific task.
     */
    async getTaskLogs(taskId: string): Promise<string[]> {
        try {
            const response = await this.mcpRequest('GET', `/task/${encodeURIComponent(taskId)}/logs`);
            if (response.statusCode === 200 && response.body) {
                return response.body.logs || response.body || [];
            }
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Get all recent logs from CLINE.
     */
    async getLogs(): Promise<string[]> {
        try {
            const response = await this.mcpRequest('GET', '/logs');
            if (response.statusCode === 200 && response.body) {
                return Array.isArray(response.body) ? response.body : (response.body.logs || []);
            }
            return [];
        } catch {
            return [];
        }
    }

    /**
     * Abort a running task.
     */
    async abortTask(taskId: string): Promise<boolean> {
        try {
            const response = await this.mcpRequest('POST', `/task/${encodeURIComponent(taskId)}/abort`);
            return response.statusCode === 200;
        } catch {
            return false;
        }
    }

    /**
     * Send a custom command to CLINE.
     */
    async sendCommand(command: string, params?: any): Promise<any> {
        try {
            const response = await this.mcpRequest('POST', '/execute', { command, params });
            return response.body || response.rawBody;
        } catch (err: any) {
            ClineService.getInstance().addLog('error', `❌ [ClineClient] 命令执行失败: ${err.message}`);
            return null;
        }
    }
}
