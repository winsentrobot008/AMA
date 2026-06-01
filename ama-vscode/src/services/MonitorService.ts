import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ClineClient } from '../cline/ClineClient';
import { ClineService } from './ClineService';
import { TaskChainExecutor, TaskChainExecutionEvent } from '../executor/TaskChainExecutor';
import { TaskChain } from '../types/TaskChain';

/**
 * MonitorService — 实时监控服务
 * 
 * 职责：
 * 1. 将 CLINE / AMA 的日志写入 logs/cline.log 和 logs/ama.log
 * 2. 将 AMA 状态写入 state/ama_state.json
 * 3. 将项目文件结构写入 state/project_files.json
 */
export class MonitorService {
    private static instance: MonitorService;

    private workspaceRoot: string = '';
    private logsDir: string = '';
    private stateDir: string = '';
    private projectFilesTimer: NodeJS.Timeout | null = null;
    private amaState: AMAState = {
        timestamp: '',
        clineConnected: false,
        mcpConnected: false,
        polling: false,
        currentTaskChain: [],
        currentStep: '',
        lastError: null,
    };

    private constructor() {
        this.initDirectories();
    }

    static getInstance(): MonitorService {
        if (!MonitorService.instance) {
            MonitorService.instance = new MonitorService();
        }
        return MonitorService.instance;
    }

    // ============================================================
    // 目录初始化
    // ============================================================

    /**
     * 初始化 logs/ 和 state/ 目录。
     */
    private initDirectories(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspaceRoot = workspaceFolders[0].uri.fsPath;
        } else {
            // Fallback: use the extension's own directory
            this.workspaceRoot = path.join(__dirname, '..', '..', '..');
        }

        this.logsDir = path.join(this.workspaceRoot, 'logs');
        this.stateDir = path.join(this.workspaceRoot, 'state');

        // Create directories if they don't exist
        try {
            if (!fs.existsSync(this.logsDir)) {
                fs.mkdirSync(this.logsDir, { recursive: true });
            }
            if (!fs.existsSync(this.stateDir)) {
                fs.mkdirSync(this.stateDir, { recursive: true });
            }
        } catch (err) {
            console.error('[MonitorService] Failed to create directories:', err);
        }
    }

    /**
     * 获取工作区根目录。
     */
    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    // ============================================================
    // A. 日志写入
    // ============================================================

    /**
     * 写入一条日志到 logs/cline.log。
     * 格式: [YYYY-MM-DD HH:mm:ss] [LEVEL] message
     */
    writeClineLog(level: string, message: string): void {
        this.writeLogFile('cline.log', level, message);
    }

    /**
     * 写入一条日志到 logs/ama.log。
     * 格式: [YYYY-MM-DD HH:mm:ss] [LEVEL] message
     */
    writeAmaLog(level: string, message: string): void {
        this.writeLogFile('ama.log', level, message);
    }

    /**
     * 写入日志到指定文件。
     */
    private writeLogFile(filename: string, level: string, message: string): void {
        if (!this.logsDir) return;

        const timestamp = this.getTimestamp();
        const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
        const filePath = path.join(this.logsDir, filename);

        try {
            fs.appendFileSync(filePath, logLine, 'utf-8');
        } catch (err) {
            console.error(`[MonitorService] Failed to write ${filename}:`, err);
        }
    }

    /**
     * 获取格式化的时间戳: YYYY-MM-DD HH:mm:ss
     */
    private getTimestamp(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    // ============================================================
    // B. 状态文件 (state/ama_state.json)
    // ============================================================

    /**
     * 更新 ama_state.json。
     */
    private updateAmaState(partial: Partial<AMAState>): void {
        this.amaState = {
            ...this.amaState,
            ...partial,
            timestamp: this.getTimestamp(),
        };
        this.writeAmaStateFile();
    }

    /**
     * 将当前状态写入 state/ama_state.json。
     */
    private writeAmaStateFile(): void {
        if (!this.stateDir) return;

        const filePath = path.join(this.stateDir, 'ama_state.json');
        try {
            fs.writeFileSync(filePath, JSON.stringify(this.amaState, null, 2), 'utf-8');
        } catch (err) {
            console.error('[MonitorService] Failed to write ama_state.json:', err);
        }
    }

    /**
     * 更新 CLINE 连接状态。
     */
    setClineConnected(connected: boolean): void {
        this.updateAmaState({ clineConnected: connected });
        this.writeAmaLog('info', `CLINE 连接状态: ${connected ? '已连接' : '未连接'}`);
    }

    /**
     * 更新 MCP 连接状态。
     */
    setMcpConnected(connected: boolean): void {
        this.updateAmaState({ mcpConnected: connected });
        this.writeAmaLog('info', `MCP 连接状态: ${connected ? '已连接' : '未连接'}`);
    }

    /**
     * 更新轮询状态。
     */
    setPolling(polling: boolean): void {
        this.updateAmaState({ polling });
        this.writeAmaLog('info', `轮询状态: ${polling ? '运行中' : '已停止'}`);
    }

    /**
     * 更新当前任务链。
     */
    setCurrentTaskChain(chain: TaskChain): void {
        this.updateAmaState({ currentTaskChain: chain });
        this.writeAmaLog('info', `任务链已更新，共 ${chain.length} 个步骤`);
    }

    /**
     * 更新当前步骤。
     */
    setCurrentStep(step: string): void {
        this.updateAmaState({ currentStep: step });
    }

    /**
     * 更新最后错误。
     */
    setLastError(error: string | null): void {
        this.updateAmaState({ lastError: error });
        if (error) {
            this.writeAmaLog('error', `错误: ${error}`);
        }
    }

    /**
     * 更新 Worker 状态。
     */
    setWorkerStatus(workerStatus: string): void {
        this.writeAmaLog('info', `Worker 状态: ${workerStatus}`);
    }

    // ============================================================
    // C. 项目文件结构 (state/project_files.json)
    // ============================================================

    /**
     * 扫描整个项目目录并写入 project_files.json。
     */
    scanProjectFiles(): void {
        if (!this.stateDir || !this.workspaceRoot) return;

        try {
            const files = this.scanDirectory(this.workspaceRoot);
            const projectFiles = {
                timestamp: this.getTimestamp(),
                files,
            };

            const filePath = path.join(this.stateDir, 'project_files.json');
            fs.writeFileSync(filePath, JSON.stringify(projectFiles, null, 2), 'utf-8');
        } catch (err) {
            console.error('[MonitorService] Failed to scan project files:', err);
        }
    }

    /**
     * 递归扫描目录，返回所有文件路径（相对于工作区根目录）。
     */
    private scanDirectory(dirPath: string, relativePath: string = ''): string[] {
        const files: string[] = [];

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                // Skip node_modules, .git, out, logs, state directories
                if (entry.name === 'node_modules' || entry.name === '.git' ||
                    entry.name === 'out' || entry.name === 'logs' ||
                    entry.name === 'state') {
                    continue;
                }

                const fullPath = path.join(dirPath, entry.name);
                const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

                if (entry.isDirectory()) {
                    files.push(...this.scanDirectory(fullPath, relPath));
                } else if (entry.isFile()) {
                    files.push(relPath);
                }
            }
        } catch (err) {
            console.error(`[MonitorService] Failed to scan directory ${dirPath}:`, err);
        }

        return files;
    }

    /**
     * 启动项目文件扫描定时器（每 10 秒刷新一次）。
     */
    startProjectFilesMonitoring(): void {
        this.stopProjectFilesMonitoring();
        this.scanProjectFiles();
        this.projectFilesTimer = setInterval(() => {
            this.scanProjectFiles();
        }, 10000);
    }

    /**
     * 停止项目文件扫描定时器。
     */
    stopProjectFilesMonitoring(): void {
        if (this.projectFilesTimer) {
            clearInterval(this.projectFilesTimer);
            this.projectFilesTimer = null;
        }
    }

    // ============================================================
    // 集成：监听各服务的事件
    // ============================================================

    /**
     * 开始监听所有服务的事件并写入日志和状态文件。
     * 在 extension.ts 的 activate() 中调用。
     */
    startMonitoring(): void {
        const clineService = ClineService.getInstance();
        const clineClient = ClineClient.getInstance();
        const taskChainExecutor = TaskChainExecutor.getInstance();

        // --- 监听 CLINE 连接状态变化 ---
        clineService.onConnectionChanged((isConnected) => {
            this.setClineConnected(isConnected);
            this.writeClineLog('info', `CLINE (GitHub) 连接状态: ${isConnected ? '已连接' : '未连接'}`);
        });

        // --- 监听 MCP 连接状态变化 ---
        clineClient.onConnectionChanged((isConnected) => {
            this.setMcpConnected(isConnected);
            this.writeClineLog('info', `CLINE MCP 连接状态: ${isConnected ? '已连接' : '未连接'}`);
        });

        // --- 监听轮询状态变化 ---
        clineService.onPollingChanged((isPolling) => {
            this.setPolling(isPolling);
            this.writeClineLog('info', `轮询状态: ${isPolling ? '已启动' : '已停止'}`);
        });

        // --- 监听日志事件，写入 cline.log ---
        clineService.onLogReceived((entry) => {
            this.writeClineLog(entry.level, entry.message);
        });

        // --- 监听任务链执行事件 ---
        taskChainExecutor.onExecutionEvent((event: TaskChainExecutionEvent) => {
            switch (event.type) {
                case 'started':
                    this.setCurrentStep(event.message || '任务链开始执行');
                    this.writeClineLog('info', `[Executor] ${event.message}`);
                    this.writeAmaLog('info', `[Executor] ${event.message}`);
                    break;

                case 'stepStarted':
                    this.setCurrentStep(event.message || `步骤 ${(event.stepIndex ?? 0) + 1} 开始`);
                    this.writeClineLog('info', `[Executor] ${event.message}`);
                    break;

                case 'stepCompleted':
                    this.setCurrentStep(event.message || `步骤 ${(event.stepIndex ?? 0) + 1} 完成`);
                    this.writeClineLog('success', `[Executor] ${event.message}`);
                    break;

                case 'stepFailed':
                    this.setCurrentStep(event.message || `步骤 ${(event.stepIndex ?? 0) + 1} 失败`);
                    this.setLastError(event.message || '步骤执行失败');
                    this.writeClineLog('error', `[Executor] ${event.message}`);
                    this.writeAmaLog('error', `[Executor] ${event.message}`);
                    break;

                case 'stepRetrying':
                    this.setCurrentStep(event.message || `步骤 ${(event.stepIndex ?? 0) + 1} 重试中`);
                    this.writeClineLog('warn', `[Executor] ${event.message}`);
                    break;

                case 'completed':
                    this.setCurrentStep('任务链执行完毕');
                    this.setLastError(null);
                    this.writeClineLog('success', `[Executor] ${event.message}`);
                    this.writeAmaLog('success', `[Executor] ${event.message}`);
                    break;

                case 'aborted':
                    this.setCurrentStep('任务链已中止');
                    this.writeClineLog('warn', `[Executor] ${event.message}`);
                    this.writeAmaLog('warn', `[Executor] ${event.message}`);
                    break;

                case 'error':
                    this.setLastError(event.message || '任务链执行错误');
                    this.writeClineLog('error', `[Executor] ${event.message}`);
                    this.writeAmaLog('error', `[Executor] ${event.message}`);
                    break;
            }
        });

        // --- 启动项目文件监控 ---
        this.startProjectFilesMonitoring();

        // --- 写入启动日志 ---
        this.writeAmaLog('info', '🚀 MonitorService 已启动');
        this.writeClineLog('info', '🚀 MonitorService 已启动');
    }

    /**
     * 停止监控。
     */
    stopMonitoring(): void {
        this.stopProjectFilesMonitoring();
        this.writeAmaLog('info', '⏹️ MonitorService 已停止');
        this.writeClineLog('info', '⏹️ MonitorService 已停止');
    }
}

/**
 * AMA 状态接口。
 */
export interface AMAState {
    timestamp: string;
    clineConnected: boolean;
    mcpConnected: boolean;
    polling: boolean;
    currentTaskChain: TaskChain;
    currentStep: string;
    lastError: string | null;
}
