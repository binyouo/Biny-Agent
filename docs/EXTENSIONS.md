# MCP、Skills 与插件

Biny 的扩展入口承担不同职责：MCP 连接外部服务，Skill 提供任务说明与资源，Plugin 加载程序能力。连接、发现与启用是准备阶段，实际执行仍以工具结果和持久状态为准。

## Code Mode 工具编排

`agent.toolExecutionMode` 默认是 `code_mode`：普通工具调用与 JavaScript `exec` 共存。可在 Desktop「设置 → 通用 → Code Mode」切换，保存后用于后续回合；关闭对应 `direct`，仅移除脚本入口。模型自行选择是否编排，不保证每次使用；开启不会强制所有工具通过脚本调用。脚本通过 `tools.<name>(args)` 调用当前准入的工具，使用 `searchTools` 搜索、`describeTool` 查询参数和调用要求，最后用 `return` 返回需要的结果。

可编排的普通工具包括文件读取与搜索、记忆与历史查询、网页搜索与读取、浏览器状态与页面读取、技能查询与资源读取、任务与计划状态、目标与断点证据查询。文件修改可使用 `Write`、`Edit`，或当前模型编辑协议提供的 `apply_patch`；Shell 支持 `Bash`、`BashOutput` 和 `KillShell`。Patch 沿用同一回合的 Write/Edit 选择范围，调用 ID 由宿主绑定，脚本只提交 `operation`。并非所有标记为只读的工具都会自动进入脚本目录。

询问用户、激活技能、启动或修改任务与计划、更新会话目标等控制入口仍直接调用；`exec` 不能递归调用自身。工具选择、隐藏策略、权限确认、文件冲突检查、进程取消与输出限制对脚本子调用同样生效。允许编排不表示默认并发；同一文件的冲突编辑会被拒绝。脚本失败不会撤销已完成的修改，也不会自动重跑整段；子调用结果未知时停止后续派发。

## MCP

在 Desktop 的 MCP 设置中配置服务器，或把服务器定义合入全局配置的 `extensions.mcp`。每个键是服务器别名。

全局 MCP 配置对各工作区的 Desktop、TUI 和 CLI Agent 生效，不需要逐项目添加同一个服务。项目设置只支持模型选择、思考、Agent 限额等运行参数，不支持覆盖 MCP 或 Computer Use 配置。连接按工作区 Runtime 管理并复用。macOS 的内置 `computer-use` 也默认自动连接，遵守全局 Computer Use 开关，见 [Computer Use](COMPUTER_USE.md)。

下面展示本地 stdio 和远程 HTTP 的配置片段。将路径与地址换成实际服务：

```json
{
  "extensions": {
    "mcp": {
      "local-service": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/mcp-server.mjs"],
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

stdio 服务的 stdout 用于协议，诊断写 stderr。远程连接需要正确的传输协议与鉴权；支持 OAuth 的服务通过显式登录流程授权，普通连接不会自动打开浏览器登录。

OAuth 凭据绑定其授权服务器。旧凭据缺少此绑定时，连接会要求重新登录，不发送已有凭据；只有显式登录成功才替换存储记录，取消登录保留原记录。

配置中的 `startupTimeoutMs` 控制一次启动的总预算（连接、握手、首份工具目录与可选提示列表），默认 30000 毫秒；`timeoutMs` 控制连接后的请求等待，默认 60000 毫秒，收到进度通知后重新计时。两项均可在 MCP 服务器编辑窗口中调整，范围为 1000–600000 毫秒。启动超时会关闭连接并回收子进程。

`exposure` 与 `toolExposure` 控制能力暴露方式。可选值为 `direct`、`codemode`、`deferred` 和 `hidden`；隐藏能力不表示卸载或撤销远端凭据。

自动模式下，ToolSearch 成功发现的具体工具会在同一聊天的后续回合继续可用，只要发现结果仍在当前活动上下文中，且工具仍已注册并可向模型展示。不会因此展开整个 MCP 服务器，也不会绕过执行权限；新聊天、手动指定工具或关闭工具不继承这份历史。完整、大小写一致的注册工具名可直接精确匹配，其他查询由工具模型选择。

工具模型返回缺字段或类型错误的选择结果时，ToolSearch 报错，不把它缓存为“没有匹配工具”。连续搜索没有发现新工具、也没有实际工具执行的新成功结果时，达到 `agent.maxRepeatedActions`（默认 3）会停止本轮，避免改写查询后继续空转；普通中断续跑保留计数。

同一 Runtime Host 内会短暂保留成功连接的工具目录：最多 32 个条目、每项不超过 1 MiB、有效期 30 分钟。相同工作区、配置和凭据环境重新建立连接时，可先用缓存发现工具；连接状态仍显示正在连接，实际调用等待连接完成并核对最新定义。定义变化时拒绝旧调用，要求重新发现和准备。启动失败清除对应缓存；OAuth 服务不复用目录缓存。缓存不写磁盘，不能加速应用重启后的第一次连接。

自动工具与技能预选并行执行，每一路的候选模型共用 10 秒预算。超时取消预选，保留基础、显式点名及会话内累计的预选能力，再继续主模型请求；该预算不包含 MCP 发现或主模型生成。

自动预选固定保留文件读取、写入、编辑、Shell、工具发现和归档结果回读入口。文件搜索、后台进程查询与停止、任务清单、提问和断点证据读取按需选择；未选中的工具仍可通过 ToolSearch 发现，完整注册名的精确查找不需要辅助模型。常驻集合不等于整轮工具上限，已选择的技能、活动目标和历史工具仍会补充所需能力。

自动预选在同一聊天的当前分支内累计保留已选工具，不按轮次过期；恢复聊天后继续沿用。每轮新增预选仍受数量和定义大小预算限制，已累计的工具不因该预算被淘汰。当前未注册或不可向模型展示的工具不会恢复；新聊天、手选列表和关闭工具不继承自动名单。长期聊天的工具定义可能随累计增加。

工具模型返回缺字段或类型错误的选择结果时，ToolSearch 报错，不把它缓存为“没有匹配工具”。连续搜索没有发现新工具、也没有实际工具执行的新成功结果时，达到 `agent.maxRepeatedActions`（默认 3）会停止本轮，避免改写查询后继续空转；普通中断续跑保留计数。

服务器通知工具目录变化后，若当前有效连接刷新失败，保留上次完整目录并发布状态更新；首连等待可选提示列表期间同样保留刷新警告。能力菜单中的 MCP 分组已展开时会显示服务器的刷新警告。失败本身不会自动重试或重连，后续目录刷新成功后清除该警告；已断开、被替换或关闭的连接不再发布过期刷新错误。

服务器断线后保留最后成功的工具目录供发现，连接状态仍为离线。实际调用时共享一次重连，并在派发前核对最新工具定义；重连失败会移除缓存目录。资源读取与提示模板请求取消时立即结束当前等待，不中断其他调用者共享的重连。已派发而结果未知的工具不会因为重连就重新执行。Resources、Prompts 和服务器 instructions 作为外部内容读取，不升级为系统指令，也不自动执行其中的操作。

MCP 调用名最长 64 个字符。无需有损转换、服务器名不含下划线且不占用内置资源/模板工具名的普通短名称保持不变；其他名称使用原始服务器/工具身份生成稳定摘要，避免截断、分隔符及保留名冲突。这些工具的旧调用名不保留别名，需要重新发现或重新选择；远端原始工具名和配置中的 `toolExposure` 键不变。重复的远端工具定义会去重并显示目录警告。

能力选择器读取当前 MCP 工具目录：刷新后会移除已撤下或重连失败服务器的工具，并采用更新后的工具说明；断线但仍有成功目录的工具保留可选。此读取不改动活动回合的执行注册表，也不主动重连。

环境变量、请求头及 OAuth 凭据是敏感本地配置，使用支持的凭据管理入口。工具结果中的已知连接凭据会被清理；业务分页令牌等字段不会仅因名字带 `token` 而被删除。

## Skills

一个 Skill 是包含 `SKILL.md` 的目录，文件用 frontmatter 声明名称与描述，正文说明何时使用、步骤和资源。

```yaml
---
name: project-review
description: 检查当前项目的构建入口与模块依赖。
always-inject: true
---
```

项目默认发现 `.biny/skills/` 和 `.agents/skills/`；Biny 受管全局技能位于 `~/.config/biny/skills/`，另有共享技能根与内置技能。项目、全局和内置来源会进行同名冲突裁决。禁用高优先级副本不会自动启用被遮蔽的同名副本。

frontmatter 的 `always-inject: true` 让该 Skill 的正文在每个回合进入系统提示，不依赖能力分析选中；未设置时正文按渐进式披露在选中后加载。本回合明确关闭 Skill，或在设置中禁用该 Skill 时，正文不注入；常驻声明不会扩大工具权限。声明该字段的 Skill 会在可用列表里标注常驻状态，模型无需再调用 Skill 工具重复加载。

内置 Skill 的名称、描述和主说明使用英文，随版本发布为只读资源；这不要求用户用英文提问。设置中的技能页再次进入或重新打开时会读取最新目录，刷新也会重新读取展开的正文，保留搜索和展开位置。`allowed-tools` 声明工作流需要的工具，不授予执行权限。除浏览器、本机应用、记忆、日报、反思、待办、任务、计划、定时与工作区搜索外，还提供以下任务说明：

| Skill | 用途与边界 |
| --- | --- |
| `file-manager` | 查找、整理、移动、归档和清理指定目录的文件；检查覆盖冲突，重复候选须核对内容，删除与解压遵守文件权限。 |
| `system-info` | 只读检查系统、内存、磁盘、进程、电池和端口；诊断不自动执行清理、结束进程或修改网络。 |
| `notebook` | 编辑 `.ipynb` 单元格并保留元数据，修改代码时清除该单元格的旧输出；保存不等于执行，运行需要单独的任务授权。 |
| `web-search` | 用 `WebSearch` 查找公开资料并读取原始来源核实；搜索需要 Desktop 浏览器执行端，结果片段不代替来源证据。 |
| `web-fetch` | 用 `WebFetch` 读取已知 URL，分页查看提取文本并报告抓取截断；登录页面和交互操作交给浏览器入口。 |
| `image-gen` | 用 `biny image` 生图与改图；默认模型由 `imageGen.model` 决定，只有用户点名或要求对比时才传 `--model`。正文常驻系统提示。 |

这些 Skill 提供可按需加载的操作说明，复用现有工具与 CLI，不增加独立执行器或新的文件、网络权限。

```bash
biny skill list --json
biny skill search "项目检查" --json
biny skill check --json
biny skill create <skill-name> --file <path-to-SKILL.md>
biny skill install <owner/repository>
biny skill update <skill-name>
biny skill uninstall <skill-name>
```

`create` 将本地 `SKILL.md` 安装到 Biny 受管全局目录，也可用 `--file -` 从标准输入读取。名称须与目录名一致，使用 1–64 位小写字母、数字和单连字符；描述不可为空或超过 1024 个字符。不符合这些要求时会在写入前报错。

`check` 校验声明的需求，不运行技能脚本。搜索结果不表示已经安装，安装成功也不表示当前回合已经选用。

运行时先读取文件的前 64 KiB 解析元数据，frontmatter 的结束分隔线 `---` 必须完整位于该字节范围内。本地导入来源库或通过 `skill create` 创建时会在写入前检查这一要求；正文不受此元数据读取范围限制，选中后才加载正文与需要的资源。资源路径受目录与文件身份检查；Skill 不能自行授予脚本执行权限。

仓库根目录的 Skill 以 `.` 标识，与同名真实子目录分别展示和选择。安装只接受真实完整目录；旧的仓库名根别名、短目录名和大小写猜测不再自动解析，找不到所选目录时刷新后重选。已保存的 `.` 来源仍可更新。

Desktop 的技能设置可管理启用状态与自动提取。自动提取会调用模型并将可复用流程保存到全局受管技能目录；它会额外消耗模型用量，失败不改变已完成聊天的终态。

本地 `SKILL.md` 导入受管来源库时会校验可选元数据：`license` 与 `compatibility` 可省略或设为 `null`，填写时应为文本，`compatibility` 去除首尾空白后不超过 500 个字符；`allowed-tools` 应为字符串或字符串数组，`metadata` 应为对象。无效内容不会写入来源库；已保存的来源若被改成无效内容，会显示跳过警告并拒绝安装，保留原文件和现有安装。

## Plugins

Plugin 可注册工具、Provider、模型目录或凭据处理能力，也可注册回合前的临时上下文与回合后的同步回调。回调失败不会改变 Agent 回合结果。项目与全局插件通过受管目录和启用配置加载。

`extensions.plugins` 声明项目插件路径，`extensions.globalPlugins` 声明全局插件路径。项目路径与全局 `~/.config/biny/plugins/` 的解析边界不同，不能把任意外部绝对路径当作受管插件。

Plugin 的 JavaScript 在 Biny 进程中运行。受管安装、路径校验和工具审批各自提供约束，不构成 Plugin 代码沙箱。启用前检查实际来源和代码。

## Nowledge Mem

`plugins/nowledge-mem` 使用已配置的 Nowledge Mem MCP 服务。新消息到来时读取 context bundle 并搜索相关记忆，将结果作为本轮临时外部上下文；成功回合结束前，把当前活动消息分支中的用户与助手可见文本同步到该服务。原始用户消息不包含检索结果，工具调用、工具结果和思考内容不会同步。自动 MCP 调用仍经过 Biny 的 schema 校验、权限、回合工具额度、session 事件和结果归档。Biny 的记忆召回开关关闭时跳过检索，记忆贡献开关关闭时跳过同步。服务不可用时跳过对应操作，不阻断聊天。

要启用它，配置本地 MCP 服务，并把 `plugins/nowledge-mem` 加入项目的 `extensions.plugins`。默认识别名含 `nowledge-mem` 的 MCP 配置；其他别名可通过 Biny 进程环境变量 `BINY_NOWLEDGE_MEM_SERVER` 指定。同步会把用户和助手消息发送给该 MCP 服务；如需本机留存，请使用本地服务地址。

## 子代理

`extensions.subagent.enabled` 控制子代理能力，当前默认关闭。Desktop 在「设置 → 通用 → 子代理」启用并选择默认子代理与模型，使用页面底部的保存按钮提交；运行任务时不可修改。Biny 内置可跟随主模型，Codex CLI / Claude Code CLI 使用本机已安装并登录的 CLI 并填写模型 ID，外部 Agent 直接列出已配置连接的名称，例如「Claude Code（ACP）」「Codex（ACP）」，模型列表只显示所选连接的模型；没有连接时可通过「添加外部 Agent」进入模型供应商配置。切换 Agent 会清空旧模型，避免连接与模型混用。具名定义仍可覆盖默认运行方式和模型。

步数、期限、并发与允许工具继续在配置文件中管理；Desktop 修改默认运行方式和模型不会覆盖这些限制。外部运行方式有不兼容的权限、沙箱或额度配置时，设置页显示限制原因，保存不会自动放宽它们；启动前仍执行完整校验。

子代理的工具范围与全局允许集合求交集，不能扩大父任务权限。任务结果以持久 TaskRun、Attempt 和可选验证记录为准；子代理的文字报告不代替文件或测试证据。管理与恢复见 [目标与自动化](AUTOMATION.md)。

具名定义放在 `.biny/agents/<name>.md`（项目级）或 `~/.config/biny/agents/`（全局）；项目级同名优先。`runtime` 可选 `auto`、`builtin`、`codex`、`claude-code`、`acp`，省略时使用 `extensions.subagent.runtime`，默认 `builtin`。`model` 优先使用定义值，其次使用 `extensions.subagent.model`；内置运行时最终可沿用主模型。显式选择外部运行时必须指定模型，不自动安装或在执行失败后切换后端。

选择「自动」（`runtime: auto`）时，未指定模型的子代理在委派时查找本机可执行的 Claude Code CLI：找到则使用 Claude Code 自身的默认模型，未找到则使用 Biny 内置和主模型。不会自动选择 Codex 或 ACP 连接；显式模型别名使用内置运行方式，具名定义的 runtime 优先于全局默认。检测只确认可执行文件存在，不检查登录或服务可用性。选中 Claude Code 后仍执行外部子代理的权限与额度检查；校验、启动、登录或执行失败均直接报错，不再转用内置重跑。

```markdown
---
name: coder
description: Complete a focused coding task.
runtime: codex
model: your-codex-model-id
---
Keep changes within the assigned task. Report the changes and verification results.
```

`builtin` 的 `model` 是 Biny 模型别名；`acp` 也使用 Biny 模型别名，该模型必须属于已启用的 ACP Provider，实际启动命令、环境变量引用及 MCP 选择复用该连接配置。`codex` 和 `claude-code` 的 `model` 是对应 CLI 接受的原始模型 ID，分别从 PATH 启动 `codex exec` 和 `claude -p`。CLI 使用自己的本地登录与配置；Biny 不转发 Provider 密钥、主会话历史、记忆或工具。ACP 只转交连接中明确选择的 MCP 服务，子任务不自动检索或发送 Biny 记忆。

外部进程拥有自己的工具与授权机制，Biny 的 `allowedTools` 仅约束内置 Worker。外部任务要求父会话为 `full-access`、任务为 `workspace`，且不能附带 Biny 的拒绝路径、沙箱/禁网限制或具名 `tools` 限制；不满足时在启动前拒绝，不自动降低策略。CLI 启动不使用跳过权限的参数：Codex 使用 `workspace-write`，Claude Code 使用 `dontAsk`，外部工具可能被其自身权限拒绝。独立子 Session 不等于操作系统隔离，外部工具也不经过 Biny 的逐次批准。

外部 Worker 暂不支持 Biny 的 `maxSteps`、`maxCostUsd` 或绑定 session goal 的任务，存在这些要求时拒绝启动；内置 `maxOutputTokens` 不控制外部生成额度。总时限 `timeoutMs`、空闲时限 `inactivityTimeoutMs`、父取消和 Runtime 关闭仍有效。CLI 输出限制为 16 MiB、单条消息 1 MiB；ACP 沿用连接限制。完成必须同时有协议终态，CLI 还须正常退出，不能仅凭输出文本报成功。

外部任务启动前接收已排队消息并关闭消息入口，运行中不支持 `TaskMessage` 或子端 `TaskReport`。任务、模型身份、工具事件和最终回答记录在子 Session，可通过既有任务详情查询。中断后不重放外部请求，显式恢复也会拒绝；核实副作用后可创建新任务。CLI 错误输出不原样展示，避免泄露进程诊断中的凭据。真实 CLI 的登录、版本和模型可用性需要用户环境验证。

通过 `Task` 的 `agent` 字段或 CLI 选择具名定义：

```bash
biny task create "检查并修复指定问题" --agent coder --json
biny task run <taskRunId> --json
biny task get <taskRunId>
```

Worker 已输出部分文字不代表任务完成。输出额度耗尽、内容过滤或缺少正常结束原因时，任务记为未完成；Provider 报错则记为失败。`TaskStatus` 保留部分回答与结束诊断，冷恢复移交不自动追加模型请求。

父代理只收到有限报告与完成摘要（子报告最多 2000 字符，每次根执行最多四条通知、合计 6000 字符），完整执行历史保存在独立子 Session。后台任务完成后，通知会在父回合下一个安全边界接收；不会自行唤醒空闲父代理。子代理共享工作区，独立 Session 不提供文件系统隔离。

聊天中的子代理卡片与后台任务面板可展开查看工具参数、结果、思考、回答、消息送达状态及验收证据，切换执行记录并分页查询。后台列表显示最新的 100 个任务，创建后续任务后详情直接打开新记录，也可返回原任务。活跃任务可发送补充上下文或取消；已完成任务可明确创建后续有限任务，原记录保留。中断执行需要显式恢复，未知副作用不会自动重放。消息只在所属父子任务间传递，子代理报告不构成人类授权。

取消和超时会发出中断并清理计时器及父取消监听；正在执行的任务实际退出后才释放并发槽位与执行句柄。内存仅保留最近 200 条终态快照，完整持久记录仍可查阅。

CLI 提供相同领域入口：

```bash
biny task inspect <taskRunId> --session <sessionId> --limit 100 --json
biny task message <taskRunId> "补充上下文" --session <sessionId> --message-id <id>
biny task continue <taskRunId> "新的有限任务" --session <sessionId> --message-id <id>
```

`task list --newest-first` 按新到旧查询任务。`inspect` 支持 `--attempt-id` 查询旧执行、`--after-sequence` 分页；消息与后续任务的 ID 用于失败重试去重，重试必须保留原 ID 和内容。

恢复会核对原工具与权限契约；旧断点与当前策略不匹配时保持阻塞。先查明既有副作用，再明确创建新的有限任务，不能把重试当作自动恢复。

配置定义见 [schema.ts](../src/config/schema.ts)。运行实现：[MCP](../src/extensions/mcp.ts)、[Skills](../src/extensions/skills.ts)、[Plugins](../src/extensions/plugins.ts)。
