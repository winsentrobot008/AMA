import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config/ConfigManager';
import { ClineService } from '../services/ClineService';

/**
 * Represents a single task item in the tree view.
 */
export class TaskItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly taskStatus: string,
        public readonly taskTime: string,
        public readonly filePath: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);

        this.description = `${taskStatus} | ${taskTime}`;
        this.tooltip = `${label}\n状态: ${taskStatus}\n时间: ${taskTime}\n路径: ${filePath}`;

        // Set icon based on status
        switch (taskStatus.toLowerCase()) {
            case 'completed':
            case 'done':
            case 'success':
                this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'running':
            case 'in_progress':
            case 'processing':
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                break;
            case 'failed':
            case 'error':
                this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                break;
            case 'pending':
            case 'queued':
            default:
                this.iconPath = new vscode.ThemeIcon('circle-outline');
                break;
        }

        // Command to run when clicking the task
        this.command = {
            command: 'ama.runTask',
            title: '执行任务',
            arguments: [this],
        };
    }
}

/**
 * TreeDataProvider for the AMA tasks list view.
 * Reads tasks from the configured tasks_dir and displays them.
 */
export class TaskTreeDataProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TaskItem | undefined | null | void> = new vscode.EventEmitter<TaskItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TaskItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tasksDir: string = '';

    constructor() {
        this.refreshTasksDir();
    }

    /**
     * Refresh the tasks directory path from config.
     */
    refreshTasksDir(): void {
        this.tasksDir = ConfigManager.getInstance().getTasksDir();
    }

    /**
     * Refresh the tree view.
     */
    refresh(): void {
        this.refreshTasksDir();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get the current list of task items (synchronous, reads from disk).
     * Used by the orchestration loop to get task state.
     */
    getCurrentTasks(): TaskItem[] {
        const items: TaskItem[] = [];
        try {
            if (!fs.existsSync(this.tasksDir)) {
                return items;
            }
            const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json') || entry.name.endsWith('.txt'))) {
                    const fullPath = path.join(this.tasksDir, entry.name);
                    const { status, time } = this.parseTaskFile(fullPath, entry.name);
                    items.push(new TaskItem(
                        entry.name,
                        status,
                        time,
                        fullPath,
                        vscode.TreeItemCollapsibleState.None
                    ));
                }
            }
            items.sort((a, b) => a.label.localeCompare(b.label));
        } catch (err) {
            console.error('Error reading tasks directory:', err);
        }
        return items;
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {

        return element;
    }

    getChildren(element?: TaskItem): Thenable<TaskItem[]> {
        if (element) {
            // If the element is a directory, list its contents
            return this.getTaskFiles(element.filePath);
        }
        // Root level: list task files from the tasks directory
        return this.getTaskFiles(this.tasksDir);
    }

    /**
     * Read task files from the given directory and create TaskItems.
     */
    private async getTaskFiles(dirPath: string): Promise<TaskItem[]> {
        const items: TaskItem[] = [];

        try {
            if (!fs.existsSync(dirPath)) {
                return [new TaskItem(
                    '⚠️ 任务目录不存在',
                    'error',
                    '',
                    dirPath,
                    vscode.TreeItemCollapsibleState.None
                )];
            }

            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    // Directory: show as collapsible
                    items.push(new TaskItem(
                        `📁 ${entry.name}`,
                        'directory',
                        '',
                        fullPath,
                        vscode.TreeItemCollapsibleState.Collapsed
                    ));
                } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json') || entry.name.endsWith('.txt'))) {
                    // Task file: parse status and time from content
                    const { status, time } = this.parseTaskFile(fullPath, entry.name);
                    items.push(new TaskItem(
                        entry.name,
                        status,
                        time,
                        fullPath,
                        vscode.TreeItemCollapsibleState.None
                    ));
                }
            }

            // Sort: directories first, then by name
            items.sort((a, b) => {
                const aIsDir = a.collapsibleState !== vscode.TreeItemCollapsibleState.None ? 0 : 1;
                const bIsDir = b.collapsibleState !== vscode.TreeItemCollapsibleState.None ? 0 : 1;
                if (aIsDir !== bIsDir) return aIsDir - bIsDir;
                return a.label.localeCompare(b.label);
            });

        } catch (err) {
            console.error('Error reading tasks directory:', err);
            items.push(new TaskItem(
                '❌ 读取任务目录失败',
                'error',
                '',
                dirPath,
                vscode.TreeItemCollapsibleState.None
            ));
        }

        if (items.length === 0) {
            items.push(new TaskItem(
                '📭 暂无任务',
                'empty',
                '',
                dirPath,
                vscode.TreeItemCollapsibleState.None
            ));
        }

        return items;
    }

    /**
     * Parse a task file to extract status and time information.
     */
    private parseTaskFile(filePath: string, fileName: string): { status: string; time: string } {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').slice(0, 20); // Read first 20 lines

            let status = 'pending';
            let time = '';

            for (const line of lines) {
                // Look for status markers
                const statusMatch = line.match(/status[:\s]+(.+)/i);
                if (statusMatch) {
                    status = statusMatch[1].trim().toLowerCase();
                }

                // Look for time/date markers
                const timeMatch = line.match(/(?:time|date|created|updated)[:\s]+(.+)/i);
                if (timeMatch) {
                    time = timeMatch[1].trim();
                }
            }

            // If no time found, use file modification time
            if (!time) {
                const stats = fs.statSync(filePath);
                time = stats.mtime.toLocaleString('zh-CN');
            }

            return { status, time };
        } catch {
            return { status: 'unknown', time: '' };
        }
    }

    /**
     * Run a task item via CLINE.
     */
    async runTask(taskItem: TaskItem): Promise<void> {
        if (taskItem.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
            // It's a directory, just expand it
            return;
        }

        const service = ClineService.getInstance();

        if (!service.isConnected) {
            vscode.window.showWarningMessage('请先点击 "Connect to CLINE" 按钮连接到 CLINE');
            return;
        }

        // Read the task file content to use as description
        let taskDescription = '';
        try {
            taskDescription = fs.readFileSync(taskItem.filePath, 'utf-8');
        } catch {
            taskDescription = `执行任务: ${taskItem.label}`;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `正在执行任务: ${taskItem.label}`,
                cancellable: false,
            },
            async () => {
                const success = await service.runTask(taskItem.label, taskDescription);
                if (success) {
                    vscode.window.showInformationMessage(`任务已提交: ${taskItem.label}`);
                } else {
                    vscode.window.showErrorMessage(`任务执行失败: ${taskItem.label}`);
                }
            }
        );
    }
}
