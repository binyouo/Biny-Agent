# MCP、Skills 与插件

Biny 提供三类扩展机制：
- **MCP（Model Context Protocol）**：连接外部协议服务，提供专属工具、资源（Resources）与提示词模板（Prompts）。
- **Skills（技能包）**：以标准 Markdown 与资源目录提供特定任务的操作规程与最佳实践。
- **Plugins（插件）**：以 JavaScript 代码在应用内注册服务商、工具、生命周期钩子与配置项。

## 工具目录与自动选择

工具目录列出系统已注册的全部能力。“内置”表示其代码来源，并不代表每次请求都会向大模型全量发送所有工具声明。

- **动态匹配与自动选择**：在自动模式下，系统先保留基础核心工具，再由工具模型依据当前任务上下文动态挑选所需工具；可选工具覆盖内置工具、MCP、插件与技能。
- **配套工具自动补齐**：当选中某一工具时，系统会自动携带其必要的管理工具：
  * `Bash` 自动配套 `ProcessStatus` 与 `KillShell`；
  * `Task` 自动配套 `TaskStatus`；
  * `WebSearch` 与 `WebFetch` 自动成对提供；
  * `WidgetRenderer` 自动配套 `WidgetReadme`。
- **文件检索工具**：
  * **Glob（查找文件）**：按路径通配符匹配文件名（例如 `src/**/*.ts`）。
  * **Grep（文件内容搜索）**：内置预编译的 ripgrep，开箱即用。默认按纯文本字面匹配；设置 `mode: "regex"` 时使用 Rust 正则语法。查询限制单行 64 KiB 内，单批扫描限时 10 秒、输出上限 8 MiB。

## Code Mode 工具编排

Biny 默认启用 Code Mode（`agent.toolExecutionMode: "code_mode"`），允许大模型编写简短的 JavaScript 或 TypeScript 脚本对多个工具进行循环、条件分支与聚合调用：

### 核心机制与沙箱限制

- **`run_script` 运行环境**：基于 QuickJS 轻量沙箱执行，不提供 Node.js 宿主内置模块。支持 `language: "typescript"` 先编译后执行。
- **内置辅助方法**：
  * `tools.<name>(args)`：直接调用当前已准入的底层工具。
  * `sh(command, {cwd, timeoutMs})`：在 Shell 权限链内执行命令并获取 stdout 文本。
  * `fetch(url)`：发起基础 GET 请求读取文本或 JSON。
  * `console.log/info/warn/error`：输出由宿主独立通道收集（单段脚本上限 1 MiB / 4,096 个片段；超限标记截断）。
- **输出裁剪与结果归档**：脚本 stdout 超过 16,000 代码单元时，经脱敏自动保存至本地结果归档，仅向模型返回前 16,000 字符预览及 `Read` 归档引用。
- **并发与错误处理**：脚本内同时在途的工具子调用最多 8 个；支持使用 `try/catch` 捕获参数错误或可重试的只读异常，但权限拒绝或超时会强制阻断后续执行。

### 目录发现与协议适配

脚本可在运行时按需探测可用工具，避免主提示词冗余：
- `searchTools(query, {limit, namespace})`：按语义或名称检索工具定义，返回工具参数 Schema 数组（默认最多 8 项，上限 20 项）。
- `describeTool(name)`：查询具体工具的完整参数与返回 Schema。
- `describeNamespace(name)`：获取指定命名空间下的工具集。

针对支持原生工具搜索的协议（如 OpenAI Responses 系列），系统通过 `tool_search_output` 动态挂载 Schema；针对 Claude 系列通过 `defer_loading` 延迟加载，保障模型上下文简洁高效。

## 工具结果优化与统计

### RTK 命令输出智能压缩

Desktop 内置 **RTK (0.29.0)**，对高频命令行输出进行智能语义压缩（配置项 `agent.rtkEnabled` 默认开启）：
- **适配命令**：自动改写常见的前台命令输出，包括 `git status/diff/log`、`pnpm test/build/lint`、`npm`、`cargo`、`rg/grep`、`ls/tree`、`cat`、`docker` 等。
- **安全性**：复杂 Shell 管道、重定向、复杂表达式或带环境别名的命令自动保持原样执行，不进行有损改写。
- **Token 节省看板**：在 Desktop「设置 → Token 节省」中直观呈现累计 PTC（程序化调用）与 RTK 压缩节省的 Token 走势、近 30 天每日趋势及各命令分布。

## 本地管理命令

记忆检索、待办管理、任务状态与技能安装等操作已直接复用 CLI，不再注册多余的虚拟辅助工具。模型或脚本可直接通过 `Bash` 调用：

| 任务场景 | 常用 CLI 命令 | 说明 |
| --- | --- | --- |
| **检索长期记忆** | `biny memory search "查询" --json` | 支持相似度阈值与标签筛选。 |
| **保存新事实** | `biny memory add "事实" --json` | 结构化录入支持 `--entry`。 |
| **搜索历史对话** | `biny history search "关键词" --json` | 跨项目全局历史检索。 |
| **技能检索与安装** | `biny skill search "能力" --json` | 安装：`biny skill install <仓库地址>`。 |
| **会话目标管理** | `biny goal show --json` | 调整：`biny goal update --input '<JSON>'`。 |
| **任务清单（Todo）** | `biny todo show --json` | 替换：`biny todo replace --todos '<JSON数组>'`。 |
| **交互式向用户提问** | `biny input ask "问题内容"` | Desktop 渲染提问卡片，等待用户作答。 |
| **查看与回答问题** | `biny input list --session <id>` | 提交：`biny input answer <callId> --text "回答"`。 |
| **子任务管理** | `biny task inspect <id> --json` | 补充上下文：`biny task message <id> "内容"`。 |

## 工具名称与用户展示

- **稳定标识**：底层注册名（如 `Read`、`Write`、`Bash`）作为持久化与权限审计的稳定唯一标识。
- **友好界面名称**：在 Desktop 界面中，对应呈现为直观的中文名称（如“读取文件”、“写入文件”、“执行终端命令”）。未提供本地化名称的第三方 MCP 工具保留其原名。

## MCP

在 Desktop「设置 → MCP」或全局配置的 `extensions.mcp` 中配置外部服务：

```json
{
  "extensions": {
    "mcp": {
      "local-service": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/server.mjs"],
        "enabled": true
      },
      "remote-service": {
        "type": "http",
        "url": "https://mcp.example.test/mcp",
        "transportProtocol": "streamable-http",
        "enabled": true
      }
    }
  }
}
```

### 连接特性与超时

- **通信模式**：支持标准输入输出（`stdio`）及远程 HTTP / SSE 服务（`streamable-http`）。
- **同源重定向限制**：HTTP / SSE 请求严格限定仅跟随同源重定向，跨源重定向直接报错，防止凭据泄露。
- **超时与进度**：
  * `startupTimeoutMs`：服务启动总预算（连接、握手、初始目录拉取），默认 30,000 毫秒（30 秒）。
  * `timeoutMs`：单次工具请求超时，默认 60,000 毫秒（60 秒），收到协议进度通知时重新计时。
- **目录缓存与重连**：成功连接的工具目录在本地保留最多 30 分钟缓存；服务短暂断线时保留最后有效目录供查询发现，实际执行时发起重连核对最新定义。

## Skills

Skill 是一套自包含的任务操作指引，存放在包含 `SKILL.md` 的独立目录中：

```yaml
---
name: project-review
description: 检查当前项目的构建入口与模块依赖。
always-inject: true
---
## 执行步骤
1. 检查 package.json
2. 运行类型检查
```

### 发现与加载机制

- **存放路径**：
  * 项目级：`.biny/skills/` 与 `.agents/skills/`；
  * 全局级：`~/.config/biny/skills/`；
  * 内置级：随安装包内置的核心技能。
  * 优先级：**项目级 > 全局级 > 内置级**。
- **调用方式**：
  * 终端 TUI 输入 `/skills` 唤出搜索面板，或输入 `/skill:<名称>` 快捷补全。
  * `always-inject: true`：声明常驻技能，其名称与简介会自动进入每个交互回合的候选清单；正文仍由模型按需调用 `Skill` 工具加载。
  * 附属资源（如参考文档、脚本）通过 `read_skill_resource` 按相对路径读取。

### 核心内置技能列表

| 技能名称 | 核心用途与安全边界 |
| --- | --- |
| `skill-hub` / `skill-search` | 检索、安装与管理技能，安装前核对依赖与格式要求。 |
| `file-manager` | 文件分类整理、移动与归档；执行覆盖与删除时遵守工作区权限。 |
| `system-info` | 只读检查操作系统、内存、磁盘、端口与进程状态，不执行修改。 |
| `notebook` | 读取与编辑 `.ipynb` 单元格，修改代码时自动清除旧输出。 |
| `web-search` | 使用 `WebSearch` 搜索互联网公开资料并溯源核实。 |
| `web-fetch` | 使用 `WebFetch` 抓取并解析目标网页的正文内容。 |
| `image-gen` | 调用 `biny image` 进行多模态生图与修改。 |

### 管理命令

```bash
biny skill list --json
biny skill search "性能优化" --json
biny skill create <skill-name> --file ./SKILL.md
biny skill install <owner/repository>
biny skill update <skill-name>
biny skill uninstall <skill-name>
```

- **规范校验**：技能名称限 1–64 位小写字母、数字和连字符；描述上限 1,024 字符；`SKILL.md` 的 YAML frontmatter 须完整位于前 64 KiB 内，单文件上限 512 KiB。
- **自动技能提炼**：开启后，后台模型在多轮成功对话后会自动提炼高频复用的操作流程，并沉淀为受管新技能。

## Plugins

Plugin 支持在应用生命周期中注入自定义能力：
- **配置文件**：项目级在 `extensions.plugins` 中声明，全局级在 `extensions.globalPlugins` 中声明。
- **执行环境**：插件 JavaScript 直接在 Biny 进程中加载运行，能够注入 Provider、自定义工具及回合前后的上下文回调。启用前应核实插件来源的安全可靠性。
- **用户配置表单**：插件可在根目录 `biny-plugin.json` 中定义配置项 Schema，Desktop 插件面板会自动呈现配置表单。

### Nowledge Mem 记忆同步插件

`plugins/nowledge-mem` 提供与外部 Nowledge Mem 服务的无缝同步：新消息到来时自动检索外部相关记忆作为上下文背景；成功交互后将可见对话内容同步沉淀至外部服务。

## 子代理

Biny 支持将复杂任务分派给独立的子代理（Subagent）并行或异步处理。

### 具名子代理定义

子代理配置文件为 Markdown 文档，存放在 `.biny/agents/<name>.md`（项目级）或 `~/.config/biny/agents/`（全局）：

```markdown
---
name: coder
description: 专注处理具体代码实现与测试
runtime: builtin
model: deepseek-v4-flash
isolation: worktree
---
请根据分配的任务修改代码，并在交付前完成测试验证，报告实际改动与未验证项。
```

- **`runtime` 执行后端**：
  * `builtin`：使用 Biny 内置 Agent 循环（默认）。
  * `auto`：优先尝试本机已安装的 `claude-code` CLI，未安装时回退至 `builtin`。
  * `claude-code`：使用本地安装的 Claude Code CLI（`claude -p`）。
  * `codex`：使用本地安装的 Codex CLI（`codex exec`）。
  * `acp`：通过 ACP 协议连接外部独立 Agent。
- **`isolation: worktree`（Git 工作树隔离）**：开启后自动从父工作区已提交的 HEAD 检出独立的 Git worktree 执行修改，不污染主工作区未提交的文件；任务成功且无实际改动时自动回收，发生修改或失败时完整保留目录供人工审查。

### 执行与交互管理

```bash
biny task create "修复单元测试并在独立工作树验证" --agent coder --json
biny task run <taskRunId> --json
biny task inspect <taskRunId> --session <sessionId> --json
biny task message <taskRunId> "补充说明：注意兼容 Node 18" --session <sessionId>
biny task continue <taskRunId> "后续任务：补充文档" --session <sessionId>
```

- **父子会话与通信隔离**：子代理在专属子会话中独立运行，父代理仅接收阶段性完成报告与通知（单次通知限 2,000 字符，总上限 6,000 字符），防止海量子任务输出挤爆父会话上下文。
- **权限安全边界**：外部 Worker（如 Claude Code CLI 或 Codex）要求父会话为 `full-access` 模式，不执行 Biny 的逐次弹窗确认与路径拒绝规则；强隔离环境建议使用容器或只读隔离任务。
- **状态看板**：Desktop 对话中以独立卡片呈现子代理任务，支持展开查看实时思考、工具调用与日志输出滚动。

配置规范见 [schema.ts](../src/config/schema.ts)。运行实现：[MCP](../src/extensions/mcp.ts)、[Skills](../src/extensions/skills.ts)、[Plugins](../src/extensions/plugins.ts)。
