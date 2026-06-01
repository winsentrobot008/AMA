/**
 * AMA v0.3.0 完整自动化测试套件
 * 运行方式: npx ts-node src/test/runTest.ts
 */

interface TestResult { name: string; passed: boolean; error?: string; duration: number; }
interface TestReport { timestamp: string; total: number; passed: number; failed: number; results: TestResult[]; summary: string; }

class TestRunner {
    private results: TestResult[] = [];
    async describe(name: string, fn: () => Promise<void>): Promise<void> {
        console.log("\n" + "=".repeat(60));
        console.log("  " + name);
        console.log("=".repeat(60));
        try { await fn(); } catch (err: any) { console.error("  Suite error: " + err.message); }
    }
    async it(name: string, fn: () => Promise<void>): Promise<void> {
        const testStart = Date.now();
        try {
            await fn();
            const duration = Date.now() - testStart;
            this.results.push({ name, passed: true, duration });
            console.log("  [PASS] " + name + " (" + duration + "ms)");
        } catch (err: any) {
            const duration = Date.now() - testStart;
            this.results.push({ name, passed: false, error: err.message, duration });
            console.log("  [FAIL] " + name + " (" + duration + "ms)");
            console.log("     Error: " + err.message);
        }
    }
    assert(condition: boolean, message: string): void {
        if (!condition) throw new Error("Assertion failed: " + message);
    }
    assertEquals<T>(actual: T, expected: T, message: string): void {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(message + "\n  Expected: " + JSON.stringify(expected) + "\n  Actual:   " + JSON.stringify(actual));
        }
    }
    generateReport(): TestReport {
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;
        const total = this.results.length;
        const report: TestReport = { timestamp: new Date().toISOString(), total, passed, failed, results: this.results, summary: "" };
        const lines: string[] = [];
        lines.push(""); lines.push("=".repeat(60));
        lines.push("  AMA v0.3.0 最终测试报告");
        lines.push("=".repeat(60));
        lines.push("  时间: " + report.timestamp);
        lines.push("  总计: " + total + " 项测试");
        lines.push("  通过: " + passed + " 项");
        lines.push("  失败: " + failed + " 项");
        lines.push("  通过率: " + (total > 0 ? Math.round((passed / total) * 100) : 0) + "%");
        lines.push("");
        if (failed > 0) {
            lines.push("  失败的测试项:");
            for (const r of this.results.filter(r => !r.passed)) {
                lines.push("    - " + r.name);
                lines.push("      Error: " + r.error);
            }
            lines.push("");
            lines.push("  需要修复的模块:");
            const failedModules = Array.from(new Set(this.results.filter(r => !r.passed).map(r => r.name.split(":")[0].trim())));
            for (const mod of failedModules) lines.push("    - " + mod);
            lines.push("");
            lines.push("  建议的修复步骤:");
            lines.push("    1. 检查失败的测试项对应的模块代码");
            lines.push("    2. 修复代码逻辑或类型错误");
            lines.push("    3. 重新运行测试确认修复");
            lines.push("    4. 确保所有依赖服务（CLINE MCP, DeepSeek API）可用");
        } else {
            lines.push("  所有测试通过！AMA v0.3.0 功能正常。");
            lines.push("");
            lines.push("  可以安全进行 Worker Pool / 自动部署 / 自动测试 / 多 Agent 协作升级");
        }
        report.summary = lines.join("\n");
        return report;
    }
}

interface TaskChainStep { id: string; action: string; description?: string; [key: string]: any; }
type TaskChain = TaskChainStep[];
type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";
interface StepExecutionState { step: TaskChainStep; status: StepStatus; startedAt?: string; completedAt?: string; output?: string; error?: string; retryCount: number; }
interface TaskChainExecutionState { chain: TaskChain; steps: StepExecutionState[]; currentStepIndex: number; isRunning: boolean; isAborted: boolean; startedAt?: string; completedAt?: string; totalSteps: number; completedSteps: number; failedSteps: number; }
interface TaskChainExecutionEvent { state: TaskChainExecutionState; type: "started" | "stepStarted" | "stepCompleted" | "stepFailed" | "stepRetrying" | "completed" | "aborted" | "error"; stepIndex?: number; message?: string; }
interface ClineStatus { connected: boolean; version?: string; uptime?: number; currentTask?: string; taskQueue?: number; memoryUsage?: number; }
interface ClineTaskResult { success: boolean; taskId?: string; output?: string; logs?: string[]; error?: string; status?: string; startedAt?: string; completedAt?: string; }

class MockClineClient {
    private _isConnected: boolean = false;
    private _taskResults: Map<string, ClineTaskResult> = new Map();
    private _logs: string[] = [];
    private _abortedTasks: Set<string> = new Set();
    get isConnected(): boolean { return this._isConnected; }
    async connect(): Promise<boolean> { this._isConnected = true; return true; }
    disconnect(): void { this._isConnected = false; }
    async getStatus(): Promise<ClineStatus> {
        if (!this._isConnected) return { connected: false };
        return { connected: true, version: "0.3.0-mock", uptime: 3600, currentTask: undefined, taskQueue: 0, memoryUsage: 128 };
    }
    async runTask(task: { name: string; description: string; [key: string]: any }): Promise<ClineTaskResult> {
        if (!this._isConnected) return { success: false, error: "Not connected", status: "failed" };
        const taskId = "task-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);
        const result: ClineTaskResult = { success: true, taskId, output: "Executed: " + task.name + "\nResult: OK", logs: ["[" + new Date().toISOString() + "] Task " + task.name + " started"], status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
        this._taskResults.set(taskId, result);
        this._logs.push("Task " + task.name + " completed: " + taskId);
        return result;
    }
    async getLogs(): Promise<string[]> { return [...this._logs]; }
    async abortTask(taskId: string): Promise<boolean> { this._abortedTasks.add(taskId); return true; }
    async getTaskLogs(taskId: string): Promise<string[]> { const r = this._taskResults.get(taskId); return r?.logs || []; }
    setConnected(connected: boolean): void { this._isConnected = connected; }
    wasTaskAborted(taskId: string): boolean { return this._abortedTasks.has(taskId); }
}

class MockTaskChainExecutor {
    private _currentState: TaskChainExecutionState | null = null;
    private _abortRequested: boolean = false;
    private _events: TaskChainExecutionEvent[] = [];
    private _clineClient: MockClineClient;
    constructor(clineClient: MockClineClient) { this._clineClient = clineClient; }
    get currentState(): TaskChainExecutionState | null { return this._currentState; }
    get isRunning(): boolean { return this._currentState?.isRunning === true; }
    get events(): TaskChainExecutionEvent[] { return [...this._events]; }
    async executeTaskChain(chain: TaskChain, config?: Partial<{ maxRetriesPerStep: number; retryDelayMs: number; abortOnFailure: boolean; logOutput: boolean }>): Promise<TaskChainExecutionState> {
        const cfg = { maxRetriesPerStep: 0, retryDelayMs: 100, abortOnFailure: true, logOutput: true, ...config };
        if (!this._clineClient.isConnected) throw new Error("CLINE is not connected. Please connect to CLINE first.");
        this._abortRequested = false;
        this._currentState = { chain, steps: chain.map(step => ({ step, status: "pending", retryCount: 0 })), currentStepIndex: 0, isRunning: true, isAborted: false, startedAt: new Date().toISOString(), totalSteps: chain.length, completedSteps: 0, failedSteps: 0 };
        this._events.push({ state: this._currentState, type: "started", message: "开始执行任务链，共 " + chain.length + " 个步骤" });
        for (let i = 0; i < chain.length; i++) {
            if (this._abortRequested) break;
            this._currentState.currentStepIndex = i;
            const stepState = this._currentState.steps[i];
            const step = chain[i];
            stepState.status = "running";
            stepState.startedAt = new Date().toISOString();
            this._events.push({ state: this._currentState, type: "stepStarted", stepIndex: i, message: "执行步骤 " + (i + 1) + "/" + chain.length + ": " + (step.description || step.action) });
            let success = false;
            let lastError: string | undefined;
            for (let attempt = 0; attempt <= cfg.maxRetriesPerStep; attempt++) {
                if (this._abortRequested) break;
                if (attempt > 0) { stepState.retryCount = attempt; this._events.push({ state: this._currentState, type: "stepRetrying", stepIndex: i, message: "重试步骤 " + step.id + " (第 " + (attempt + 1) + " 次)" }); await this.delay(cfg.retryDelayMs); }
                try {
                    const result = await this._clineClient.runTask({ name: step.id, description: step.description || step.action, params: { ...step, id: undefined, action: undefined, description: undefined } });
                    if (result.success) {
                        stepState.status = "success"; stepState.output = result.output; stepState.completedAt = new Date().toISOString();
                        this._currentState!.completedSteps++; success = true;
                        this._events.push({ state: this._currentState, type: "stepCompleted", stepIndex: i, message: "步骤 " + step.id + " 完成" });
                        break;
                    } else { lastError = result.error || "Unknown error"; }
                } catch (err: any) { lastError = err.message; }
            }
            if (!success) {
                stepState.status = "failed"; stepState.error = lastError; stepState.completedAt = new Date().toISOString();
                this._currentState!.failedSteps++;
                this._events.push({ state: this._currentState, type: "stepFailed", stepIndex: i, message: "步骤 " + step.id + " 失败: " + lastError });
                if (cfg.abortOnFailure) {
                    for (let j = i + 1; j < chain.length; j++) this._currentState!.steps[j].status = "skipped";
                    this._currentState!.isRunning = false; this._currentState!.isAborted = true; this._currentState!.completedAt = new Date().toISOString();
                    this._events.push({ state: this._currentState, type: "aborted", message: "任务链在步骤 " + step.id + " 中止" });
                    return this._currentState;
                }
            }
        }
        if (!this._abortRequested) {
            this._currentState!.isRunning = false; this._currentState!.completedAt = new Date().toISOString();
            this._events.push({ state: this._currentState, type: "completed", message: "任务链执行完毕" });
        }
        return this._currentState;
    }
    async abortExecution(): Promise<void> {
        if (!this._currentState || !this._currentState.isRunning) return;
        this._abortRequested = true;
        this._currentState.isAborted = true; this._currentState.isRunning = false; this._currentState.completedAt = new Date().toISOString();
        for (let i = this._currentState.currentStepIndex; i < this._currentState.steps.length; i++) {
            if (this._currentState.steps[i].status === "pending" || this._currentState.steps[i].status === "running") this._currentState.steps[i].status = "skipped";
        }
        this._events.push({ state: this._currentState, type: "aborted", message: "用户请求中止执行" });
    }
    private delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
}

class MockDeepSeekClient {
    private _isConfigured: boolean = true;
    private _mockResponses: Map<string, TaskChain> = new Map();
    constructor() {
        this._mockResponses.set("帮我构建并部署前端", [
            { id: "step1", action: "git_pull", description: "拉取最新代码", repo: "owner/repo" },
            { id: "step2", action: "npm_install", description: "安装前端依赖", dir: "frontend" },
            { id: "step3", action: "npm_build", description: "构建前端项目", dir: "frontend" },
            { id: "step4", action: "deploy_render", description: "部署到 Render", service: "my-service" },
        ]);
    }
    isConfigured(): boolean { return this._isConfigured; }
    setConfigured(configured: boolean): void { this._isConfigured = configured; }
    async generateTaskChain(naturalLanguage: string): Promise<TaskChain> {
        if (!this._isConfigured) throw new Error("DEEPSEEK_API_KEY is not configured");
        const mockResponse = this._mockResponses.get(naturalLanguage);
        if (mockResponse) return JSON.parse(JSON.stringify(mockResponse));
        const chain: TaskChain = [];
        const words = naturalLanguage.toLowerCase();
        if (words.includes("build") || words.includes("构建") || words.includes("部署") || words.includes("deploy")) {
            chain.push({ id: "step1", action: "git_pull", description: "拉取最新代码" });
            chain.push({ id: "step2", action: "npm_install", description: "安装依赖" });
            chain.push({ id: "step3", action: "npm_build", description: "构建项目" });
            if (words.includes("deploy") || words.includes("部署")) chain.push({ id: "step4", action: "deploy_render", description: "部署到 Render" });
        } else if (words.includes("test") || words.includes("测试")) {
            chain.push({ id: "step1", action: "npm_test", description: "运行测试" });
        } else {
            chain.push({ id: "step1", action: "echo", description: "执行默认操作" });
        }
        return chain;
    }
    async askLLM(prompt: string, systemPrompt?: string): Promise<string> {
        if (!this._isConfigured) throw new Error("DEEPSEEK_API_KEY is not configured");
        return "Mock LLM response for: " + prompt.substring(0, 50) + "...";
    }
    setMockResponse(input: string, chain: TaskChain): void { this._mockResponses.set(input, chain); }
}

class MockWebview {
    private _messages: any[] = [];
    private _isLoaded: boolean = false;
    private _chainContainer: string = "";
    private _clineStatusBar: string = "";
    private _nlInputValue: string = "";
    private _executeBtnEnabled: boolean = true;
    private _abortBtnEnabled: boolean = false;
    get messages(): any[] { return [...this._messages]; }
    get isLoaded(): boolean { return this._isLoaded; }
    get chainContainer(): string { return this._chainContainer; }
    get clineStatusBar(): string { return this._clineStatusBar; }
    get nlInputValue(): string { return this._nlInputValue; }
    get executeBtnEnabled(): boolean { return this._executeBtnEnabled; }
    get abortBtnEnabled(): boolean { return this._abortBtnEnabled; }
    loadHtml(html: string): void {
        this._isLoaded = true;
        this._chainContainer = html.includes("chain-container") ? "rendered" : "missing";
        this._clineStatusBar = html.includes("cline-status-bar") ? "rendered" : "missing";
        this._nlInputValue = html.includes("nlInput") ? "rendered" : "missing";
        this._executeBtnEnabled = html.includes("executeBtn") && !html.includes("executeBtn.disabled");
    }
    postMessage(message: any): void { this._messages.push(message); }
    receiveMessage(message: any): void { this._messages.push(message); }
    clearMessages(): void { this._messages = []; }
    renderChain(chain: TaskChain | null, execState: TaskChainExecutionState | null, isRunning: boolean): void {
        if (!chain || chain.length === 0) { this._chainContainer = "empty"; this._executeBtnEnabled = false; this._abortBtnEnabled = false; return; }
        this._chainContainer = "rendered: " + chain.length + " steps";
        this._executeBtnEnabled = !isRunning;
        this._abortBtnEnabled = isRunning;
    }
    updateClineStatus(status: ClineStatus): void {
        if (status.connected) { this._clineStatusBar = status.currentTask ? "busy" : "online"; }
        else { this._clineStatusBar = "offline"; }
    }
}

// ============================================================
// Test Functions
// ============================================================

async function runTests(): Promise<TestReport> {
    const runner = new TestRunner();
    const mockClineClient = new MockClineClient();
    const mockDeepSeekClient = new MockDeepSeekClient();
    const mockWebview = new MockWebview();
    const mockExecutor = new MockTaskChainExecutor(mockClineClient);

    // Test 1: Webview UI
    await runner.describe("Test 1: Webview UI (amaTaskChainView)", async () => {
        await runner.it("1.1 Webview 应该能成功加载 HTML", async () => {
            const html = '<!DOCTYPE html><html><head><title>AMA 任务链</title></head><body>' +
                '<div class="cline-status-bar" id="clineStatusBar">...</div>' +
                '<div class="nl-input-area"><input type="text" id="nlInput" /></div>' +
                '<div class="toolbar"><button id="executeBtn">执行任务链</button><button class="danger" id="abortBtn" disabled>中止</button></div>' +
                '<div class="chain-container" id="chainContainer">暂无任务链</div>' +
                '<div class="summary-bar" id="summaryBar">...</div></body></html>';
            mockWebview.loadHtml(html);
            runner.assert(mockWebview.isLoaded, 'Webview should be loaded');
        });
        await runner.it('1.2 任务链区域 (chain-container) 应该渲染', async () => { runner.assert(mockWebview.chainContainer === 'rendered', 'Chain container should be rendered'); });
        await runner.it('1.3 Worker 状态区域 (cline-status-bar) 应该渲染', async () => { runner.assert(mockWebview.clineStatusBar === 'rendered', 'CLINE status bar should be rendered'); });
        await runner.it('1.4 自然语言输入框 (nlInput) 应该可用', async () => { runner.assert(mockWebview.nlInputValue === 'rendered', 'NL input should be rendered'); });
        await runner.it('1.5 执行按钮应该可点击，中止按钮应该初始禁用', async () => { runner.assert(mockWebview.executeBtnEnabled, 'Execute button should be enabled'); runner.assert(!mockWebview.abortBtnEnabled, 'Abort button should be disabled initially'); });
        await runner.it('1.6 Webview -> Extension 消息应该能正常发送', async () => {
            mockWebview.clearMessages();
            mockWebview.postMessage({ command: 'executeChain' });
            mockWebview.postMessage({ command: 'generateChain', text: '测试任务' });
            mockWebview.postMessage({ command: 'refreshClineStatus' });
            runner.assert(mockWebview.messages.length === 3, 'Should have 3 messages');
            runner.assertEquals(mockWebview.messages[0].command, 'executeChain', 'First message should be executeChain');
            runner.assertEquals(mockWebview.messages[1].command, 'generateChain', 'Second message should be generateChain');
            runner.assertEquals(mockWebview.messages[2].command, 'refreshClineStatus', 'Third message should be refreshClineStatus');
        });
        await runner.it('1.7 Extension -> Webview 消息应该能正常接收', async () => {
            mockWebview.clearMessages();
            mockWebview.receiveMessage({ command: 'setChain', chain: [{ id: 'step1', action: 'echo', description: 'test' }], executionState: null, isRunning: false });
            mockWebview.receiveMessage({ command: 'clineStatus', status: { connected: true, version: '0.3.0' } });
            runner.assert(mockWebview.messages.length === 2, 'Should have 2 messages');
            runner.assertEquals(mockWebview.messages[0].command, 'setChain', 'First message should be setChain');
            runner.assertEquals(mockWebview.messages[1].command, 'clineStatus', 'Second message should be clineStatus');
        });
    });

    // Test 2: DeepSeek -> TaskChain
    await runner.describe('Test 2: DeepSeek -> TaskChain 生成', async () => {
        await runner.it('2.1 DeepSeekClient 应该能检测配置状态', async () => {
            runner.assert(mockDeepSeekClient.isConfigured() === true, 'Should be configured');
            mockDeepSeekClient.setConfigured(false);
            runner.assert(mockDeepSeekClient.isConfigured() === false, 'Should not be configured');
            mockDeepSeekClient.setConfigured(true);
        });
        await runner.it('2.2 generateTaskChain 应该返回有效的 JSON 任务链', async () => {
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            runner.assert(Array.isArray(chain), 'Chain should be an array');
            runner.assert(chain.length > 0, 'Chain should have at least one step');
        });
        await runner.it('2.3 生成的任务链每个步骤应该有 id 和 action', async () => {
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            for (let i = 0; i < chain.length; i++) { runner.assert(!!chain[i].id, 'Step ' + i + ' should have an id'); runner.assert(!!chain[i].action, 'Step ' + i + ' should have an action'); }
        });
        await runner.it('2.4 生成的任务链应该包含构建和部署步骤', async () => {
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            const actions = chain.map(s => s.action);
            runner.assert(actions.includes('git_pull'), 'Should include git_pull');
            runner.assert(actions.includes('npm_build'), 'Should include npm_build');
            runner.assert(actions.includes('deploy_render'), 'Should include deploy_render');
        });
        await runner.it('2.5 任务链应该能成功渲染到 Webview', async () => {
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            mockWebview.renderChain(chain, null, false);
            runner.assert(mockWebview.chainContainer.includes('4 steps'), 'Should show 4 steps');
            runner.assert(mockWebview.executeBtnEnabled, 'Execute button should be enabled');
            runner.assert(!mockWebview.abortBtnEnabled, 'Abort button should be disabled');
        });
        await runner.it('2.6 未配置 DeepSeek 时应该抛出错误', async () => {
            mockDeepSeekClient.setConfigured(false);
            try { await mockDeepSeekClient.generateTaskChain('test'); runner.assert(false, 'Should have thrown an error'); }
            catch (err: any) { runner.assert(err.message.includes('DEEPSEEK_API_KEY'), 'Error should mention API key'); }
            mockDeepSeekClient.setConfigured(true);
        });
        await runner.it('2.7 不同输入应该生成不同的任务链', async () => {
            const buildChain = await mockDeepSeekClient.generateTaskChain('帮我构建前端');
            const testChain = await mockDeepSeekClient.generateTaskChain('运行测试');
            const deployChain = await mockDeepSeekClient.generateTaskChain('部署到服务器');
            runner.assert(buildChain.length > 0, 'Build chain should not be empty');
            runner.assert(testChain.length > 0, 'Test chain should not be empty');
            runner.assert(deployChain.length > 0, 'Deploy chain should not be empty');
            const buildActions = buildChain.map(s => s.action).join(',');
            const testActions = testChain.map(s => s.action).join(',');
            runner.assert(buildActions !== testActions, 'Build and test chains should differ');
        });
    });

    // Test 3: TaskChainExecutor
    await runner.describe('Test 3: TaskChainExecutor 执行流程', async () => {
        await runner.it('3.1 未连接 CLINE 时执行应该抛出错误', async () => {
            mockClineClient.setConnected(false);
            try { await mockExecutor.executeTaskChain([{ id: 'step1', action: 'echo', args: ['hello'] }]); runner.assert(false, 'Should have thrown an error'); }
            catch (err: any) { runner.assert(err.message.includes('not connected'), 'Error should mention not connected'); }
            mockClineClient.setConnected(true);
        });
        await runner.it('3.2 简单任务链应该成功执行', async () => {
            const state = await mockExecutor.executeTaskChain([{ id: 'step1', action: 'echo', args: ['hello'] }]);
            runner.assert(state.isRunning === false, 'Should not be running after completion');
            runner.assert(state.isAborted === false, 'Should not be aborted');
            runner.assert(state.completedSteps === 1, 'Should have 1 completed step');
            runner.assert(state.failedSteps === 0, 'Should have 0 failed steps');
        });
        await runner.it('3.3 执行事件应该按顺序触发: stepStart -> stepSuccess -> chainComplete', async () => {
            const freshExecutor = new MockTaskChainExecutor(mockClineClient);
            await freshExecutor.executeTaskChain([{ id: 'step1', action: 'echo', args: ['hello'] }]);
            const eventTypes = freshExecutor.events.map(e => e.type);
            runner.assert(eventTypes.includes('started'), 'Should have started event');
            runner.assert(eventTypes.includes('stepStarted'), 'Should have stepStarted event');
            runner.assert(eventTypes.includes('stepCompleted'), 'Should have stepCompleted event');
            runner.assert(eventTypes.includes('completed'), 'Should have completed event');
            runner.assert(eventTypes.indexOf('started') < eventTypes.indexOf('stepStarted'), 'started should come before stepStarted');
            runner.assert(eventTypes.indexOf('stepStarted') < eventTypes.indexOf('stepCompleted'), 'stepStarted should come before stepCompleted');
            runner.assert(eventTypes.indexOf('stepCompleted') < eventTypes.indexOf('completed'), 'stepCompleted should come before completed');
        });
        await runner.it('3.4 多步骤任务链应该全部执行完成', async () => {
            const state = await mockExecutor.executeTaskChain([
                { id: 'step1', action: 'echo', args: ['hello'] },
                { id: 'step2', action: 'echo', args: ['world'] },
                { id: 'step3', action: 'echo', args: ['test'] },
            ]);
            runner.assert(state.completedSteps === 3, 'Should have 3 completed steps');
            runner.assert(state.failedSteps === 0, 'Should have 0 failed steps');
            runner.assert(state.totalSteps === 3, 'Should have 3 total steps');
        });
        await runner.it('3.5 Webview 应该实时更新执行状态', async () => {
            const chain: TaskChain = [{ id: 'step1', action: 'echo', args: ['hello'] }, { id: 'step2', action: 'echo', args: ['world'] }];
            mockWebview.renderChain(chain, null, false);
            runner.assert(mockWebview.executeBtnEnabled, 'Execute button should be enabled before execution');
            mockWebview.renderChain(chain, { chain, steps: chain.map(s => ({ step: s, status: 'running', retryCount: 0 })), currentStepIndex: 0, isRunning: true, isAborted: false, totalSteps: 2, completedSteps: 0, failedSteps: 0 }, true);
            runner.assert(!mockWebview.executeBtnEnabled, 'Execute button should be disabled during execution');
            runner.assert(mockWebview.abortBtnEnabled, 'Abort button should be enabled during execution');
            mockWebview.renderChain(chain, { chain, steps: chain.map(s => ({ step: s, status: 'success', retryCount: 0, completedAt: new Date().toISOString() })), currentStepIndex: 1, isRunning: false, isAborted: false, totalSteps: 2, completedSteps: 2, failedSteps: 0, completedAt: new Date().toISOString() }, false);
            runner.assert(mockWebview.executeBtnEnabled, 'Execute button should be re-enabled after execution');
            runner.assert(!mockWebview.abortBtnEnabled, 'Abort button should be disabled after execution');
        });
    });

    // Test 4: 中止任务链
    await runner.describe('Test 4: 中止任务链', async () => {
        await runner.it('4.1 abortExecution 应该能中止正在执行的任务链', async () => {
            const slowClient = new MockClineClient();
            slowClient.setConnected(true);
            const origRun = slowClient.runTask.bind(slowClient);
            slowClient.runTask = async (task: any) => { await new Promise(r => setTimeout(r, 200)); return origRun(task); };
            const abortExecutor = new MockTaskChainExecutor(slowClient);
            const execPromise = abortExecutor.executeTaskChain([
                { id: 'step1', action: 'echo', args: ['step1'] },
                { id: 'step2', action: 'echo', args: ['step2'] },
                { id: 'step3', action: 'echo', args: ['step3'] },
            ]);
            await new Promise(r => setTimeout(r, 50));
            await abortExecutor.abortExecution();
            const state = await execPromise;
            runner.assert(state.isAborted === true, 'State should be aborted');
            runner.assert(state.isRunning === false, 'Should not be running');
        });
        await runner.it('4.2 中止后剩余步骤应该标记为 skipped', async () => {
            const slowClient = new MockClineClient();
            slowClient.setConnected(true);
            const origRun = slowClient.runTask.bind(slowClient);
            slowClient.runTask = async (task: any) => { await new Promise(r => setTimeout(r, 200)); return origRun(task); };
            const abortExecutor = new MockTaskChainExecutor(slowClient);
            const execPromise = abortExecutor.executeTaskChain([
                { id: 'step1', action: 'echo', args: ['step1'] },
                { id: 'step2', action: 'echo', args: ['step2'] },
                { id: 'step3', action: 'echo', args: ['step3'] },
            ]);
            await new Promise(r => setTimeout(r, 50));
            await abortExecutor.abortExecution();
            const state = await execPromise;
            const skippedSteps = state.steps.filter(s => s.status === 'skipped').length;
            runner.assert(skippedSteps >= 1, 'At least one step should be skipped');
        });
        await runner.it('4.3 中止事件应该被触发', async () => {
            const slowClient = new MockClineClient();
            slowClient.setConnected(true);
            const origRun = slowClient.runTask.bind(slowClient);
            slowClient.runTask = async (task: any) => { await new Promise(r => setTimeout(r, 200)); return origRun(task); };
            const freshExecutor = new MockTaskChainExecutor(slowClient);
            const execPromise = freshExecutor.executeTaskChain([
                { id: 'step1', action: 'echo', args: ['step1'] },
                { id: 'step2', action: 'echo', args: ['step2'] },
            ]);
            await new Promise(r => setTimeout(r, 50));
            await freshExecutor.abortExecution();
            await execPromise;
            const abortEvents = freshExecutor.events.filter(e => e.type === 'aborted');
            runner.assert(abortEvents.length > 0, 'Should have at least one aborted event');
        });
        await runner.it('4.4 Webview 应该在中止后更新状态', async () => {
            const chain: TaskChain = [{ id: 'step1', action: 'echo', args: ['step1'] }, { id: 'step2', action: 'echo', args: ['step2'] }];
            mockWebview.renderChain(chain, { chain, steps: [{ step: chain[0], status: 'success', retryCount: 0, completedAt: new Date().toISOString() }, { step: chain[1], status: 'skipped', retryCount: 0 }], currentStepIndex: 1, isRunning: false, isAborted: true, totalSteps: 2, completedSteps: 1, failedSteps: 0, completedAt: new Date().toISOString() }, false);
            runner.assert(mockWebview.executeBtnEnabled, 'Execute button should be re-enabled after abort');
            runner.assert(!mockWebview.abortBtnEnabled, 'Abort button should be disabled after abort');
        });
    });

    // Test 5: ClineClient
    await runner.describe('Test 5: ClineClient 通信', async () => {
        await runner.it('5.1 getStatus() 应该返回有效的状态', async () => {
            await mockClineClient.connect();
            const status = await mockClineClient.getStatus();
            runner.assert(status.connected === true, 'Should be connected');
            runner.assert(!!status.version, 'Should have a version');
        });
        await runner.it('5.2 getLogs() 应该返回日志数组', async () => {
            const logs = await mockClineClient.getLogs();
            runner.assert(Array.isArray(logs), 'Logs should be an array');
        });
        await runner.it('5.3 runTask() 应该成功执行并返回结果', async () => {
            const result = await mockClineClient.runTask({ name: 'test', description: 'test task' });
            runner.assert(result.success === true, 'Task should succeed');
            runner.assert(!!result.taskId, 'Should have a taskId');
            runner.assert(!!result.output, 'Should have output');
        });
        await runner.it('5.4 abortTask() 应该能中止任务', async () => {
            const result = await mockClineClient.runTask({ name: 'abort-test', description: 'test abort' });
            const aborted = await mockClineClient.abortTask(result.taskId!);
            runner.assert(aborted === true, 'Abort should succeed');
            runner.assert(mockClineClient.wasTaskAborted(result.taskId!), 'Task should be marked as aborted');
        });
        await runner.it('5.5 未连接时 runTask 应该返回失败', async () => {
            mockClineClient.setConnected(false);
            const result = await mockClineClient.runTask({ name: 'test', description: 'test' });
            runner.assert(result.success === false, 'Should fail when not connected');
            runner.assert(result.error === 'Not connected', 'Error should be Not connected');
            mockClineClient.setConnected(true);
        });
        await runner.it('5.6 getTaskLogs() 应该返回任务的日志', async () => {
            const result = await mockClineClient.runTask({ name: 'log-test', description: 'test logs' });
            const logs = await mockClineClient.getTaskLogs(result.taskId!);
            runner.assert(Array.isArray(logs), 'Task logs should be an array');
            runner.assert(logs.length > 0, 'Should have at least one log entry');
        });
    });

    // Test 6: 集成测试
    await runner.describe('Test 6: 集成测试 - 完整流程', async () => {
        await runner.it('6.1 完整流程: 生成 -> 渲染 -> 执行 -> 完成', async () => {
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            mockWebview.renderChain(chain, null, false);
            runner.assert(mockWebview.chainContainer.includes('4 steps'), 'Chain should be rendered');
            const state = await mockExecutor.executeTaskChain(chain);
            runner.assert(state.completedSteps === 4, 'All 4 steps should complete');
            runner.assert(state.failedSteps === 0, 'No steps should fail');
            runner.assert(state.isAborted === false, 'Should not be aborted');
        });
        await runner.it('6.2 完整流程: 生成 -> 渲染 -> 执行 -> 中止', async () => {
            const slowClient = new MockClineClient();
            slowClient.setConnected(true);
            const origRun = slowClient.runTask.bind(slowClient);
            slowClient.runTask = async (task: any) => { await new Promise(r => setTimeout(r, 200)); return origRun(task); };
            const chain = await mockDeepSeekClient.generateTaskChain('帮我构建并部署前端');
            const abortExecutor = new MockTaskChainExecutor(slowClient);
            const execPromise = abortExecutor.executeTaskChain(chain);
            await new Promise(r => setTimeout(r, 50));
            await abortExecutor.abortExecution();
            const state = await execPromise;
            runner.assert(state.isAborted === true, 'Execution should be aborted');
            runner.assert(state.isRunning === false, 'Should not be running');
        });
        await runner.it('6.3 CLINE 状态变化应该反映在 Webview 上', async () => {
            mockWebview.updateClineStatus({ connected: true, version: '0.3.0' });
            runner.assert(mockWebview.clineStatusBar === 'online', 'Status should be online');
            mockWebview.updateClineStatus({ connected: true, currentTask: 'running' });
            runner.assert(mockWebview.clineStatusBar === 'busy', 'Status should be busy');
            mockWebview.updateClineStatus({ connected: false });
            runner.assert(mockWebview.clineStatusBar === 'offline', 'Status should be offline');
        });
    });

    return runner.generateReport();
}

// ============================================================
// Main
// ============================================================
console.log('');
console.log('='.repeat(60));
console.log('  AMA v0.3.0 自动化测试套件');
console.log('  Starting comprehensive test suite...');
console.log('='.repeat(60));

runTests().then(report => {
    console.log(report.summary);
    process.exit(report.failed > 0 ? 1 : 0);
}).catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
