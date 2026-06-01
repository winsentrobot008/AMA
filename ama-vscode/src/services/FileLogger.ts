import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * FileLogger — 本地文件日志工具
 * 
 * 提供直接写入 logs/cline.log、state/ama_state.json、state/project_files.json 的能力。
 * 每个文件独立使用，不依赖其他服务。
 */

// ============================================================
// 获取工作区根目录
// ============================================================

function getWorkspaceRoot(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        return workspaceFolders[0].uri.fsPath;
    }
    return '';
}

// ============================================================
// A. 日志写入 logs/cline.log
// ============================================================

/**
 * 获取 logs/cline.log 的绝对路径。
 */
function getClineLogPath(): string {
    const root = getWorkspaceRoot();
    if (!root) return '';
    const logDir = path.join(root, 'logs');
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    } catch {}
    return path.join(logDir, 'cline.log');
}

/**
 * 追加一条 JSON 日志到 logs/cline.log。
 * 
 * @param data - 要写入的日志数据对象，会自动添加 timestamp
 */
export function appendClineLog(data: any): void {
    const logPath = getClineLogPath();
    if (!logPath) return;

    try {
        const entry = {
            timestamp: new Date().toISOString(),
            ...data,
        };
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {}
}

// ============================================================
// B. 状态文件 state/ama_state.json
// ============================================================

/**
 * AMA 状态接口。
 */
export interface AMAStateFile {
    timestamp: string;
    clineConnected: boolean;
    mcpConnected: boolean;
    polling: boolean;
    currentTaskChain: any[];
    currentStep: string;
    lastError: string | null;
}

/**
 * 获取 state/ama_state.json 的绝对路径。
 */
function getAmaStatePath(): string {
    const root = getWorkspaceRoot();
    if (!root) return '';
    const stateDir = path.join(root, 'state');
    try {
        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
        }
    } catch {}
    return path.join(stateDir, 'ama_state.json');
}

/**
 * 读取当前 ama_state.json 内容。
 */
function readAmaState(): AMAStateFile {
    const statePath = getAmaStatePath();
    if (!statePath) {
        return {
            timestamp: new Date().toISOString(),
            clineConnected: false,
            mcpConnected: false,
            polling: false,
            currentTaskChain: [],
            currentStep: '',
            lastError: null,
        };
    }

    try {
        if (fs.existsSync(statePath)) {
            const raw = fs.readFileSync(statePath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch {}

    return {
        timestamp: new Date().toISOString(),
        clineConnected: false,
        mcpConnected: false,
        polling: false,
        currentTaskChain: [],
        currentStep: '',
        lastError: null,
    };
}

/**
 * 更新 ama_state.json 中的部分字段。
 * 
 * @param partial - 要更新的字段
 */
export function updateAmaState(partial: Partial<AMAStateFile>): void {
    const statePath = getAmaStatePath();
    if (!statePath) return;

    try {
        const current = readAmaState();
        const updated: AMAStateFile = {
            ...current,
            ...partial,
            timestamp: new Date().toISOString(),
        };
        fs.writeFileSync(statePath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch {}
}

// ============================================================
// C. 项目文件结构 state/project_files.json
// ============================================================

/**
 * 获取 state/project_files.json 的绝对路径。
 */
function getProjectFilesPath(): string {
    const root = getWorkspaceRoot();
    if (!root) return '';
    const stateDir = path.join(root, 'state');
    try {
        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
        }
    } catch {}
    return path.join(stateDir, 'project_files.json');
}

/**
 * 递归扫描目录，返回所有文件路径（相对于工作区根目录）。
 * 跳过 node_modules, .git, out, logs, state 目录。
 */
function scanDirectory(dirPath: string, relativePath: string = ''): string[] {
    const files: string[] = [];

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' ||
                entry.name === 'out' || entry.name === 'logs' ||
                entry.name === 'state') {
                continue;
            }

            const fullPath = path.join(dirPath, entry.name);
            const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                files.push(...scanDirectory(fullPath, relPath));
            } else if (entry.isFile()) {
                files.push(relPath);
            }
        }
    } catch {}

    return files;
}

/**
 * 扫描整个项目目录并写入 state/project_files.json。
 */
export function scanAndWriteProjectFiles(): void {
    const filePath = getProjectFilesPath();
    const root = getWorkspaceRoot();
    if (!filePath || !root) return;

    try {
        const files = scanDirectory(root);
        const projectFiles = {
            timestamp: new Date().toISOString(),
            files,
        };
        fs.writeFileSync(filePath, JSON.stringify(projectFiles, null, 2), 'utf-8');
    } catch {}
}

// ============================================================
// D. 文件内容导出 state/file_content.json
// ============================================================

/**
 * 获取 state/file_content.json 的绝对路径。
 */
function getFileContentPath(): string {
    const root = getWorkspaceRoot();
    if (!root) return '';
    const stateDir = path.join(root, 'state');
    try {
        if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
        }
    } catch {}
    return path.join(stateDir, 'file_content.json');
}

/**
 * 读取指定文件的内容并写入 state/file_content.json。
 * 
 * @param relativePath - 相对于工作区根目录的文件路径
 */
export function exportFileContent(relativePath: string): void {
    const root = getWorkspaceRoot();
    const filePath = getFileContentPath();
    if (!root || !filePath) return;

    try {
        const absolutePath = path.join(root, relativePath);
        if (!fs.existsSync(absolutePath)) {
            const result = {
                path: relativePath,
                content: null,
                error: `文件不存在: ${relativePath}`,
            };
            fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
            return;
        }

        const content = fs.readFileSync(absolutePath, 'utf-8');
        const result = {
            path: relativePath,
            content,
        };
        fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (err: any) {
        const result = {
            path: relativePath,
            content: null,
            error: err.message,
        };
        try {
            fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
        } catch {}
    }
}
