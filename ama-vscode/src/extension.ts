import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ClineService } from './services/ClineService';
import { TaskTreeDataProvider, TaskItem } from './state/TaskTreeDataProvider';
import { LogWebviewProvider } from './panel/LogWebviewProvider';
import { TaskChainWebviewProvider } from './panel/TaskChainWebviewProvider';
import { DeepSeekClient } from './llm/DeepSeekClient';
import { ClineClient } from './cline/ClineClient';
import { TaskChainExecutor } from './executor/TaskChainExecutor';
import { TaskChain } from './types/TaskChain';
import { MonitorService } from './services/MonitorService';
import { scanAndWriteProjectFiles, exportFileContent } from './services/FileLogger';

export function activate(context: vscode.ExtensionContext) {
    console.log('AMA extension is now active!');

    // ============================================================
    // 1. Initialize services
    // ============================================================
    const configManager = ConfigManager.getInstance();
    const clineService = ClineService.getInstance();
    const deepSeekClient = DeepSeekClient.getInstance();
    const clineClient = ClineClient.getInstance();
    const taskChainExecutor = TaskChainExecutor.getInstance();
    const monitorService = MonitorService.getInstance();

    // Load config
    configManager.getConfig();

    // ============================================================
    // 2. Register views
    // ============================================================

    // 2a. Task list view (TreeDataProvider)
    const taskTreeDataProvider = new TaskTreeDataProvider();
    const treeView = vscode.window.createTreeView('amaTasksView', {
        treeDataProvider: taskTreeDataProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // 2b. Log view (WebviewProvider)
    const logWebviewProvider = new LogWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(LogWebviewProvider.viewType, logWebviewProvider)
    );

    // 2c. Task Chain view (WebviewProvider) — the AI scheduling center panel
    const taskChainWebviewProvider = new TaskChainWebviewProvider(
        context,
        taskChainExecutor,
        clineClient
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TaskChainWebviewProvider.viewType, taskChainWebviewProvider)
    );

    // ============================================================
    // 3. Status bar
    // ============================================================

    // 3a. Polling status bar item
    const pollingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    pollingStatusBarItem.text = '$(circle-slash) AMA 已停止';
    pollingStatusBarItem.tooltip = 'AMA 轮询状态';
    pollingStatusBarItem.command = 'ama.start';
    pollingStatusBarItem.show();
    context.subscriptions.push(pollingStatusBarItem);

    // Update status bar when polling state changes
    context.subscriptions.push(
        clineService.onPollingChanged((isPolling) => {
            if (isPolling) {
                pollingStatusBarItem.text = '$(sync~spin) AMA 轮询中';
                pollingStatusBarItem.tooltip = 'AMA 正在轮询 GitHub Issues... 点击停止';
                pollingStatusBarItem.command = 'ama.stop';
            } else {
                if (clineService.isConnected) {
                    pollingStatusBarItem.text = '$(circle-slash) AMA 已连接';
                    pollingStatusBarItem.tooltip = 'AMA 已连接到 GitHub。点击启动轮询';
                    pollingStatusBarItem.command = 'ama.start';
                } else {
                    pollingStatusBarItem.text = '$(circle-slash) AMA 已停止';
                    pollingStatusBarItem.tooltip = 'AMA 轮询已停止。点击启动';
                    pollingStatusBarItem.command = 'ama.start';
                }
            }
        })
    );

    // Update status bar when connection state changes
    context.subscriptions.push(
        clineService.onConnectionChanged((isConnected) => {
            if (isConnected) {
                if (!clineService.isPolling) {
                    pollingStatusBarItem.text = '$(circle-slash) AMA 已连接';
                    pollingStatusBarItem.tooltip = 'AMA 已连接到 GitHub。点击启动轮询';
                    pollingStatusBarItem.command = 'ama.start';
                }
            } else {
                pollingStatusBarItem.text = '$(circle-slash) AMA 未连接';
                pollingStatusBarItem.tooltip = 'AMA 未连接到 GitHub。点击连接';
                pollingStatusBarItem.command = 'ama.connectToCline';
            }
        })
    );

    // 3b. CLINE connection status bar item
    const clineStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    clineStatusBarItem.text = '$(plug) CLINE: 未连接';
    clineStatusBarItem.tooltip = 'CLINE MCP 连接状态';
    clineStatusBarItem.command = 'ama.connectToClineMCP';
    clineStatusBarItem.show();
    context.subscriptions.push(clineStatusBarItem);

    context.subscriptions.push(
        clineClient.onConnectionChanged((isConnected) => {
            if (isConnected) {
                clineStatusBarItem.text = '$(plug) CLINE: 已连接';
                clineStatusBarItem.tooltip = 'CLINE MCP 已连接';
                clineStatusBarItem.command = 'ama.disconnectFromClineMCP';
            } else {
                clineStatusBarItem.text = '$(plug) CLINE: 未连接';
                clineStatusBarItem.tooltip = 'CLINE MCP 未连接。点击连接';
                clineStatusBarItem.command = 'ama.connectToClineMCP';
            }
        })
    );

    // ============================================================
    // 4. Register commands
    // ============================================================

    // 4a. Connect to CLINE (GitHub)
    const connectDisposable = vscode.commands.registerCommand('ama.connectToCline', async () => {
        const success = await clineService.connect();
        if (success) {
            vscode.window.showInformationMessage('✅ 成功连接到 CLINE (GitHub)');
            taskTreeDataProvider.refresh();
        } else {
            vscode.window.showErrorMessage('❌ 连接到 CLINE 失败，请查看日志了解详情');
        }
    });

    // 4b. Connect to CLINE MCP
    const connectMCPDisposable = vscode.commands.registerCommand('ama.connectToClineMCP', async () => {
        const success = await clineClient.connect();
        if (success) {
            vscode.window.showInformationMessage('✅ 成功连接到 CLINE MCP');
        } else {
            vscode.window.showErrorMessage('❌ 连接到 CLINE MCP 失败，请检查 .env 中的 CLINE_MCP_URL');
        }
    });

    // 4c. Disconnect from CLINE MCP
    const disconnectMCPDisposable = vscode.commands.registerCommand('ama.disconnectFromClineMCP', () => {
        clineClient.disconnect();
        vscode.window.showInformationMessage('🔌 已断开 CLINE MCP 连接');
    });

    // 4d. Start polling
    const startDisposable = vscode.commands.registerCommand('ama.start', () => {
        clineService.startPolling();
    });

    // 4e. Stop polling
    const stopDisposable = vscode.commands.registerCommand('ama.stop', () => {
        clineService.stopPolling();
    });

    // 4f. Refresh task list
    const refreshDisposable = vscode.commands.registerCommand('ama.refresh', () => {
        taskTreeDataProvider.refresh();
        clineService.addLog('info', '🔄 任务列表已刷新');
    });

    // 4g. Open log panel
    const openLogDisposable = vscode.commands.registerCommand('ama.openLog', () => {
        vscode.commands.executeCommand('workbench.view.extension.ama');
        clineService.addLog('info', '📋 已打开日志面板');
    });

    // 4h. Open task file
    const openTaskFileDisposable = vscode.commands.registerCommand('ama.openTaskFile', (taskItem?: TaskItem) => {
        if (taskItem && taskItem.filePath) {
            vscode.workspace.openTextDocument(taskItem.filePath).then(doc => {
                vscode.window.showTextDocument(doc);
            });
        } else {
            vscode.window.showInformationMessage('AMA: 打开任务文件');
        }
    });

    // 4i. Run task (called when clicking a task item)
    const runTaskDisposable = vscode.commands.registerCommand('ama.runTask', async (taskItem: TaskItem) => {
        if (!taskItem) {
            vscode.window.showWarningMessage('请选择一个任务');
            return;
        }
        await taskTreeDataProvider.runTask(taskItem);
    });

    // 4j. Clear logs
    const clearLogsDisposable = vscode.commands.registerCommand('ama.clearLogs', () => {
        clineService.clearLogs();
    });

    // 4k. Export file content (for Copilot visibility)
    const exportFileContentDisposable = vscode.commands.registerCommand('ama.exportFileContent', async () => {
        const filePath = await vscode.window.showInputBox({
            prompt: '输入要导出的文件路径（相对于项目根目录）',
            placeHolder: '例如: src/extension.ts',
            ignoreFocusOut: true,
        });
        if (filePath) {
            exportFileContent(filePath);
            clineService.addLog('info', `📄 已导出文件内容: ${filePath} → state/file_content.json`);
            vscode.window.showInformationMessage(`✅ 文件内容已导出到 state/file_content.json`);
        }
    });

    // ============================================================
    // 5. LLM / DeepSeek Commands
    // ============================================================

    // 5a. Ask DeepSeek directly
    const askDeepSeekDisposable = vscode.commands.registerCommand('ama.askDeepSeek', async () => {
        if (!deepSeekClient.isConfigured()) {
            const configure = await vscode.window.showWarningMessage(
                'DeepSeek API 未配置。请在 .env 文件中设置 DEEPSEEK_API_KEY。',
                '打开 .env',
                '取消'
            );
            if (configure === '打开 .env') {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const envPath = vscode.Uri.joinPath(workspaceFolders[0].uri, '.env');
                    try {
                        await vscode.workspace.fs.stat(envPath);
                    } catch {
                        await vscode.workspace.fs.writeFile(envPath, Buffer.from('# AMA Environment Configuration\nDEEPSEEK_API_KEY=your_key_here\nDEEPSEEK_API_BASE=https://api.deepseek.com/v1\nCLINE_MCP_URL=http://localhost:5050\n', 'utf-8'));
                    }
                    await vscode.window.showTextDocument(envPath);
                }
            }
            return;
        }

        const prompt = await vscode.window.showInputBox({
            prompt: '输入您的问题或指令',
            placeHolder: '例如：列出当前所有待处理的任务并分析优先级',
            ignoreFocusOut: true,
        });

        if (!prompt) return;

        clineService.addLog('info', '🤖 [DeepSeek] 正在请求 DeepSeek API...');

        try {
            const systemPrompt = `你是一个 AMA (AI Messenger Agent) 的 LLM 调度助手。
你的职责是帮助用户分析任务状态、提供建议、并生成可执行的指令。
当前时间: ${new Date().toLocaleString('zh-CN')}`;

            const response = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在请求 DeepSeek API...',
                    cancellable: false,
                },
                async () => {
                    return await deepSeekClient.askLLM(prompt, systemPrompt);
                }
            );

            clineService.addLog('success', `🤖 [DeepSeek] 响应: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`);

            const doc = await vscode.workspace.openTextDocument({
                content: `# DeepSeek Response\n\n## Prompt\n${prompt}\n\n## Response\n${response}\n`,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc);

            vscode.window.showInformationMessage('✅ DeepSeek 响应已获取');
        } catch (err: any) {
            clineService.addLog('error', `❌ [DeepSeek] 请求失败: ${err.message}`);
            vscode.window.showErrorMessage(`DeepSeek 请求失败: ${err.message}`);
        }
    });

    // 5b. Generate Task Chain from natural language
    // Supports both direct call (with text argument from webview) and interactive input box
    const generateTaskChainDisposable = vscode.commands.registerCommand('ama.generateTaskChain', async (inputText?: string) => {
        if (!deepSeekClient.isConfigured()) {
            vscode.window.showWarningMessage('DeepSeek API 未配置。请在 .env 文件中设置 DEEPSEEK_API_KEY。');
            return;
        }

        let input = inputText;
        if (!input) {
            input = await vscode.window.showInputBox({
                prompt: '用自然语言描述您想要执行的任务链',
                placeHolder: '例如：拉取最新代码，构建前端，然后部署到 Render',
                ignoreFocusOut: true,
                validateInput: (value) => value.trim() ? null : '请输入任务描述',
            });
        }

        if (!input) return;

        clineService.addLog('info', '🧠 [TaskChain] 正在生成任务链...');

        try {
            const chain = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在生成任务链...',
                    cancellable: false,
                },
                async () => {
                    return await deepSeekClient.generateTaskChain(input);
                }
            );

            if (!chain || chain.length === 0) {
                clineService.addLog('error', '❌ [TaskChain] 生成的任务链为空');
                vscode.window.showErrorMessage('生成的任务链为空');
                return;
            }

            clineService.addLog('success', `✅ [TaskChain] 成功生成任务链，共 ${chain.length} 个步骤`);

            // Log each step
            for (let i = 0; i < chain.length; i++) {
                clineService.addLog('info', `  ${i + 1}. [${chain[i].action}] ${chain[i].description || ''}`);
            }

            // Set the chain in the webview
            taskChainWebviewProvider.setTaskChain(chain);

            // Also show the chain in a document
            const docContent = [
                `# 任务链 (${chain.length} 个步骤)`,
                ``,
                `生成时间: ${new Date().toLocaleString('zh-CN')}`,
                ``,
                `## 步骤列表`,
                ``,
            ];

            for (let i = 0; i < chain.length; i++) {
                const step = chain[i];
                docContent.push(`### ${i + 1}. ${step.action}`);
                docContent.push(``);
                docContent.push(`**ID**: \`${step.id}\``);
                docContent.push(`**Description**: ${step.description || '无'}`);
                docContent.push(`**Parameters**:`);
                docContent.push('```json');
                docContent.push(JSON.stringify(step, null, 2));
                docContent.push('```');
                docContent.push(``);
            }

            const doc = await vscode.workspace.openTextDocument({
                content: docContent.join('\n'),
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc);

            // Focus the task chain view
            vscode.commands.executeCommand('workbench.view.extension.ama');

            vscode.window.showInformationMessage(`✅ 任务链已生成 (${chain.length} 个步骤)`);
        } catch (err: any) {
            clineService.addLog('error', `❌ [TaskChain] 生成失败: ${err.message}`);
            vscode.window.showErrorMessage(`任务链生成失败: ${err.message}`);
        }
    });

    // 5c. Execute Task Chain
    const executeTaskChainDisposable = vscode.commands.registerCommand('ama.executeTaskChain', async () => {
        const executor = TaskChainExecutor.getInstance();

        if (!clineClient.isConnected) {
            const connect = await vscode.window.showWarningMessage(
                'CLINE MCP 未连接。请先连接到 CLINE MCP。',
                '连接 CLINE MCP',
                '取消'
            );
            if (connect === '连接 CLINE MCP') {
                const success = await clineClient.connect();
                if (!success) return;
            } else {
                return;
            }
        }

        if (executor.isRunning) {
            vscode.window.showWarningMessage('任务链正在执行中');
            return;
        }

        // If there's no chain, prompt to generate one
        if (!executor.currentState || !executor.currentState.chain || executor.currentState.chain.length === 0) {
            vscode.window.showWarningMessage('没有可执行的任务链。请先使用 "AMA: 生成任务链" 命令创建');
            return;
        }

        try {
            await executor.executeTaskChain(executor.currentState.chain);
        } catch (err: any) {
            vscode.window.showErrorMessage(`任务链执行失败: ${err.message}`);
        }
    });

    // 5d. Abort Task Chain Execution
    const abortTaskChainDisposable = vscode.commands.registerCommand('ama.abortTaskChain', async () => {
        const executor = TaskChainExecutor.getInstance();
        await executor.abortExecution();
        vscode.window.showInformationMessage('⏹️ 任务链执行已中止');
    });

    // 5e. Open Task Chain Input Panel (focus the task chain view)
    const openTaskChainInputDisposable = vscode.commands.registerCommand('ama.openTaskChainInput', () => {
        vscode.commands.executeCommand('workbench.view.extension.ama');
        // Focus the task chain view specifically
        vscode.commands.executeCommand('amaTaskChainView.focus');
        clineService.addLog('info', '📝 已打开任务链输入面板');
    });

    // 5f. Auto Orchestrate - LLM-driven scheduling loop
    let orchestrationTimer: NodeJS.Timeout | null = null;
    let isOrchestrating = false;

    const autoOrchestrateDisposable = vscode.commands.registerCommand('ama.autoOrchestrate', async () => {
        if (isOrchestrating) {
            if (orchestrationTimer) {
                clearInterval(orchestrationTimer);
                orchestrationTimer = null;
            }
            isOrchestrating = false;
            clineService.addLog('info', '⏹️ [Orchestrator] 自动调度已停止');
            vscode.window.showInformationMessage('⏹️ 自动调度已停止');
            return;
        }

        if (!deepSeekClient.isConfigured()) {
            vscode.window.showWarningMessage('DeepSeek API 未配置。请在 .env 文件中设置 DEEPSEEK_API_KEY。');
            return;
        }

        isOrchestrating = true;
        clineService.addLog('success', '🚀 [Orchestrator] 自动调度已启动（每 5 秒检查一次）');
        vscode.window.showInformationMessage('🚀 自动调度已启动');

        const orchestrationSystemPrompt = `你是一个 AMA (AI Messenger Agent) 的自动调度核心。
你的职责是：
1. 分析当前 CLINE 的状态和任务列表
2. 决定下一步需要执行的操作
3. 返回格式化的 JSON 指令

可用的操作：
- {"action": "runTask", "taskName": "任务文件名"} - 执行一个任务
- {"action": "pollNow"} - 立即轮询 GitHub Issues
- {"action": "refresh"} - 刷新任务列表
- {"action": "wait"} - 等待下一次检查
- {"action": "stop"} - 停止自动调度

请根据当前状态返回最合适的操作。只返回 JSON，不要包含其他文字。`;

        const orchestrationLoop = async () => {
            if (!isOrchestrating) return;

            try {
                clineService.addLog('info', '🔄 [Orchestrator] 正在获取 CLINE 状态...');

                const tasks = taskTreeDataProvider.getCurrentTasks();
                const taskSummary = tasks.map(t => ({
                    name: t.label,
                    status: t.taskStatus,
                    time: t.taskTime,
                }));

                const stateSummary = {
                    isConnected: clineService.isConnected,
                    isPolling: clineService.isPolling,
                    taskCount: tasks.length,
                    tasks: taskSummary,
                };

                const prompt = `当前 AMA 状态：
\`\`\`json
${JSON.stringify(stateSummary, null, 2)}
\`\`\`

请分析当前状态并返回下一步操作指令（JSON 格式）。`;

                const response = await deepSeekClient.askLLM(prompt, orchestrationSystemPrompt);

                let instruction: any;
                try {
                    const jsonMatch = response.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        instruction = JSON.parse(jsonMatch[0]);
                    } else {
                        instruction = JSON.parse(response);
                    }
                } catch {
                    clineService.addLog('warn', `⚠️ [Orchestrator] 无法解析 LLM 响应: ${response.substring(0, 100)}...`);
                    return;
                }

                clineService.addLog('info', `🧠 [Orchestrator] LLM 决策: ${JSON.stringify(instruction)}`);

                switch (instruction.action) {
                    case 'runTask':
                        if (instruction.taskName) {
                            const taskItem = tasks.find(t => t.label === instruction.taskName);
                            if (taskItem) {
                                clineService.addLog('info', `🎯 [Orchestrator] 执行任务: ${instruction.taskName}`);
                                await taskTreeDataProvider.runTask(taskItem);
                            } else {
                                clineService.addLog('warn', `⚠️ [Orchestrator] 任务未找到: ${instruction.taskName}`);
                            }
                        }
                        break;

                    case 'pollNow':
                        clineService.addLog('info', '📡 [Orchestrator] 触发轮询');
                        if (clineService.isConnected && !clineService.isPolling) {
                            clineService.startPolling();
                            setTimeout(() => clineService.stopPolling(), 10000);
                        }
                        break;

                    case 'refresh':
                        clineService.addLog('info', '🔄 [Orchestrator] 刷新任务列表');
                        taskTreeDataProvider.refresh();
                        break;

                    case 'stop':
                        clineService.addLog('info', '⏹️ [Orchestrator] LLM 请求停止调度');
                        if (orchestrationTimer) {
                            clearInterval(orchestrationTimer);
                            orchestrationTimer = null;
                        }
                        isOrchestrating = false;
                        break;

                    case 'wait':
                    default:
                        break;
                }
            } catch (err: any) {
                clineService.addLog('error', `❌ [Orchestrator] 调度循环异常: ${err.message}`);
            }
        };

        orchestrationLoop();
        orchestrationTimer = setInterval(orchestrationLoop, 5000);
    });

    // ============================================================
    // 6. Push all subscriptions
    // ============================================================

    context.subscriptions.push(
        connectDisposable,
        connectMCPDisposable,
        disconnectMCPDisposable,
        startDisposable,
        stopDisposable,
        refreshDisposable,
        openLogDisposable,
        openTaskFileDisposable,
        runTaskDisposable,
        clearLogsDisposable,
        exportFileContentDisposable,
        askDeepSeekDisposable,
        generateTaskChainDisposable,
        executeTaskChainDisposable,
        abortTaskChainDisposable,
        openTaskChainInputDisposable,
        autoOrchestrateDisposable,
    );

    // ============================================================
    // 7. Auto-refresh task list when new tasks are discovered
    // ============================================================
    context.subscriptions.push(
        clineService.onTaskDiscovered(() => {
            taskTreeDataProvider.refresh();
        })
    );

    // ============================================================
    // 8. Log startup
    // ============================================================
    clineService.addLog('info', '🚀 AMA 扩展已激活');
    clineService.addLog('info', '💡 请点击 "Connect to CLINE" 按钮连接到 GitHub');
    clineService.addLog('info', '💡 请点击 "Connect to CLINE MCP" 连接到 CLINE MCP 服务');
    clineService.addLog('info', `📂 任务目录: ${configManager.getTasksDir()}`);

    if (deepSeekClient.isConfigured()) {
        clineService.addLog('success', '🤖 DeepSeek API 已配置');
    } else {
        clineService.addLog('info', '🤖 DeepSeek API 未配置。如需 LLM 功能，请在 .env 中设置 DEEPSEEK_API_KEY');
    }

    // ============================================================
    // 9. Start real-time monitoring
    // ============================================================
    monitorService.startMonitoring();
    clineService.addLog('success', '📊 实时监控已启动 (logs/ + state/)');

    // ============================================================
    // 10. Project file scanning (for Copilot visibility)
    // ============================================================

    // 10a. Initial scan on startup
    scanAndWriteProjectFiles();
    clineService.addLog('success', '📁 项目文件结构已扫描 → state/project_files.json');

    // 10b. Refresh project file list every 10 seconds
    const projectFilesTimer = setInterval(() => {
        scanAndWriteProjectFiles();
    }, 10000);

    // Clean up timer on deactivation
    context.subscriptions.push({
        dispose: () => {
            clearInterval(projectFilesTimer);
        },
    });
}

export function deactivate() {
    const clineService = ClineService.getInstance();
    const clineClient = ClineClient.getInstance();
    const monitorService = MonitorService.getInstance();

    if (clineService.isPolling) {
        clineService.stopPolling();
    }

    clineClient.disconnect();

    // Stop monitoring
    monitorService.stopMonitoring();

    console.log('AMA extension is now deactivated!');
}
