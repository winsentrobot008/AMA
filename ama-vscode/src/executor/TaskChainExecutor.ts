import * as vscode from 'vscode';
import { TaskChain, TaskChainStep, StepExecutionState, TaskChainExecutionState, TaskChainExecutionConfig } from '../types/TaskChain';
import { ClineClient } from '../cline/ClineClient';
import { ClineService } from '../services/ClineService';
import { appendClineLog, updateAmaState } from '../services/FileLogger';

/**
 * Default execution configuration.
 */
const DEFAULT_CONFIG: TaskChainExecutionConfig = {
    maxRetriesPerStep: 0,
    retryDelayMs: 2000,
    abortOnFailure: true,
    logOutput: true,
};

/**
 * Event emitted when the execution state changes.
 */
export interface TaskChainExecutionEvent {
    state: TaskChainExecutionState;
    type: 'started' | 'stepStarted' | 'stepCompleted' | 'stepFailed' | 'stepRetrying' | 'completed' | 'aborted' | 'error';
    stepIndex?: number;
    message?: string;
}

/**
 * TaskChainExecutor executes a TaskChain sequentially.
 * Each step is sent to CLINE via ClineClient, and results are logged.
 */
export class TaskChainExecutor {
    private static instance: TaskChainExecutor;
    private _onExecutionEvent = new vscode.EventEmitter<TaskChainExecutionEvent>();
    private _currentState: TaskChainExecutionState | null = null;
    private _abortRequested: boolean = false;

    readonly onExecutionEvent: vscode.Event<TaskChainExecutionEvent> = this._onExecutionEvent.event;

    private constructor() {}

    static getInstance(): TaskChainExecutor {
        if (!TaskChainExecutor.instance) {
            TaskChainExecutor.instance = new TaskChainExecutor();
        }
        return TaskChainExecutor.instance;
    }

    /**
     * Get the current execution state (null if no execution is in progress).
     */
    get currentState(): TaskChainExecutionState | null {
        return this._currentState;
    }

    /**
     * Whether an execution is currently running.
     */
    get isRunning(): boolean {
        return this._currentState?.isRunning === true;
    }

    /**
     * Execute a task chain sequentially.
     *
     * @param chain - The task chain to execute.
     * @param config - Optional execution configuration.
     */
    async executeTaskChain(chain: TaskChain, config?: Partial<TaskChainExecutionConfig>): Promise<TaskChainExecutionState> {
        const cfg: TaskChainExecutionConfig = { ...DEFAULT_CONFIG, ...config };
        const service = ClineService.getInstance();
        const clineClient = ClineClient.getInstance();

        // Check CLINE connection
        if (!clineClient.isConnected) {
            service.addLog('error', '❌ [Executor] CLINE 未连接，请先连接 CLINE');
            throw new Error('CLINE is not connected. Please connect to CLINE first.');
        }

        // Initialize execution state
        this._abortRequested = false;
        this._currentState = {
            chain,
            steps: chain.map(step => ({
                step,
                status: 'pending',
                retryCount: 0,
            })),
            currentStepIndex: 0,
            isRunning: true,
            isAborted: false,
            startedAt: new Date().toISOString(),
            totalSteps: chain.length,
            completedSteps: 0,
            failedSteps: 0,
        };

        this._onExecutionEvent.fire({
            state: this._currentState,
            type: 'started',
            message: `开始执行任务链，共 ${chain.length} 个步骤`,
        });

        service.addLog('success', `🚀 [Executor] 开始执行任务链，共 ${chain.length} 个步骤`);

        appendClineLog({ source: 'TaskChainExecutor', event: 'execution_started', totalSteps: chain.length, chain: chain.map(s => s.id) });
        updateAmaState({ currentTaskChain: chain, currentStep: chain[0]?.id || '' });

        // Execute each step sequentially
        for (let i = 0; i < chain.length; i++) {
            if (this._abortRequested) {
                break;
            }

            this._currentState.currentStepIndex = i;
            const stepState = this._currentState.steps[i];
            const step = chain[i];

            stepState.status = 'running';
            stepState.startedAt = new Date().toISOString();

            this._onExecutionEvent.fire({
                state: this._currentState,
                type: 'stepStarted',
                stepIndex: i,
                message: `执行步骤 ${i + 1}/${chain.length}: ${step.description || step.action}`,
            });

            service.addLog('info', `▶️ [Executor] 步骤 ${i + 1}/${chain.length}: ${step.description || step.action} (${step.id})`);

            appendClineLog({ source: 'TaskChainExecutor', event: 'step_started', stepIndex: i, stepId: step.id, description: step.description || step.action });
            updateAmaState({ currentStep: step.id });

            // Execute with retry support
            let success = false;
            let lastError: string | undefined;

            for (let attempt = 0; attempt <= cfg.maxRetriesPerStep; attempt++) {
                if (this._abortRequested) break;

                if (attempt > 0) {
                    stepState.retryCount = attempt;
                    service.addLog('warn', `🔄 [Executor] 步骤 ${step.id} 第 ${attempt + 1} 次重试...`);

                    this._onExecutionEvent.fire({
                        state: this._currentState,
                        type: 'stepRetrying',
                        stepIndex: i,
                        message: `重试步骤 ${step.id} (第 ${attempt + 1} 次)`,
                    });

                    appendClineLog({ source: 'TaskChainExecutor', event: 'step_retrying', stepIndex: i, stepId: step.id, attempt: attempt + 1 });

                    // Wait before retry
                    await this.delay(cfg.retryDelayMs);
                }

                try {
                    const result = await clineClient.runTask({
                        name: step.id,
                        description: step.description || step.action,
                        params: { ...step, id: undefined, action: undefined, description: undefined },
                    });

                    if (result.success) {
                        stepState.status = 'success';
                        stepState.output = result.output;
                        stepState.completedAt = new Date().toISOString();
                        this._currentState!.completedSteps++;
                        success = true;

                        service.addLog('success', `✅ [Executor] 步骤 ${step.id} 完成`);

                    this._onExecutionEvent.fire({
                        state: this._currentState,
                        type: 'stepCompleted',
                        stepIndex: i,
                        message: `步骤 ${step.id} 完成`,
                    });

                    appendClineLog({ source: 'TaskChainExecutor', event: 'step_completed', stepIndex: i, stepId: step.id });

                        break;
                    } else {
                        lastError = result.error || 'Unknown error';
                        service.addLog('error', `❌ [Executor] 步骤 ${step.id} 失败: ${lastError}`);

                        if (attempt < cfg.maxRetriesPerStep) {
                            service.addLog('warn', `⏳ [Executor] 将在 ${cfg.retryDelayMs / 1000} 秒后重试...`);
                        }
                    }
                } catch (err: any) {
                    lastError = err.message;
                    service.addLog('error', `❌ [Executor] 步骤 ${step.id} 异常: ${lastError}`);

                    if (attempt < cfg.maxRetriesPerStep) {
                        service.addLog('warn', `⏳ [Executor] 将在 ${cfg.retryDelayMs / 1000} 秒后重试...`);
                    }
                }
            }

            if (!success) {
                stepState.status = 'failed';
                stepState.error = lastError;
                stepState.completedAt = new Date().toISOString();
                this._currentState!.failedSteps++;

                this._onExecutionEvent.fire({
                    state: this._currentState,
                    type: 'stepFailed',
                    stepIndex: i,
                    message: `步骤 ${step.id} 失败: ${lastError}`,
                });

                appendClineLog({ source: 'TaskChainExecutor', event: 'step_failed', stepIndex: i, stepId: step.id, error: lastError });
                updateAmaState({ lastError: `步骤 ${step.id} 失败: ${lastError}` });

                if (cfg.abortOnFailure) {
                    service.addLog('error', `⛔ [Executor] 步骤 ${step.id} 失败，终止执行链`);

                    // Mark remaining steps as skipped
                    for (let j = i + 1; j < chain.length; j++) {
                        this._currentState!.steps[j].status = 'skipped';
                    }

                    this._currentState!.isRunning = false;
                    this._currentState!.isAborted = true;
                    this._currentState!.completedAt = new Date().toISOString();

                    this._onExecutionEvent.fire({
                        state: this._currentState,
                        type: 'aborted',
                        message: `任务链在步骤 ${step.id} 中止`,
                    });

                    return this._currentState;
                }
            }
        }

        // Execution completed (not aborted)
        if (!this._abortRequested) {
            this._currentState!.isRunning = false;
            this._currentState!.completedAt = new Date().toISOString();

            const allSucceeded = this._currentState!.failedSteps === 0;
            const status = allSucceeded ? '全部完成' : `${this._currentState!.completedSteps} 完成, ${this._currentState!.failedSteps} 失败`;

            service.addLog('success', `🏁 [Executor] 任务链执行完毕: ${status}`);

            this._onExecutionEvent.fire({
                state: this._currentState,
                type: 'completed',
                message: `任务链执行完毕: ${status}`,
            });

            appendClineLog({ source: 'TaskChainExecutor', event: 'execution_completed', status, completedSteps: this._currentState!.completedSteps, failedSteps: this._currentState!.failedSteps });
            updateAmaState({ currentTaskChain: [], currentStep: '', lastError: null });
        }

        return this._currentState;
    }

    /**
     * Request abort of the current execution.
     */
    async abortExecution(): Promise<void> {
        if (!this._currentState || !this._currentState.isRunning) {
            return;
        }

        this._abortRequested = true;
        this._currentState.isAborted = true;
        this._currentState.isRunning = false;
        this._currentState.completedAt = new Date().toISOString();

        // Mark current and remaining steps as skipped
        for (let i = this._currentState.currentStepIndex; i < this._currentState.steps.length; i++) {
            if (this._currentState.steps[i].status === 'pending' || this._currentState.steps[i].status === 'running') {
                this._currentState.steps[i].status = 'skipped';
            }
        }

        const service = ClineService.getInstance();
        service.addLog('warn', '⏹️ [Executor] 用户请求中止任务链执行');

        this._onExecutionEvent.fire({
            state: this._currentState,
            type: 'aborted',
            message: '用户请求中止执行',
        });

        appendClineLog({ source: 'TaskChainExecutor', event: 'execution_aborted', stepIndex: this._currentState.currentStepIndex });
        updateAmaState({ currentTaskChain: [], currentStep: '', lastError: '用户中止' });
    }

    /**
     * Utility: delay for a given number of milliseconds.
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
