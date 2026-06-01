import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface AMAConfig {
    githubToken: string;
    repo: string;
    label: string;
    pollIntervalSeconds: number;
    tasksDir: string;
}

export class ConfigManager {
    private static instance: ConfigManager;
    private config: AMAConfig | null = null;

    private constructor() {}

    static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    /**
     * Load config from the workspace config.json file.
     */
    loadFromFile(): AMAConfig | null {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return null;
            }
            const configPath = path.join(workspaceFolders[0].uri.fsPath, 'config.json');
            if (!fs.existsSync(configPath)) {
                return null;
            }
            const raw = fs.readFileSync(configPath, 'utf-8');
            const json = JSON.parse(raw);
            this.config = {
                githubToken: json.github_token || '',
                repo: json.repo || '',
                label: json.label || 'cline',
                pollIntervalSeconds: json.poll_interval_seconds || 20,
                tasksDir: json.tasks_dir || 'tasks',
            };
            return this.config;
        } catch (err) {
            console.error('Failed to load config.json:', err);
            return null;
        }
    }

    /**
     * Load config from VS Code settings (with fallback to config.json).
     */
    getConfig(): AMAConfig {
        if (this.config) {
            return this.config;
        }

        const vsConfig = vscode.workspace.getConfiguration('ama');
        this.config = {
            githubToken: vsConfig.get<string>('githubToken', ''),
            repo: vsConfig.get<string>('repo', ''),
            label: vsConfig.get<string>('label', 'cline'),
            pollIntervalSeconds: vsConfig.get<number>('pollIntervalSeconds', 20),
            tasksDir: vsConfig.get<string>('tasksDir', 'tasks'),
        };

        // Fallback: try loading from config.json if VS Code settings are empty
        if (!this.config.githubToken || !this.config.repo) {
            const fileConfig = this.loadFromFile();
            if (fileConfig) {
                this.config = fileConfig;
            }
        }

        return this.config;
    }

    /**
     * Get the absolute path to the tasks directory.
     */
    getTasksDir(): string {
        const config = this.getConfig();
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return config.tasksDir;
        }
        return path.join(workspaceFolders[0].uri.fsPath, config.tasksDir);
    }
}
