import * as vscode from 'vscode';
import { ClineService, LogEntry } from '../services/ClineService';

/**
 * Webview provider for the AMA logs view.
 * Displays real-time log output from CLINE and polling status.
 */
export class LogWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'amaLogsView';

    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
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
                    case 'refresh':
                        this.refreshLogs();
                        break;
                    case 'clear':
                        this.clearLogs();
                        break;
                }
            })
        );

        const service = ClineService.getInstance();

        // Listen for new log entries from the service
        this._disposables.push(
            service.onLogReceived((entry) => {
                this.appendLogEntry(entry);
            })
        );

        // Listen for polling state changes to update the status indicator
        this._disposables.push(
            service.onPollingChanged((isPolling) => {
                this.updatePollingStatus(isPolling);
            })
        );

        // Listen for connection state changes
        this._disposables.push(
            service.onConnectionChanged((isConnected) => {
                this.updateConnectionStatus(isConnected);
            })
        );

        // Load existing logs
        this.refreshLogs();

        // Send initial polling and connection status
        this.updatePollingStatus(service.isPolling);
        this.updateConnectionStatus(service.isConnected);

        // Clean up disposables when the view is disposed
        webviewView.onDidDispose(() => {
            this._disposables.forEach(d => d.dispose());
            this._disposables = [];
        });
    }

    /**
     * Send all existing logs to the webview.
     */
    private refreshLogs(): void {
        if (!this._view) return;
        const service = ClineService.getInstance();
        const logs = service.logs;
        this._view.webview.postMessage({
            command: 'setLogs',
            logs,
        });
    }

    /**
     * Append a single log entry to the webview.
     */
    private appendLogEntry(entry: LogEntry): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'appendLog',
            entry,
        });
    }

    /**
     * Update the polling status indicator in the webview.
     */
    private updatePollingStatus(isPolling: boolean): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'setPollingStatus',
            isPolling,
        });
    }

    /**
     * Update the connection status indicator in the webview.
     */
    private updateConnectionStatus(isConnected: boolean): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            command: 'setConnectionStatus',
            isConnected,
        });
    }

    /**
     * Clear all logs.
     */
    private clearLogs(): void {
        const service = ClineService.getInstance();
        service.clearLogs();
        if (this._view) {
            this._view.webview.postMessage({
                command: 'clearLogs',
            });
        }
    }

    /**
     * Generate the HTML content for the log webview.
     */
    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AMA 日志</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            padding: 8px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
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
        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .toolbar button.secondary {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
        }
        .toolbar button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .status-bar {
            display: flex;
            gap: 8px;
            padding: 4px 0;
            margin-bottom: 4px;
            flex-shrink: 0;
            font-size: 11px;
        }
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            border-radius: 3px;
            background: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .status-dot.active {
            background-color: #4ec9b0;
            box-shadow: 0 0 4px #4ec9b0;
        }
        .status-dot.inactive {
            background-color: #6a6a6a;
        }
        .status-dot.connected {
            background-color: #73c991;
        }
        .status-dot.disconnected {
            background-color: #f48771;
        }
        .status-label {
            color: var(--vscode-descriptionForeground, #8b8b8b);
        }
        .log-container {
            flex: 1;
            overflow-y: auto;
            padding: 4px 0;
        }
        .log-entry {
            padding: 2px 4px;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            line-height: 1.5;
            word-break: break-all;
        }
        .log-entry:hover {
            background-color: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .log-timestamp {
            color: var(--vscode-textCodeBlock-background, #6a9955);
            margin-right: 8px;
            user-select: none;
        }
        .log-level-info {
            color: var(--vscode-editor-foreground, #d4d4d4);
        }
        .log-level-warn {
            color: var(--vscode-editorWarning-foreground, #cca700);
        }
        .log-level-error {
            color: var(--vscode-errorForeground, #f48771);
        }
        .log-level-success {
            color: var(--vscode-testing-iconPassed, #73c991);
        }
        .log-empty {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
        }
        .log-count {
            color: var(--vscode-descriptionForeground, #8b8b8b);
            font-size: 11px;
            margin-left: auto;
            align-self: center;
        }
    </style>
</head>
<body>
    <div class="status-bar">
        <span class="status-indicator" id="pollingStatus">
            <span class="status-dot inactive" id="pollingDot"></span>
            <span class="status-label" id="pollingLabel">Polling: inactive</span>
        </span>
        <span class="status-indicator" id="connectionStatus">
            <span class="status-dot disconnected" id="connectionDot"></span>
            <span class="status-label" id="connectionLabel">Connection: disconnected</span>
        </span>
    </div>
    <div class="toolbar">
        <button onclick="refreshLogs()" title="刷新日志">🔄 刷新</button>
        <button class="secondary" onclick="clearLogs()" title="清空日志">🗑️ 清空</button>
        <span class="log-count" id="logCount">共 0 条日志</span>
    </div>
    <div class="log-container" id="logContainer">
        <div class="log-empty">暂无日志，请点击 "Connect to CLINE" 开始连接</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const logContainer = document.getElementById('logContainer');
        const logCount = document.getElementById('logCount');
        const pollingDot = document.getElementById('pollingDot');
        const pollingLabel = document.getElementById('pollingLabel');
        const connectionDot = document.getElementById('connectionDot');
        const connectionLabel = document.getElementById('connectionLabel');

        function refreshLogs() {
            vscode.postMessage({ command: 'refresh' });
        }

        function clearLogs() {
            vscode.postMessage({ command: 'clear' });
        }

        function getLevelClass(level) {
            switch (level) {
                case 'info': return 'log-level-info';
                case 'warn': return 'log-level-warn';
                case 'error': return 'log-level-error';
                case 'success': return 'log-level-success';
                default: return 'log-level-info';
            }
        }

        function getLevelIcon(level) {
            switch (level) {
                case 'info': return 'ℹ️';
                case 'warn': return '⚠️';
                case 'error': return '❌';
                case 'success': return '✅';
                default: return '•';
            }
        }

        function createLogEntryElement(entry) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`
                <span class="log-timestamp">[\${entry.timestamp}]</span>
                <span class="\${getLevelClass(entry.level)}">\${getLevelIcon(entry.level)} \${escapeHtml(entry.message)}</span>
            \`;
            return div;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateLogCount() {
            const count = logContainer.querySelectorAll('.log-entry').length;
            logCount.textContent = \`共 \${count} 条日志\`;
        }

        function appendLog(entry) {
            // Remove empty state if present
            const emptyState = logContainer.querySelector('.log-empty');
            if (emptyState) {
                emptyState.remove();
            }
            logContainer.appendChild(createLogEntryElement(entry));
            logContainer.scrollTop = logContainer.scrollHeight;
            updateLogCount();
        }

        function setLogs(logs) {
            logContainer.innerHTML = '';
            if (!logs || logs.length === 0) {
                logContainer.innerHTML = '<div class="log-empty">暂无日志</div>';
                updateLogCount();
                return;
            }
            logs.forEach(entry => {
                logContainer.appendChild(createLogEntryElement(entry));
            });
            logContainer.scrollTop = logContainer.scrollHeight;
            updateLogCount();
        }

        function setPollingStatus(isPolling) {
            if (isPolling) {
                pollingDot.className = 'status-dot active';
                pollingLabel.textContent = 'Polling: active';
            } else {
                pollingDot.className = 'status-dot inactive';
                pollingLabel.textContent = 'Polling: inactive';
            }
        }

        function setConnectionStatus(isConnected) {
            if (isConnected) {
                connectionDot.className = 'status-dot connected';
                connectionLabel.textContent = 'Connection: connected';
            } else {
                connectionDot.className = 'status-dot disconnected';
                connectionLabel.textContent = 'Connection: disconnected';
            }
        }

        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'setLogs':
                    setLogs(message.logs);
                    break;
                case 'appendLog':
                    appendLog(message.entry);
                    break;
                case 'clearLogs':
                    logContainer.innerHTML = '<div class="log-empty">日志已清空</div>';
                    updateLogCount();
                    break;
                case 'setPollingStatus':
                    setPollingStatus(message.isPolling);
                    break;
                case 'setConnectionStatus':
                    setConnectionStatus(message.isConnected);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
