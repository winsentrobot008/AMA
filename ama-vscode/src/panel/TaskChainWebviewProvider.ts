import * as vscode from 'vscode';
import { TaskChain, TaskChainStep, TaskChainExecutionState } from '../types/TaskChain';
import { TaskChainExecutor, TaskChainExecutionEvent } from '../executor/TaskChainExecutor';
import { ClineClient, ClineStatus } from '../cline/ClineClient';

/**
 * Webview provider for the AMA task chain view.
 * Displays the generated task chain and allows execution.
 * Acts as the AI scheduling center panel.
 */
export class TaskChainWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'amaTaskChainView';

    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];
    private _currentChain: TaskChain | null = null;
    private _clineStatusTimer: NodeJS.Timeout | null = null;
    private _lastClineStatus: ClineStatus | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _taskChainExecutor: TaskChainExecutor,
        private readonly _clineClient: ClineClient,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        // Listen for messages from the webview
        this._disposables.push(
            webviewView.webview.onDidReceiveMessage((message) => {
                switch (message.command) {
                    case 'executeChain':
                        this.handleExecuteChain();
                        break;
                    case 'abortExecution':
                        this.handleAbortExecution();
                        break;
                    case 'clearChain':
                        this.handleClearChain();
                        break;
                    case 'viewStepDetail':
                        this.handleViewStepDetail(message.stepIndex);
                        break;
                    case 'generateChain':
                        this.handleGenerateChain(message.text);
                        break;
                    case 'refreshClineStatus':
                        this.handleRefreshClineStatus();
                        break;
                }
            })
        );

        // Listen for execution events from the injected executor
        this._disposables.push(
            this._taskChainExecutor.onExecutionEvent((event) => {
                this.handleExecutionEvent(event);
            })
        );

        // Send initial state
        this.updateView();

        // Start CLINE status polling
        this.startClineStatusPolling();

        // Clean up
        webviewView.onDidDispose(() => {
            this.stopClineStatusPolling();
            this._disposables.forEach(d => d.dispose());
            this._disposables = [];
        });
    }

    /**
     * Set the current task chain and update the view.
     */
    setTaskChain(chain: TaskChain): void {
        this._currentChain = chain;
        this.updateView();
    }

    /**
     * Clear the current task chain.
     */
    clearTaskChain(): void {
        this._currentChain = null;
        this.updateView();
    }

    /**
     * Update the webview with the current state.
     */
    private updateView(): void {
        if (!this._view) return;

        const executor = TaskChainExecutor.getInstance();
        const execState = executor.currentState;

        this._view.webview.postMessage({
            command: 'setChain',
            chain: this._currentChain,
            executionState: execState,
            isRunning: executor.isRunning,
        });
    }

    /**
     * Handle execution events from the executor.
     */
    private handleExecutionEvent(event: TaskChainExecutionEvent): void {
        if (!this._view) return;

        this._view.webview.postMessage({
            command: 'executionEvent',
            event,
        });

        // Also update the full state periodically
        if (event.type === 'stepCompleted' || event.type === 'stepFailed' || event.type === 'stepStarted') {
            const executor = TaskChainExecutor.getInstance();
            this._view.webview.postMessage({
                command: 'updateExecutionState',
                executionState: executor.currentState,
                isRunning: executor.isRunning,
            });
        }
    }

    /**
     * Handle "Execute Chain" button click.
     */
    private async handleExecuteChain(): Promise<void> {
        if (!this._currentChain || this._currentChain.length === 0) {
            vscode.window.showWarningMessage('没有可执行的任务链');
            return;
        }

        const executor = TaskChainExecutor.getInstance();
        if (executor.isRunning) {
            vscode.window.showWarningMessage('任务链正在执行中');
            return;
        }

        try {
            await executor.executeTaskChain(this._currentChain);
        } catch (err: any) {
            vscode.window.showErrorMessage(`任务链执行失败: ${err.message}`);
        }
    }

    /**
     * Handle "Abort Execution" button click.
     */
    private async handleAbortExecution(): Promise<void> {
        const executor = TaskChainExecutor.getInstance();
        await executor.abortExecution();
    }

    /**
     * Handle "Clear Chain" button click.
     */
    private handleClearChain(): void {
        this.clearTaskChain();
    }

    /**
     * Handle "View Step Detail" request.
     */
    private async handleViewStepDetail(stepIndex: number): Promise<void> {
        if (!this._currentChain || stepIndex < 0 || stepIndex >= this._currentChain.length) return;

        const step = this._currentChain[stepIndex];
        const executor = TaskChainExecutor.getInstance();
        const execState = executor.currentState;
        const stepState = execState?.steps[stepIndex];

        const content = [
            `# 步骤详情: ${step.id}`,
            ``,
            `**Action**: \`${step.action}\``,
            `**Description**: ${step.description || '无描述'}`,
            ``,
            `## 参数`,
            `\`\`\`json`,
            JSON.stringify(step, null, 2),
            `\`\`\``,
        ];

        if (stepState) {
            content.push(``, `## 执行状态`, ``);
            content.push(`**Status**: ${stepState.status}`);
            content.push(`**Retry Count**: ${stepState.retryCount}`);
            if (stepState.startedAt) content.push(`**Started**: ${stepState.startedAt}`);
            if (stepState.completedAt) content.push(`**Completed**: ${stepState.completedAt}`);
            if (stepState.output) content.push(``, `## 输出`, `\`\`\`\n${stepState.output}\n\`\`\``);
            if (stepState.error) content.push(``, `## 错误`, `\`\`\`\n${stepState.error}\n\`\`\``);
        }

        const doc = await vscode.workspace.openTextDocument({
            content: content.join('\n'),
            language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
    }

    /**
     * Handle "Generate Chain" from natural language input.
     */
    private async handleGenerateChain(text: string): Promise<void> {
        if (!text || text.trim().length === 0) {
            vscode.window.showWarningMessage('请输入任务描述');
            return;
        }

        try {
            await vscode.commands.executeCommand('ama.generateTaskChain', text.trim());
        } catch (err: any) {
            vscode.window.showErrorMessage(`生成任务链失败: ${err.message}`);
        }
    }

    /**
     * Handle "Refresh CLINE Status" request.
     */
    private async handleRefreshClineStatus(): Promise<void> {
        await this.fetchAndPushClineStatus();
    }

    /**
     * Start periodic CLINE status polling.
     */
    private startClineStatusPolling(): void {
        this.stopClineStatusPolling();
        // Poll every 2 seconds for real-time status updates
        this._clineStatusTimer = setInterval(async () => {
            await this.fetchAndPushClineStatus();
        }, 2000);
        // Also fetch immediately
        this.fetchAndPushClineStatus();
    }

    /**
     * Stop CLINE status polling.
     */
    private stopClineStatusPolling(): void {
        if (this._clineStatusTimer) {
            clearInterval(this._clineStatusTimer);
            this._clineStatusTimer = null;
        }
    }

    /**
     * Fetch CLINE status from ClineClient and push to webview.
     */
    private async fetchAndPushClineStatus(): Promise<void> {
        if (!this._view) return;

        try {
            const clineClient = ClineClient.getInstance();
            const status = await clineClient.getStatus();
            this._lastClineStatus = status;

            this._view.webview.postMessage({
                command: 'clineStatus',
                status: {
                    connected: clineClient.isConnected,
                    version: status.version,
                    uptime: status.uptime,
                    currentTask: status.currentTask,
                    taskQueue: status.taskQueue,
                    memoryUsage: status.memoryUsage,
                },
            });
        } catch {
            // If fetch fails, push disconnected status
            this._view.webview.postMessage({
                command: 'clineStatus',
                status: {
                    connected: false,
                    version: undefined,
                    uptime: undefined,
                    currentTask: undefined,
                    taskQueue: undefined,
                    memoryUsage: undefined,
                },
            });
        }
    }

    /**
     * Generate the HTML content for the task chain webview.
     */
    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AMA 任务链</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-editor-font-family, 'Segoe UI', sans-serif);
            font-size: var(--vscode-editor-font-size, 13px);
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            padding: 8px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* ===== CLINE Worker Status Area ===== */
        .cline-status-bar {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            margin-bottom: 8px;
            background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            font-size: 11px;
            flex-shrink: 0;
        }
        .cline-status-header {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: bold;
            font-size: 12px;
        }
        .cline-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .cline-status-dot.online { background: #73c991; box-shadow: 0 0 4px #73c991; }
        .cline-status-dot.offline { background: #f48771; }
        .cline-status-dot.busy { background: #cca700; box-shadow: 0 0 4px #cca700; }
        .cline-status-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 2px 0;
        }
        .cline-status-label { color: var(--vscode-descriptionForeground, #8b8b8b); }
        .cline-status-value { color: var(--vscode-editor-foreground, #d4d4d4); }
        .cline-status-refresh {
            cursor: pointer;
            opacity: 0.6;
            font-size: 12px;
        }
        .cline-status-refresh:hover { opacity: 1; }

        /* ===== Natural Language Input Area ===== */
        .nl-input-area {
            display: flex;
            gap: 4px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            margin-bottom: 8px;
            flex-shrink: 0;
        }
        .nl-input-area input {
            flex: 1;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #d4d4d4);
            border: 1px solid var(--vscode-input-border, #555);
            padding: 4px 8px;
            font-size: 12px;
            border-radius: 2px;
            outline: none;
            min-width: 0;
        }
        .nl-input-area input:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
        }
        .nl-input-area input::placeholder {
            color: var(--vscode-input-placeholderForeground, #8b8b8b);
        }
        .nl-input-area button {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 12px;
            border-radius: 2px;
            white-space: nowrap;
        }
        .nl-input-area button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        .nl-input-area button:disabled { opacity: 0.5; cursor: not-allowed; }

        /* ===== Toolbar ===== */
        .toolbar {
            display: flex;
            gap: 6px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            margin-bottom: 8px;
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        .toolbar button {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 12px;
            border-radius: 2px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        .toolbar button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); }
        .toolbar button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
        .toolbar button.danger { background: #c73e3e; }
        .toolbar button.danger:hover { background: #e05050; }
        .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
        .toolbar .spacer { flex: 1; }

        /* ===== Chain Container ===== */
        .chain-container {
            flex: 1;
            overflow-y: auto;
        }
        .empty-state {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
        }
        .step-card {
            background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 4px;
            padding: 8px 10px;
            margin-bottom: 6px;
            cursor: pointer;
            transition: border-color 0.2s;
        }
        .step-card:hover { border-color: var(--vscode-focusBorder, #007fd4); }
        .step-card .step-header {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .step-card .step-index {
            background: var(--vscode-badge-background, #4d4d4d);
            color: var(--vscode-badge-foreground, #ffffff);
            border-radius: 50%;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
            flex-shrink: 0;
        }
        .step-card .step-info { flex: 1; min-width: 0; }
        .step-card .step-action {
            font-weight: bold;
            font-size: 12px;
        }
        .step-card .step-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .step-card .step-status {
            font-size: 16px;
            flex-shrink: 0;
        }
        .step-card .step-detail {
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
            font-size: 11px;
            display: none;
        }
        .step-card .step-detail.visible { display: block; }
        .step-card .step-detail pre {
            background: var(--vscode-textCodeBlock-background, #1e1e1e);
            padding: 4px;
            border-radius: 2px;
            overflow-x: auto;
            font-size: 10px;
            margin-top: 4px;
        }
        .step-card.status-pending { border-left: 3px solid #6a6a6a; }
        .step-card.status-running { border-left: 3px solid #4ec9b0; }
        .step-card.status-success { border-left: 3px solid #73c991; }
        .step-card.status-failed { border-left: 3px solid #f48771; }
        .step-card.status-skipped { border-left: 3px solid #6a6a6a; opacity: 0.6; }

        /* ===== Summary Bar ===== */
        .summary-bar {
            padding: 8px 0;
            border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
            margin-top: 8px;
            flex-shrink: 0;
            font-size: 11px;
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
        .summary-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .summary-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .summary-dot.success { background: #73c991; }
        .summary-dot.failed { background: #f48771; }
        .summary-dot.running { background: #4ec9b0; }
        .summary-dot.pending { background: #6a6a6a; }
        .summary-dot.skipped { background: #6a6a6a; opacity: 0.5; }

        /* ===== Log Summary ===== */
        .log-summary {
            padding: 6px 8px;
            margin-top: 4px;
            background: var(--vscode-textCodeBlock-background, #1e1e1e);
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            max-height: 60px;
            overflow-y: auto;
            line-height: 1.4;
            flex-shrink: 0;
        }
        .log-summary .log-line { opacity: 0.8; }
        .log-summary .log-line.error { color: #f48771; opacity: 1; }
        .log-summary .log-line.success { color: #73c991; opacity: 1; }
        .log-summary .log-line.warn { color: #cca700; opacity: 1; }
    </style>
</head>
<body>
    <!-- ===== CLINE Worker Status Area ===== -->
    <div class="cline-status-bar" id="clineStatusBar">
        <div class="cline-status-header">
            <span class="cline-status-dot offline" id="clineStatusDot"></span>
            <span id="clineStatusLabel">CLINE Worker: 未连接</span>
            <span class="cline-status-refresh" id="clineRefreshBtn" title="刷新状态">🔄</span>
        </div>
        <div class="cline-status-row">
            <span class="cline-status-label">当前任务:</span>
            <span class="cline-status-value" id="clineCurrentTask">-</span>
        </div>
        <div class="cline-status-row">
            <span class="cline-status-label">任务队列:</span>
            <span class="cline-status-value" id="clineTaskQueue">-</span>
        </div>
        <div class="cline-status-row">
            <span class="cline-status-label">版本:</span>
            <span class="cline-status-value" id="clineVersion">-</span>
        </div>
    </div>

    <!-- ===== Natural Language Input Area ===== -->
    <div class="nl-input-area">
        <input type="text" id="nlInput" placeholder="用自然语言描述任务链，例如：拉取最新代码，构建前端，然后部署到 Render" />
        <button id="generateBtn" onclick="generateChain()">🧠 生成任务链</button>
    </div>

    <!-- ===== Toolbar ===== -->
    <div class="toolbar">
        <button id="executeBtn" onclick="executeChain()">▶ 执行任务链</button>
        <button class="danger" id="abortBtn" onclick="abortExecution()" disabled>⏹ 中止</button>
        <button class="secondary" onclick="clearChain()">🗑 清空</button>
        <span class="spacer"></span>
    </div>

    <!-- ===== Chain Container ===== -->
    <div class="chain-container" id="chainContainer">
        <div class="empty-state">暂无任务链<br>请在输入框中描述任务，点击"生成任务链"创建</div>
    </div>

    <!-- ===== Log Summary ===== -->
    <div class="log-summary" id="logSummary" style="display:none;">
        <div class="log-line">等待执行日志...</div>
    </div>

    <!-- ===== Summary Bar ===== -->
    <div class="summary-bar" id="summaryBar" style="display:none;">
        <span class="summary-item"><span class="summary-dot success"></span> <span id="successCount">0</span></span>
        <span class="summary-item"><span class="summary-dot failed"></span> <span id="failedCount">0</span></span>
        <span class="summary-item"><span class="summary-dot running"></span> <span id="runningCount">0</span></span>
        <span class="summary-item"><span class="summary-dot pending"></span> <span id="pendingCount">0</span></span>
        <span class="summary-item"><span class="summary-dot skipped"></span> <span id="skippedCount">0</span></span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chainContainer = document.getElementById('chainContainer');
        const executeBtn = document.getElementById('executeBtn');
        const abortBtn = document.getElementById('abortBtn');
        const summaryBar = document.getElementById('summaryBar');
        const logSummary = document.getElementById('logSummary');
        const nlInput = document.getElementById('nlInput');
        const generateBtn = document.getElementById('generateBtn');

        // ===== Button Handlers =====
        function executeChain() { vscode.postMessage({ command: 'executeChain' }); }
        function abortExecution() { vscode.postMessage({ command: 'abortExecution' }); }
        function clearChain() { vscode.postMessage({ command: 'clearChain' }); }

        function generateChain() {
            const text = nlInput.value.trim();
            if (!text) {
                nlInput.focus();
                nlInput.style.borderColor = '#f48771';
                setTimeout(() => { nlInput.style.borderColor = ''; }, 1500);
                return;
            }
            generateBtn.disabled = true;
            generateBtn.textContent = '⏳ 生成中...';
            vscode.postMessage({ command: 'generateChain', text: text });
        }

        // Allow Enter key to trigger generation
        nlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                generateChain();
            }
        });

        // Refresh CLINE status
        document.getElementById('clineRefreshBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refreshClineStatus' });
        });

        // ===== Status Icons =====
        function getStatusIcon(status) {
            switch (status) {
                case 'pending': return '⏳';
                case 'running': return '🔄';
                case 'success': return '✅';
                case 'failed': return '❌';
                case 'skipped': return '⏭️';
                default: return '❓';
            }
        }

        // ===== Render Chain =====
        function renderChain(chain, execState, isRunning) {
            chainContainer.innerHTML = '';

            if (!chain || chain.length === 0) {
                chainContainer.innerHTML = '<div class="empty-state">暂无任务链<br>请在输入框中描述任务，点击"生成任务链"创建</div>';
                summaryBar.style.display = 'none';
                logSummary.style.display = 'none';
                executeBtn.disabled = true;
                abortBtn.disabled = true;
                return;
            }

            executeBtn.disabled = isRunning;
            abortBtn.disabled = !isRunning;

            let successCount = 0, failedCount = 0, runningCount = 0, pendingCount = 0, skippedCount = 0;
            let logLines = [];

            chain.forEach((step, index) => {
                let status = 'pending';
                if (execState && execState.steps && execState.steps[index]) {
                    status = execState.steps[index].status;
                }

                switch (status) {
                    case 'success': successCount++; break;
                    case 'failed': failedCount++; break;
                    case 'running': runningCount++; break;
                    case 'skipped': skippedCount++; break;
                    default: pendingCount++;
                }

                // Collect log lines
                if (execState && execState.steps && execState.steps[index]) {
                    const stepState = execState.steps[index];
                    if (stepState.output) {
                        logLines.push({ text: stepState.output.substring(0, 100), level: 'info' });
                    }
                    if (stepState.error) {
                        logLines.push({ text: '❌ ' + stepState.error.substring(0, 100), level: 'error' });
                    }
                }

                const card = document.createElement('div');
                card.className = 'step-card status-' + status;
                card.onclick = () => vscode.postMessage({ command: 'viewStepDetail', stepIndex: index });

                card.innerHTML = \`
                    <div class="step-header">
                        <span class="step-index">\${index + 1}</span>
                        <div class="step-info">
                            <div class="step-action">\${escapeHtml(step.action)}</div>
                            <div class="step-desc">\${escapeHtml(step.description || '')}</div>
                        </div>
                        <span class="step-status">\${getStatusIcon(status)}</span>
                    </div>
                \`;

                chainContainer.appendChild(card);
            });

            // Update summary
            document.getElementById('successCount').textContent = successCount;
            document.getElementById('failedCount').textContent = failedCount;
            document.getElementById('runningCount').textContent = runningCount;
            document.getElementById('pendingCount').textContent = pendingCount;
            document.getElementById('skippedCount').textContent = skippedCount;
            summaryBar.style.display = 'flex';

            // Update log summary
            if (logLines.length > 0) {
                logSummary.style.display = 'block';
                logSummary.innerHTML = logLines.slice(-5).map(l =>
                    \`<div class="log-line \${l.level}">\${escapeHtml(l.text)}</div>\`
                ).join('');
            } else if (isRunning) {
                logSummary.style.display = 'block';
                logSummary.innerHTML = '<div class="log-line">⏳ 任务链执行中...</div>';
            } else {
                logSummary.style.display = 'none';
            }
        }

        // ===== CLINE Status Update =====
        function updateClineStatus(status) {
            const dot = document.getElementById('clineStatusDot');
            const label = document.getElementById('clineStatusLabel');
            const currentTask = document.getElementById('clineCurrentTask');
            const taskQueue = document.getElementById('clineTaskQueue');
            const version = document.getElementById('clineVersion');

            if (status.connected) {
                if (status.currentTask) {
                    dot.className = 'cline-status-dot busy';
                    label.textContent = 'CLINE Worker: 忙碌中';
                } else {
                    dot.className = 'cline-status-dot online';
                    label.textContent = 'CLINE Worker: 在线';
                }
            } else {
                dot.className = 'cline-status-dot offline';
                label.textContent = 'CLINE Worker: 未连接';
            }

            currentTask.textContent = status.currentTask || '-';
            taskQueue.textContent = status.taskQueue !== undefined ? String(status.taskQueue) : '-';
            version.textContent = status.version || '-';
        }

        // ===== Utility =====
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ===== Handle Messages from Extension =====
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'setChain':
                    renderChain(message.chain, message.executionState, message.isRunning);
                    // Re-enable generate button if it was disabled
                    generateBtn.disabled = false;
                    generateBtn.textContent = '🧠 生成任务链';
                    break;
                case 'updateExecutionState':
                    const currentChain = message.executionState?.chain;
                    if (currentChain) {
                        renderChain(currentChain, message.executionState, message.isRunning);
                    }
                    break;
                case 'executionEvent':
                    // Update log summary on events
                    if (message.event && message.event.message) {
                        const logSummary = document.getElementById('logSummary');
                        logSummary.style.display = 'block';
                        const logLine = document.createElement('div');
                        logLine.className = 'log-line';
                        if (message.event.type === 'stepFailed' || message.event.type === 'error') {
                            logLine.className = 'log-line error';
                        } else if (message.event.type === 'stepCompleted' || message.event.type === 'completed') {
                            logLine.className = 'log-line success';
                        }
                        logLine.textContent = message.event.message;
                        logSummary.appendChild(logLine);
                        logSummary.scrollTop = logSummary.scrollHeight;
                        // Keep only last 10 lines
                        while (logSummary.children.length > 10) {
                            logSummary.removeChild(logSummary.firstChild);
                        }
                    }
                    break;
                case 'clineStatus':
                    updateClineStatus(message.status);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
