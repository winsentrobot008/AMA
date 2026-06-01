import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { TaskChain } from '../types/TaskChain';

/**
 * DeepSeek API client for LLM-powered task orchestration.
 * Reads credentials from .env file in the workspace root.
 */
export interface DeepSeekConfig {
    apiKey: string;
    apiBase: string;
    model: string;
    clineMcpUrl: string;
}

export interface DeepSeekMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface DeepSeekResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class DeepSeekClient {
    private static instance: DeepSeekClient;
    private config: DeepSeekConfig | null = null;

    private constructor() {}

    static getInstance(): DeepSeekClient {
        if (!DeepSeekClient.instance) {
            DeepSeekClient.instance = new DeepSeekClient();
        }
        return DeepSeekClient.instance;
    }

    /**
     * Load configuration from .env file in the workspace root.
     */
    loadConfig(): DeepSeekConfig {
        if (this.config) {
            return this.config;
        }

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
                            // Remove surrounding quotes if present
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
            console.error('Failed to load .env file:', err);
        }

        this.config = {
            apiKey: envVars['DEEPSEEK_API_KEY'] || process.env['DEEPSEEK_API_KEY'] || '',
            apiBase: envVars['DEEPSEEK_API_BASE'] || process.env['DEEPSEEK_API_BASE'] || 'https://api.deepseek.com/v1',
            model: envVars['DEEPSEEK_MODEL'] || process.env['DEEPSEEK_MODEL'] || 'deepseek-chat',
            clineMcpUrl: envVars['CLINE_MCP_URL'] || process.env['CLINE_MCP_URL'] || 'http://localhost:5050',
        };

        return this.config;
    }

    /**
     * Check if the DeepSeek client is properly configured.
     */
    isConfigured(): boolean {
        const config = this.loadConfig();
        return !!(config.apiKey && config.apiBase);
    }

    /**
     * Send a prompt to DeepSeek API and get the response.
     * Uses OpenAI-compatible chat completions endpoint.
     */
    async askLLM(prompt: string, systemPrompt?: string): Promise<string> {
        const config = this.loadConfig();

        if (!config.apiKey) {
            throw new Error('DEEPSEEK_API_KEY is not configured. Please set it in .env file.');
        }

        const messages: DeepSeekMessage[] = [];

        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        messages.push({ role: 'user', content: prompt });

        const requestBody = JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.3,
            max_tokens: 4096,
        });

        const baseUrl = config.apiBase.endsWith('/') ? config.apiBase : config.apiBase + '/';
        const url = new URL(baseUrl + 'chat/completions');

        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'AMA-VSCode-Extension',
                    'Content-Length': Buffer.byteLength(requestBody).toString(),
                },
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode === 200) {
                            const response: DeepSeekResponse = JSON.parse(data);
                            if (response.choices && response.choices.length > 0) {
                                resolve(response.choices[0].message.content);
                            } else {
                                reject(new Error('DeepSeek API returned no choices'));
                            }
                        } else {
                            let errorMsg = `DeepSeek API returned HTTP ${res.statusCode}`;
                            try {
                                const errBody = JSON.parse(data);
                                errorMsg += `: ${errBody.error?.message || errBody.error || data}`;
                            } catch {
                                errorMsg += `: ${data}`;
                            }
                            reject(new Error(errorMsg));
                        }
                    } catch (err: any) {
                        reject(new Error(`Failed to parse DeepSeek response: ${err.message}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`DeepSeek request failed: ${err.message}`)));
            req.write(requestBody);
            req.end();
        });
    }

    /**
     * Generate a structured task chain from a natural language description.
     * Uses DeepSeek to parse the user's intent and output a JSON task chain.
     *
     * @param naturalLanguage - User's natural language description of what they want to accomplish.
     * @returns A TaskChain (array of TaskChainStep) parsed from the LLM response.
     */
    async generateTaskChain(naturalLanguage: string): Promise<TaskChain> {
        const config = this.loadConfig();

        if (!config.apiKey) {
            throw new Error('DEEPSEEK_API_KEY is not configured. Please set it in .env file.');
        }

        const systemPrompt = `你是一个 AMA (AI Messenger Agent) 的任务链生成器。
你的职责是将用户的自然语言需求解析为结构化的任务链（Task Chain）。

任务链是一个 JSON 数组，每个元素代表一个步骤，格式如下：

[
  {
    "id": "step1",
    "action": "git_pull",
    "description": "拉取最新代码",
    "repo": "owner/repo"
  },
  {
    "id": "step2",
    "action": "npm_build",
    "description": "构建前端项目",
    "dir": "frontend"
  },
  {
    "id": "step3",
    "action": "deploy_render",
    "description": "部署到 Render",
    "service": "my-service"
  }
]

可用的 action 类型（不限于此，可根据需要创造）：
- git_pull: 拉取代码
- npm_build: npm 构建
- npm_test: 运行测试
- deploy_render: 部署到 Render
- deploy_vercel: 部署到 Vercel
- docker_build: Docker 构建
- docker_push: 推送 Docker 镜像
- run_script: 运行自定义脚本
- create_file: 创建文件
- edit_file: 编辑文件
- run_command: 执行任意命令
- notify: 发送通知
- wait: 等待

要求：
1. 每个步骤必须有唯一的 id（step1, step2, ...）
2. 每个步骤必须有 action 和 description
3. 步骤按执行顺序排列
4. 只返回 JSON 数组，不要包含其他文字或 markdown 代码块标记
5. 如果用户需求不明确，做合理假设并生成对应的任务链`;

        const messages: DeepSeekMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: naturalLanguage },
        ];

        const requestBody = JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.2,
            max_tokens: 4096,
        });

        const baseUrl = config.apiBase.endsWith('/') ? config.apiBase : config.apiBase + '/';
        const url = new URL(baseUrl + 'chat/completions');

        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'AMA-VSCode-Extension',
                    'Content-Length': Buffer.byteLength(requestBody).toString(),
                },
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode === 200) {
                            const response: DeepSeekResponse = JSON.parse(data);
                            if (response.choices && response.choices.length > 0) {
                                const content = response.choices[0].message.content.trim();
                                // Try to extract JSON array from the response
                                let jsonStr = content;
                                const jsonMatch = content.match(/\[[\s\S]*\]/);
                                if (jsonMatch) {
                                    jsonStr = jsonMatch[0];
                                }
                                try {
                                    const chain: TaskChain = JSON.parse(jsonStr);
                                    // Validate the chain structure
                                    if (!Array.isArray(chain)) {
                                        reject(new Error('LLM did not return a valid task chain array'));
                                        return;
                                    }
                                    for (let i = 0; i < chain.length; i++) {
                                        if (!chain[i].id) {
                                            chain[i].id = `step${i + 1}`;
                                        }
                                        if (!chain[i].action) {
                                            reject(new Error(`Step ${chain[i].id} is missing 'action'`));
                                            return;
                                        }
                                    }
                                    resolve(chain);
                                } catch (parseErr: any) {
                                    reject(new Error(`Failed to parse task chain JSON: ${parseErr.message}\nRaw: ${content.substring(0, 200)}`));
                                }
                            } else {
                                reject(new Error('DeepSeek API returned no choices'));
                            }
                        } else {
                            let errorMsg = `DeepSeek API returned HTTP ${res.statusCode}`;
                            try {
                                const errBody = JSON.parse(data);
                                errorMsg += `: ${errBody.error?.message || errBody.error || data}`;
                            } catch {
                                errorMsg += `: ${data}`;
                            }
                            reject(new Error(errorMsg));
                        }
                    } catch (err: any) {
                        reject(new Error(`Failed to parse DeepSeek response: ${err.message}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`DeepSeek request failed: ${err.message}`)));
            req.write(requestBody);
            req.end();
        });
    }

    /**
     * Get CLINE status via MCP HTTP endpoint.
     */
    async getClineStatus(): Promise<any> {
        const config = this.loadConfig();
        const baseUrl = config.clineMcpUrl.endsWith('/') ? config.clineMcpUrl.slice(0, -1) : config.clineMcpUrl;
        const url = new URL(baseUrl + '/status');

        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const req = httpModule.get(url, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({ raw: data });
                    }
                });
            });
            req.on('error', (err) => reject(err));
            req.end();
        });
    }

    /**
     * Send a command to CLINE via MCP HTTP endpoint.
     */
    async sendClineCommand(command: string, params?: any): Promise<any> {
        const config = this.loadConfig();
        const baseUrl = config.clineMcpUrl.endsWith('/') ? config.clineMcpUrl.slice(0, -1) : config.clineMcpUrl;
        const url = new URL(baseUrl + '/execute');

        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const body = JSON.stringify({ command, params });

        return new Promise((resolve, reject) => {
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body).toString(),
                },
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({ raw: data });
                    }
                });
            });
            req.on('error', (err) => reject(err));
            req.write(body);
            req.end();
        });
    }
}
