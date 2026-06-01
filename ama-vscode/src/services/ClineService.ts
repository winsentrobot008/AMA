import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/ConfigManager';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
}

export interface GitHubIssue {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    created_at: string;
    updated_at: string;
    labels: Array<{ name: string }>;
}

export interface PollingState {
    processed_issues: number[];
}

export class ClineService {
    private static instance: ClineService;
    private static readonly MAX_LOG_ENTRIES = 500;

    private _isConnected: boolean = false;
    private _isPolling: boolean = false;
    private _isPollingInProgress: boolean = false;
    private _logs: LogEntry[] = [];
    private _pollTimer: NodeJS.Timeout | null = null;
    private _onLogReceived = new vscode.EventEmitter<LogEntry>();
    private _onConnectionChanged = new vscode.EventEmitter<boolean>();
    private _onPollingChanged = new vscode.EventEmitter<boolean>();
    private _onTaskDiscovered = new vscode.EventEmitter<void>();

    readonly onLogReceived: vscode.Event<LogEntry> = this._onLogReceived.event;
    readonly onConnectionChanged: vscode.Event<boolean> = this._onConnectionChanged.event;
    readonly onPollingChanged: vscode.Event<boolean> = this._onPollingChanged.event;
    readonly onTaskDiscovered: vscode.Event<void> = this._onTaskDiscovered.event;

    private constructor() {}

    static getInstance(): ClineService {
        if (!ClineService.instance) {
            ClineService.instance = new ClineService();
        }
        return ClineService.instance;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get isPolling(): boolean {
        return this._isPolling;
    }

    get logs(): LogEntry[] {
        return [...this._logs];
    }

    // ============================================================
    // HTTPS helper
    // ============================================================

    /**
     * Make an HTTPS request and return parsed JSON response.
     */
    private httpsRequest(options: https.RequestOptions, body?: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve({
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            body: data ? JSON.parse(data) : null,
                            rawBody: data,
                        });
                    } catch {
                        resolve({
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            body: null,
                            rawBody: data,
                        });
                    }
                });
            });
            req.on('error', (err) => reject(err));
            if (body) {
                req.write(body);
            }
            req.end();
        });
    }

    // ============================================================
    // Connection
    // ============================================================

    /**
     * Connect to CLINE by verifying the GitHub token and repo from config.
     */
    async connect(): Promise<boolean> {
        this.addLog('info', '正在连接到 CLINE...');

        const config = ConfigManager.getInstance().getConfig();

        if (!config.githubToken || config.githubToken === 'YOUR_GITHUB_TOKEN_HERE') {
            this.addLog('error', '❌ GitHub Token 未配置，请在 config.json 或 VS Code 设置中配置 ama.githubToken');
            this._isConnected = false;
            this._onConnectionChanged.fire(false);
            return false;
        }

        if (!config.repo) {
            this.addLog('error', '❌ 仓库地址未配置，请在 config.json 或 VS Code 设置中配置 ama.repo');
            this._isConnected = false;
            this._onConnectionChanged.fire(false);
            return false;
        }

        try {
            const response = await this.httpsRequest({
                hostname: 'api.github.com',
                path: `/repos/${config.repo}`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'AMA-VSCode-Extension',
                },
            });

            if (response.statusCode === 200) {
                this.addLog('success', `✅ 成功连接到仓库: ${config.repo}`);
                this.addLog('info', `📦 仓库描述: ${response.body?.description || '无描述'}`);
                this._isConnected = true;
                this._onConnectionChanged.fire(true);
                return true;
            } else if (response.statusCode === 401) {
                this.addLog('error', '❌ GitHub Token 无效或已过期，请检查配置');
                this._isConnected = false;
                this._onConnectionChanged.fire(false);
                return false;
            } else if (response.statusCode === 404) {
                this.addLog('error', `❌ 仓库 ${config.repo} 不存在或无权访问`);
                this._isConnected = false;
                this._onConnectionChanged.fire(false);
                return false;
            } else {
                this.addLog('error', `❌ 连接失败 (HTTP ${response.statusCode}): ${response.statusMessage}`);
                this._isConnected = false;
                this._onConnectionChanged.fire(false);
                return false;
            }
        } catch (err: any) {
            this.addLog('error', `❌ 连接异常: ${err.message || '未知错误'}`);
            this._isConnected = false;
            this._onConnectionChanged.fire(false);
            return false;
        }
    }

    // ============================================================
    // Polling
    // ============================================================

    /**
     * Start polling GitHub Issues with the configured label.
     */
    startPolling(): void {
        if (this._isPolling) {
            this.addLog('warn', '⚠️ 轮询已在运行中');
            return;
        }

        if (!this._isConnected) {
            this.addLog('error', '❌ 未连接到 CLINE，请先点击 "Connect to CLINE"');
            return;
        }

        this._isPolling = true;
        this._onPollingChanged.fire(true);
        this.addLog('success', '🔄 轮询已启动');

        // Run the first poll immediately
        this.pollOnce();

        // Schedule subsequent polls
        const config = ConfigManager.getInstance().getConfig();
        const interval = config.pollIntervalSeconds * 1000;
        this._pollTimer = setInterval(() => this.pollOnce(), interval);
        this.addLog('info', `⏱️ 轮询间隔: ${config.pollIntervalSeconds} 秒`);
    }

    /**
     * Stop the polling loop.
     */
    stopPolling(): void {
        if (!this._isPolling) {
            this.addLog('warn', '⚠️ 轮询未在运行');
            return;
        }

        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }

        this._isPolling = false;
        this._onPollingChanged.fire(false);
        this.addLog('info', '⏹️ 轮询已停止');
    }

    /**
     * Perform a single poll: fetch labeled issues and process new ones.
     * Skips if a poll is already in progress to prevent overlapping polls.
     */
    private async pollOnce(): Promise<void> {
        // Prevent overlapping polls
        if (this._isPollingInProgress) {
            this.addLog('warn', '⚠️ 上次轮询尚未完成，跳过本次轮询');
            return;
        }

        this._isPollingInProgress = true;
        const config = ConfigManager.getInstance().getConfig();

        try {
            const issues = await this.fetchLabeledIssues(config.githubToken, config.repo, config.label);
            const state = this.loadPollingState();
            let newTaskCount = 0;

            for (const issue of issues) {
                const issueId = issue.number;
                if (state.processed_issues.includes(issueId)) {
                    continue;
                }

                this.addLog('info', `[!] 发现新任务 Issue #${issueId}: ${issue.title}`);
                this.createTaskFile(config.tasksDir, issue);
                await this.commentOnIssue(config.githubToken, config.repo, issueId, '👷 AMA 已接收任务，状态：**执行中**');
                state.processed_issues.push(issueId);
                newTaskCount++;
            }

            if (newTaskCount > 0) {
                this.savePollingState(state);
                this.addLog('success', `✅ 本次轮询发现 ${newTaskCount} 个新任务`);
                // Notify listeners that new tasks were discovered
                this._onTaskDiscovered.fire();
            }
        } catch (err: any) {
            this.addLog('error', `❌ 轮询时发生异常: ${err.message || '未知错误'}`);
        } finally {
            this._isPollingInProgress = false;
        }
    }

    /**
     * Fetch open issues with the specified label from GitHub.
     */
    private async fetchLabeledIssues(token: string, repo: string, label: string): Promise<GitHubIssue[]> {
        const response = await this.httpsRequest({
            hostname: 'api.github.com',
            path: `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'AMA-VSCode-Extension',
            },
        });

        if (response.statusCode === 200) {
            return response.body || [];
        } else {
            throw new Error(`GitHub API 返回 ${response.statusCode}: ${response.statusMessage}`);
        }
    }

    /**
     * Create a task markdown file from a GitHub issue.
     */
    private createTaskFile(tasksDir: string, issue: GitHubIssue): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.addLog('error', '❌ 无法获取工作区目录');
            return;
        }

        const tasksPath = path.join(workspaceFolders[0].uri.fsPath, tasksDir);
        // Ensure tasks directory exists
        try {
            if (!fs.existsSync(tasksPath)) {
                fs.mkdirSync(tasksPath, { recursive: true });
            }
        } catch (err: any) {
            this.addLog('error', `❌ 创建任务目录失败: ${err.message || '未知错误'}`);
            return;
        }

        const issueId = issue.number;
        const title = issue.title;
        const body = issue.body || '';
        const filename = path.join(tasksPath, `issue-${issueId}.md`);

        const content = `# GitHub Issue #${issueId}: ${title}

原始 Issue 链接：${issue.html_url}

---

## 任务说明（来自 Issue）

${body}

---

## 给 CLINE 的建议提示（复制到 VSCode 的 CLINE 输入框）

请根据上面的 Issue 内容执行以下步骤：
1. 理解需求并补充必要假设；
2. 规划实现步骤；
3. 修改/新增代码文件；
4. 运行必要测试；
5. 准备提交 PR 的变更说明。
`;

        try {
            fs.writeFileSync(filename, content, 'utf-8');
            this.addLog('success', `[+] 生成任务文件: ${filename}`);
        } catch (err: any) {
            this.addLog('error', `❌ 写入任务文件失败: ${err.message || '未知错误'}`);
        }
    }

    /**
     * Post a comment on a GitHub issue.
     */
    private async commentOnIssue(token: string, repo: string, issueNumber: number, comment: string): Promise<void> {
        const postBody = JSON.stringify({ body: comment });

        const response = await this.httpsRequest({
            hostname: 'api.github.com',
            path: `/repos/${repo}/issues/${issueNumber}/comments`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'AMA-VSCode-Extension',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postBody).toString(),
            },
        }, postBody);

        if (response.statusCode === 201) {
            this.addLog('success', `[+] 已回写 Issue #${issueNumber} 评论`);
        } else {
            this.addLog('warn', `⚠️ 回写 Issue #${issueNumber} 评论失败 (HTTP ${response.statusCode})`);
        }
    }

    /**
     * Load polling state from state.json.
     */
    private loadPollingState(): PollingState {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { processed_issues: [] };
        }

        const statePath = path.join(workspaceFolders[0].uri.fsPath, 'state.json');
        if (!fs.existsSync(statePath)) {
            return { processed_issues: [] };
        }

        try {
            const raw = fs.readFileSync(statePath, 'utf-8');
            return JSON.parse(raw);
        } catch {
            return { processed_issues: [] };
        }
    }

    /**
     * Save polling state to state.json.
     */
    private savePollingState(state: PollingState): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const statePath = path.join(workspaceFolders[0].uri.fsPath, 'state.json');
        try {
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
        } catch (err: any) {
            this.addLog('error', `❌ 保存轮询状态失败: ${err.message || '未知错误'}`);
        }
    }

    // ============================================================
    // Task execution
    // ============================================================

    /**
     * Run a task via CLINE (simulated by creating a GitHub issue with the task label).
     */
    async runTask(taskName: string, taskDescription: string): Promise<boolean> {
        if (!this._isConnected) {
            this.addLog('error', '❌ 未连接到 CLINE，请先点击 "Connect to CLINE"');
            return false;
        }

        const config = ConfigManager.getInstance().getConfig();
        this.addLog('info', `🚀 正在通过 CLINE 执行任务: ${taskName}`);

        try {
            const postBody = JSON.stringify({
                title: `[AMA] ${taskName}`,
                body: taskDescription,
                labels: [config.label || 'cline'],
            });

            const response = await this.httpsRequest({
                hostname: 'api.github.com',
                path: `/repos/${config.repo}/issues`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'AMA-VSCode-Extension',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postBody).toString(),
                },
            }, postBody);

            if (response.statusCode === 201) {
                this.addLog('success', `✅ 任务已提交: ${taskName} (Issue #${response.body?.number})`);
                return true;
            } else {
                this.addLog('error', `❌ 提交任务失败 (HTTP ${response.statusCode}): ${response.rawBody || response.statusMessage}`);
                return false;
            }
        } catch (err: any) {
            this.addLog('error', `❌ 执行任务异常: ${err.message || '未知错误'}`);
            return false;
        }
    }

    // ============================================================
    // Logging
    // ============================================================

    /**
     * Add a log entry and emit the event.
     * Automatically trims old entries when exceeding MAX_LOG_ENTRIES.
     */
    addLog(level: LogLevel, message: string): void {
        const entry: LogEntry = {
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            level,
            message,
        };
        this._logs.push(entry);

        // Trim old log entries to prevent unbounded memory growth
        if (this._logs.length > ClineService.MAX_LOG_ENTRIES) {
            this._logs = this._logs.slice(-ClineService.MAX_LOG_ENTRIES);
        }

        this._onLogReceived.fire(entry);
    }

    /**
     * Clear all logs.
     */
    clearLogs(): void {
        this._logs = [];
        this.addLog('info', '🗑️ 日志已清空');
    }
}
