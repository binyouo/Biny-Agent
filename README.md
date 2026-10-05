# Biny

**本地优先、记忆优先的开发协作 Agent，提供 macOS Desktop、TUI 与 CLI。**

Biny 帮你在本地项目中对话、处理开发任务，并把会话和记忆带到后续工作中。Desktop、TUI 与 CLI 的交互式任务共用本机 Runtime Host 和 AgentSession；模型由你配置，能力可通过 MCP、插件与 Skills 扩展。

[GitHub](https://github.com/binyouo/Biny-Agent) · [Issues](https://github.com/binyouo/Biny-Agent/issues) · [架构源码](src/runtime) · [Agent 与会话源码](src/agent)

## 架构

![Biny 架构总览](architecture-panels/assets/overview.png)

Desktop、TUI 与 CLI chat 共用本机 Runtime Host；`biny run` 是一次性任务入口，复用 AgentSession 执行核心。会话与记忆保存在本机。

上图是运行态总览：包在链路上流动、日志在滚、计数在涨，画的是「系统跑起来的样子」而不是静态分层。同一套图另有 8 张细分，覆盖 Agent 内核与工具循环、人格层、长任务执行、记忆与 Activity、会话存储与恢复、模型与扩展、调度 / 浏览器 / 钩子，源码见 [`architecture-panels/`](architecture-panels)，产物在 `architecture-panels/out/`（每张 mp4 + 可在浏览器自行循环的实时页面）。图中动画计数为示意值，不是真实遥测。

<details>
<summary>同一架构的文本版（分层关系、便于搜索与 diff）</summary>

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

</details>

## 核心能力

| 能力 | Biny 提供 |
| --- | --- |
| 多端交互 | macOS Desktop、终端 TUI 与 CLI chat；`biny run` 支持脚本化的一次性任务。 |
| 交互式可视化 | Desktop 聊天内流式生成 HTML/SVG widget，支持滑块、按钮和动态计算；`biny widget --html fragment.html --title "可视化" --out widget.html` 可生成独立页面，支持 `--json`。 |
| 多层记忆 | 结合会话历史、项目上下文、临时与长期记忆，以及可检索的 Desktop Activity 线索；Sleep 周期会整理记忆、归档过期记忆并合并重复信息。 |
| Activity Recorder | 记录桌面活动与 OCR 线索，支持回看、检索和生成活动摘要；新对话页提供近期活动建议，点击可直接开始对话；可从 Desktop 设置中暂停记录。 |
| 长任务执行 | 持久化 TaskRun 与 attempt 状态，支持 worker 检查点续跑、重试决策和任务完成后的验证。 |
| 模型与扩展 | 接入多家模型服务商和 OpenAI-compatible 接口；通过 MCP、Plugins、Skills、Subagents 扩展工具与工作流。 |
| 工具与操作控制 | 提供项目文件操作、受控命令和权限审批；Desktop 还可选 Computer Use 来观察桌面并操作指定窗口；通过独立的严格应用审批开关和跨会话应用授权名单控制访问。 |

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

Computer Use 应用授权在 Desktop「设置 → Computer Use」中管理。严格审批默认关闭，首次使用应用时自动保存授权；开启后只允许已批准的应用，不受全局工具自动批准覆盖。CLI 可用 `biny computer status --json` 查看记录，`biny computer strict on` 开启严格模式，`biny computer approve <bundle-id>` 批准已发现的应用，`biny computer revoke <bundle-id>` 撤销授权。


按窗口实时镜像可用 `biny cu windows <pid> --json` 查到窗口 ID，再运行 `biny cu pip open <window-id> --pid <pid> --json`；加 `--on-minimize` 后在源窗口最小化时显示。`biny cu pip list --json` 返回会话及帧龄，`biny cu pip close --all --json` 关闭并解除监听。内置工具 `ComputerMirror` 沿用应用审批。Desktop 浏览器和电脑画面共享 PiP，可切换来源、关闭单项及返回聊天；默认开启，开关和窗口布局跨重启保存。操作日志按需开启，仅保存本地动作元数据。

`biny cu type_text "ABC" --pid <pid> --input-method physical` 按当前键盘布局输入；布局无法表示的字符会在输入前拒绝。Desktop「设置 → Appshots」可选择双击修饰键或组合快捷键，将当前应用窗口加入当前或新聊天草稿；不依赖电脑历史开启，发送前不请求模型。权限失败可在此测试与重试，敏感应用不可截图。

外部 MCP 默认 `biny computer mcp`（stdio）；`biny computer mcp --http --port 0` 提供本地 HTTP 入口并输出 `url` 与 `tokenPath`。客户端从私有令牌文件读取 token，使用 `Authorization: Bearer <token>`。退出删除令牌。外部 MCP 共用全局桌面控制开关、应用审批及可选操作日志；输入前需观察精确目标，Desktop 运行时通知统一 PiP。`biny cu` 仍是用户显式调用的直接原生入口。
