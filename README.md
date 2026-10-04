# Biny

**本地优先、记忆优先的开发协作 Agent，提供 macOS Desktop、TUI 与 CLI。**

Biny 帮你在本地项目中对话、处理开发任务，并把会话和记忆带到后续工作中。Desktop、TUI 与 CLI 的交互式任务共用本机 Runtime Host 和 AgentSession；模型由你配置，能力可通过 MCP、插件与 Skills 扩展。

[GitHub](https://github.com/binyouo/Biny-Agent) · [Issues](https://github.com/binyouo/Biny-Agent/issues) · [架构源码](src/runtime) · [Agent 与会话源码](src/agent)

## 架构

```mermaid
flowchart LR
  subgraph UI[交互入口]
    Desktop[macOS Desktop<br/>Electron UI]
    TUI[TUI / CLI chat]
  end

  Desktop -->|Electron IPC| Main[Electron 主进程]
  Main -->|Unix domain socket| Host[本机 Runtime Host]
  TUI -->|Unix domain socket| Host

  Host --> Runtime[InteractiveAgentRuntime]
  Runtime --> Session[AgentSession<br/>共用执行实现]
  Session --> Provider[模型 Provider]
  Session --> Tools[工具与扩展]
  Session --> Policy[权限与工作区策略]
  Session --> State[本地会话、记忆与索引]

  Run[CLI biny run<br/>一次性任务] --> Exec[CommandRuntime / ExecutionService]
  Exec --> Session

  Tools --> Builtin[内置工具]
  Tools --> MCP[MCP]
  Tools --> Skills[Skills / Plugins / Subagents]
```

Desktop、TUI 与 CLI chat 共用本机 Runtime Host；`biny run` 是一次性任务入口，复用 AgentSession 执行核心。会话与记忆保存在本机。

## 核心能力

| 能力 | Biny 提供 |
| --- | --- |
| 多端交互 | macOS Desktop、终端 TUI 与 CLI chat；`biny run` 支持脚本化的一次性任务。 |
| 交互式可视化 | Desktop 聊天内流式生成 HTML/SVG widget，支持滑块、按钮和动态计算；`biny widget --html fragment.html --title "可视化" --out widget.html` 可生成独立页面，支持 `--json`。 |
| 多层记忆 | 结合会话历史、项目上下文、临时与长期记忆，以及可检索的 Desktop Activity 线索；Sleep 周期会整理记忆、归档过期记忆并合并重复信息。 |
| Activity Recorder | 记录桌面活动与 OCR 线索，支持回看、检索和生成活动摘要；新对话页提供近期活动建议，点击可直接开始对话；可从 Desktop 设置中暂停记录。 |
| 长任务执行 | 持久化 TaskRun 与 attempt 状态，支持 worker 检查点续跑、重试决策和任务完成后的验证。 |
| 模型与扩展 | 接入多家模型服务商和 OpenAI-compatible 接口；通过 MCP、Plugins、Skills、Subagents 扩展工具与工作流。 |
| 工具与操作控制 | 提供项目文件操作、受控命令和权限审批；Desktop 还可选 Computer Use 来观察桌面并操作指定窗口。 |

### Shell 输出与归档

`Bash` 发给模型的 stdout / stderr 分别展示，但共用 12 KiB UTF-8 正文预算（包含省略标记，并非 token 预算）；超出时保留头尾，并分别报告捕获阶段与模型投影阶段的丢失。`BashOutput` 的单页正文使用同一模型预算，原有后台日志分页位置不变。JSON 包装和元数据另计，回合总预算仍独立生效。

被折叠的结果复用受限的工具归档，模型可用 `read_tool_result` 按 `nextOffset` 分页补读。归档保存打码后的完整**已捕获结果**；超出前台命令原有每流 8 MiB 捕获硬上限而丢失的字节无法恢复。归档继续受每文件 64 MiB 与最近 512 份保留策略约束；写入失败会明确报告无可回读引用，不把大段原文重新塞进模型上下文。Code Mode 查询仍在自身 bridge / result 限额内拿到程序化结果，不提前套用该 12 KiB 模型展示预算。

## 快速开始

需要 Node.js 与 pnpm `10.6.5`。克隆仓库并初始化：

```bash
git clone https://github.com/binyouo/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

完成模型配置后，启动终端对话或 Desktop：

```bash
pnpm dev -- chat
pnpm desktop:dev
```

CLI 帮助：`pnpm dev -- --help`。

Desktop 的“设置 → 技能”优先展示内置技能，并可关闭自动技能提取或调整调用阈值。自动提取会额外调用模型，把可复用流程直接保存为全局技能；修改设置后需点击“保存”。

## 继续了解

- [Agent 执行与 Runtime](src/agent) · [Host 实现](src/runtime/host)
- [会话存储](src/session) · [长期记忆与上下文](src/agent/context)
- [工具与扩展](src/extensions) · [权限策略](src/permission) · [工具实现](src/tools)
- [问题反馈与功能请求](https://github.com/binyouo/Biny-Agent/issues)
