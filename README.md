# AMA（AI Messenger Agent）

AMA 是 Maneki‑AI 体系中的 **MSSAGENT 本地实现版本**。

它充当高级 AI 总监与各类 Worker（如 CLINE）之间的桥梁，负责任务调度、分发与反馈。

---

## 🚀 项目定位

- **角色**：AI 工厂的中间层（Task Orchestrator）
- **目标**：让 Maneki‑AI 能够自动指挥本地 CLINE Worker 执行任务
- **形态**：VS Code 插件 + 后端守护进程

---

---

## ⚙️ 功能目标（MVP）

1. 接收来自 Maneki‑AI 的任务指令
2. 将任务转发给 CLINE 执行
3. 监听 CLINE 输出并回传结果
4. 支持 MCP 通信协议
5. 提供基础日志与状态监控

---

## 🧩 后续扩展

- 多 Worker 并行调度
- 云端 Worker 接入
- 任务分片与重试机制
- 与 Maneki‑AI HQ 的 API 同步

---

## 🧱 技术栈

- Node.js / Python（任选其一）
- VS Code Extension API
- WebSocket / HTTP 通信
- JSON 任务协议

---

## 🧭 开发阶段

当前阶段：**插件开发中（由 CLINE 执行）**
下一阶段：实现 MCP 通信与任务调度逻辑。

---

## 📄 许可证

MIT License（可根据商业计划调整）

---

## 🧠 架构概览

- **AI 总监**：负责理解与拆解任务
- **AMA**：负责调度与分发任务
- **CLINE / Worker**：负责执行与回传结果

---

## 📦 目录结构（建议）


