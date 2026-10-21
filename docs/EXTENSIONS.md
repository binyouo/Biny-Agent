# MCP、Skills 与插件

Biny 的扩展入口承担不同职责：MCP 连接外部服务，Skill 提供任务说明与资源，Plugin 加载程序能力。连接、发现与启用是准备阶段，实际执行仍以工具结果和持久状态为准。

## Code Mode 工具编排

`agent.toolExecutionMode` 默认是 `code_mode`：普通工具调用与 JavaScript / TypeScript `run_script` 共存。设置界面不提供启停开关。排障时可将配置 `agent.toolExecutionMode` 设为 `direct`，后续回合使用普通调用与独立的 `ToolSearch` 发现入口。模型自行选择是否编排，不保证每次使用；开启不会强制所有工具通过脚本调用。脚本通过 `tools.<name>(args)` 调用当前准入的工具，使用 `searchTools` 搜索、`describeTool` 查询参数和调用要求，最后用 `return` 返回需要的结果。

`run_script` 默认执行 JavaScript，设置 `language: "typescript"` 可先编译，再在同一 QuickJS 沙箱执行；不提供 Node 模块或宿主全局。`sh(command, {cwd, timeoutMs})` 经 Bash 权限链执行并返回 stdout，非零退出抛错。`fetch(url)` 通过 WebFetch 读取原始 GET 响应，支持 `status`、`ok`、`text()` 和 `json()`，保留私网、重定向与输出边界；超限响应报错，可改用 WebFetch 分页。其他 HTTP 方法或自定义头通过 `sh` 调用 curl，仍需 Shell 权限。`console.log/info/debug/warn/error` 在执行时通过独立通道持续交给宿主收集，不占工具调用额度，也不直接写入终端。每段脚本最多捕获 1 MiB、4,096 个输出片段，达到上限后省略后续输出并标注截断；脚本继续执行。stdout 超过 16,000 字符时，已捕获内容经脱敏保存到项目隔离的结果归档，模型只接收预览与 Read 引用；归档失败明确报错，不重跑脚本。超时、取消或 VM 异常退出后，宿主已收到的内容仍进入结果和归档；尚未送达的数据及宿主进程崩溃不保证恢复。返回值仍受现有结果预算约束。

脚本提供简短的 `description`，作为 Desktop 和 TUI 的任务标题。`timeout_ms` 默认 120,000，范围 1–600,000 毫秒；不会放宽同步计算、单次宿主调用及其他资源上限。单次普通工具调用直接执行，脚本用于循环、筛选、聚合或串联多个调用；只打印最终所需数据。

Code Mode 不向主模型声明独立的 `ToolSearch`：模型从 `run_script` 的说明获知 `searchTools(query)`、`describeTool(name)`、`describeNamespace(name)`，进入脚本后再按需查询目录。搜索命中项带有 `parameters` schema、返回值 schema（工具提供时）和调用要求；先读取这些定义，再编写调用脚本，避免猜测参数名。完整注册名在本地精确匹配，自然语言查询继续使用配置的工具模型；使用辅助模型并不要求另行声明一个搜索工具。

自动模式的脚本可以发现和调用尚未预选、但已经通过执行策略准入的工具。仅能普通调用的控制工具可以被发现或描述，结果以 `invocation: "direct"` 标记，并在下一次主模型请求中提供定义；脚本无法执行它们。手选工具仍限制脚本的发现和调用范围，`none` 关闭两个入口。

可编排的普通工具包括文件读取与搜索、网页搜索与读取、浏览器状态与页面读取、技能资源读取、任务状态与断点证据查询。文件修改可使用 `Write`、`Edit`，或当前模型编辑协议提供的 `apply_patch`；Shell 支持 `Bash`、`BashOutput` 和 `KillShell`。Patch 沿用同一回合的 Write/Edit 选择范围，调用 ID 由宿主绑定，脚本只提交 `operation`。并非所有标记为只读的工具都会自动进入脚本目录。

询问用户、激活技能和创建子任务仍通过专用入口调用；目标、计划、待办与已有任务的管理通过 `Bash` 运行 CLI；`run_script` 不能递归调用自身。工具选择、隐藏策略、权限确认、文件冲突检查、进程取消与输出限制对脚本子调用同样生效。允许编排不表示默认并发；同一文件的冲突编辑会被拒绝。脚本失败不会撤销已完成的修改，也不会自动重跑整段；子调用结果未知时停止后续派发。

脚本可用 `try/catch` 或 `Promise.allSettled` 处理执行前的参数校验错误，以及宿主确认已结束、可安全重试的内置只读工具错误，例如读取不存在的文件；捕获后仍可继续调用工具。未捕获的错误使脚本失败。权限拒绝、额度耗尽、取消、超时、结果未知和其他工具失败仍会阻断后续工具调用，即使脚本捕获了异常。失败子调用照常记录失败状态并计入额度；成功处理错误的外层脚本可以成功，不会将子调用改写成成功或自动重试。

## 工具结果优化与统计

脚本内部工具结果保留本地审计，主模型只收到脚本显式返回的结果和执行状态。Desktop 的「脚本处理」详情提供返回结果、内部调用与脚本三个视图；展开内部结果只在本地查看，不自动追加到模型上下文。历史 `exec` 调用仍可查看，新模型请求只声明 `run_script`。

命令输出压缩默认开启，底层配置为 `agent.rtkEnabled`；设置页不提供开关、状态框或检测按钮。Desktop 随包提供 **RTK 0.29.0**，优先使用内置版本，再检查 PATH、`~/.local/bin` 和 `~/.cargo/bin`；构建时下载固定版本并校验 SHA-256。CLI 可自行安装对应版本。缺少兼容版本或不支持改写时执行原命令。支持 RTK 能识别的简单前台 git status/diff/log/show、pnpm test/build/lint/typecheck/run，以及 npm、cargo、rg/grep、find、ls/tree、cat、tsc、eslint、vitest、pytest、curl/wget、docker、pip 命令；具体子命令须通过 RTK rewrite。POSIX 支持简单环境变量前缀（例如 `CI=1 pnpm test`），RTK 自身配置变量前缀保持原样。PowerShell 支持原生命令包装；ls、cat、curl、wget、find 等存在别名或平台语义差异的名称保持原样。cmd 和后台命令不压缩。带引号的字面参数可用，复杂 Shell 表达式、展开、重定向、管道和已知机器输出选项保持原样。命令仍经过原权限与沙箱；压缩后不重新执行原命令。RTK 的原始输出当前不保留，命令卡片会明确说明这一限制，并可查看实际执行命令。

每个 RTK 命令使用独立临时统计库，执行结束后读取并清理，不混入其他并发命令的计量。统计读取失败保留实际命令结果和诊断，不记作零节省，也不重跑命令。脚本中的命令同样可以压缩，PTC 以压缩后交给脚本的结果为基线，两段减少量各自计量。

「设置 → Token 节省」显示全部项目的累计 PTC 指标、RTK 压缩概览、命令分布和最近执行记录，每日趋势显示最近 30 天；消息用量显示本轮统计。统计来自持久化 `tool_result` 事件并按操作身份去重，重连和会话分支不重复累计相同记录。读取不完整时标记为部分统计，旧会话不补造数字。 命令耗时只汇总已采集的记录，旧记录不补造耗时；最近命令保留完整原始命令，旧回执从对应调用参数补取；点击可查看对应调用的原参数和压缩后结果，查看不会发送给模型。每日图补齐连续日期，负收益显示在零轴下方。统计按文件身份和修改指纹缓存各会话的投影，发生追加、重写或替换后重建该会话，删除后不复用缓存。

PTC 使用 UTF-8 字节数除以 3 估算内部结果与最终模型侧结果（包括错误、引用和状态信封）；RTK 使用自身记录的估算。差值允许为负，代表结果增加。统计只描述工具结果的局部变化，不包含脚本生成消耗、provider 缓存、工具定义和后续原文回查，不能换算为实际账单节省。真实模型用量继续使用 provider 返回值。

## 本地管理命令

记忆、会话历史、技能发现与安装、目标状态、计划、待办及已有任务管理复用 CLI，不再注册独立的模型辅助工具。模型通过 `Bash` 运行命令；Code Mode 中可以调用 `tools.Bash({command: "…"})`。命令经过 Shell 权限与执行审计，返回值沿用 Shell 的输出限制；需要完整输出时按工具结果中的归档引用读取。

| 用途 | 命令 |
| --- | --- |
| 搜索持久记忆 | `biny memory search "查询" --json`，支持 `--limit`、`--threshold`、标签及会话筛选 |
| 保存事实 | `biny memory add "事实" --json`；结构化字段使用 `--entry` |
| 搜索原始对话 | `biny history search "关键词" --json` |
| 查找已安装技能 | `biny skill list --query "关键词" --json` |
| 搜索和安装技能 | `biny skill search "能力" --json`、`biny skill install <GitHub-tree-URL> --json` |
| 查看或提交目标结果 | `biny goal show --json`、`biny goal update --input '<JSON>' --json` |
| 按需读取计划参数 | `biny plan schema draft --json`、`biny plan schema start --json`、`biny plan schema update --json` |
| 创建草稿或启动计划 | `biny plan draft --input '<JSON>' --json`、`biny plan start --input '<JSON>' --json` |
| 检查和修改计划 | `biny plan status <graph-id> --json`、`biny plan update --input '<JSON>' --json` |
| 查看、替换或清空待办 | `biny todo show --json`、`biny todo replace --todos '<JSON数组>' --json`、`biny todo clear --yes --json` |
| 向当前会话提问并等待回答 | `biny input ask "项目名称是什么？" --json`；选择题或多个问题使用 `--input '<JSON>'` |
| 查看等待回答的问题 | `biny input list --session <session-id> --json` |
| 回答或跳过问题 | `biny input answer <tool-call-id> --session <session-id> --run <run-id> --question answer --text "我的项目" --json`；跳过使用 `--skip` |
| 取消已有子任务 | `biny task cancel <taskRunId> --json` |
| 给子任务补充上下文 | `biny task message <taskRunId> "消息" --session <当前会话ID> --json` |
| 从已完成子任务创建后续工作 | `biny task continue <taskRunId> "新增任务" --session <当前会话ID> --json`，需要已有用户授权 |

普通记忆追加由 Host 写入队列与存储事务串行化，可在模型回合中执行；清理、归档和整理仍需要会话独占。自动召回、提取和 Sleep 继续由记忆运行时管理。技能激活前重新扫描当前技能目录，让本回合新安装的技能可以通过 `Skill` 加载；加载失败会返回错误。

前台 `Bash` 为 CLI 传入当前会话与短期执行上下文，命令默认作用于所属会话；命令结束、取消或切换回合后上下文失效，后台命令不获得这项授权。目标完成与阻塞提交必须使用这个上下文，按模型请求开始时观察到的目标身份校验，不能提交旧目标的判断。目标正文、预算、暂停与恢复仍由用户控制。计划更新要求同回合先检查计划；人工 CLI 更新则必须传入 `plan status` 返回的 `--revision`，过期版本拒绝写入。待办写入经所属 Host 更新实时状态，下一次模型采样及进度展示可以读取新列表。

`biny input ask` 只在当前交互回合的前台命令中发起提问，复用既有回答校验和执行记录。用户可以在 Desktop 的提问卡片中回答，也可以在同一工作区的终端使用 `input list` / `input answer`。三条命令均支持 `--json` 和 `--session`；省略会话时读取前台命令传入的当前会话，人工终端需要明确指定。命令超时或回合取消会清理等待，旧问题不能再回答；等待时长受外层 Shell 命令超时限制。普通终端、后台命令和非交互任务不能通过 `input ask` 新建提问。

简单提问的 question ID 固定为 `answer`；结构化问题使用各自的 `id`，可通过 `--answers` 提交选择与补充文字。具体参数与示例见 `biny input ask --help` 和 `biny input answer --help`：

```sh
biny input ask --input '{"questions":[{"id":"place","question":"文件放在哪里？","options":[{"label":"桌面"},{"label":"下载目录"}]}]}' --json
biny input answer <tool-call-id> --session <session-id> --run <run-id> --answers '[{"id":"place","selected":["下载目录"]}]' --json
```

计划监督回合只允许单个字面量 `biny plan status` 或 `biny plan update` 命令，以及有界的 `TaskStatus` 查询；Shell 拼接、展开与后台执行会被拒绝。普通模型回合仍按 Shell 权限执行命令。内部领域操作保留稳定的审计事件，移除模型声明不影响历史记录读取。

`TaskStatus` 继续提供只读权限下的有界查询和等待，CLI `biny task inspect` 可供人工检查。`Task`、`Skill`、技能资源读取与检查点证据读取保留专用入口；用户提问同时支持专用工具和 `input` CLI，子任务端的 `TaskReport` 继续绑定自身报告上下文。

## 工具名称与用户展示

注册名是稳定的调用与审计标识，中文展示名不改写工具参数、权限规则或历史事件。能力菜单、执行记录与工具详情共用展示定义；已知工具显示“读取文件”“执行命令”“运行脚本”等中文名称。未提供展示名称的第三方工具保留原名称，编码后的 MCP 调用名只在技术详情中显示。

消息能力菜单只展示可由用户选择的业务能力。工具发现、内部资源说明和目标/计划状态等运行时辅助入口不作为逐项选项；`hidden`、`model-only` 工具也不出现在选择器中。MCP 按服务器选择，隐藏工具不计入可选名单。菜单隐藏与模型是否收到定义、脚本是否能调用、权限是否批准分别校验；内部调用仍保留执行审计。

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

TUI 的状态行显示 MCP 已连接数量、工具数和正在加载的服务名称，加载期间仍可输入。连接完成后显示一次汇总；失败会直接显示原因、授权提示和 `/mcp reconnect <name>`，并在状态行保留失败数量。相同错误不会重复提示，连接成功后清除失败状态。`/mcp` 直接展示错误原因，工具列表仍可用 Ctrl+O 展开；已连接服务的目录刷新错误显示为警告。

`exposure` 与 `toolExposure` 控制能力暴露方式。可选值为 `direct`、`codemode`、`deferred` 和 `hidden`；隐藏能力不表示卸载或撤销远端凭据。

普通调用模式下，ToolSearch 成功发现的具体工具会在同一聊天的后续回合继续可用，只要发现结果仍在当前活动上下文中，且工具仍已注册并可向模型展示。不会因此展开整个 MCP 服务器，也不会绕过执行权限；新聊天、手动指定工具或关闭工具不继承这份历史。完整、大小写一致的注册工具名可直接精确匹配，其他查询由工具模型选择。

工具模型返回缺字段或类型错误的选择结果时，ToolSearch 报错，不把它缓存为“没有匹配工具”。连续搜索没有发现新工具、也没有实际工具执行的新成功结果时，达到 `agent.maxRepeatedActions`（默认 3）会停止本轮，避免改写查询后继续空转；普通中断续跑保留计数。

同一 Runtime Host 内会短暂保留成功连接的工具目录：最多 32 个条目、每项不超过 1 MiB、有效期 30 分钟。相同工作区、配置和凭据环境重新建立连接时，可先用缓存发现工具；连接状态仍显示正在连接，实际调用等待连接完成并核对最新定义。定义变化时拒绝旧调用，要求重新发现和准备。启动失败清除对应缓存；OAuth 服务不复用目录缓存。缓存不写磁盘，不能加速应用重启后的第一次连接。

自动工具与技能预选并行执行，每一路的候选模型共用 10 秒预算。超时取消预选，保留基础、显式点名及会话内累计的预选能力，再继续主模型请求；该预算不包含 MCP 发现或主模型生成。

自动预选固定保留文件读取、写入、编辑与 Shell；归档结果由 Read 回查。Code Mode 通过 run_script 中的 searchTools 发现其他能力，direct 模式保留独立 ToolSearch。文件搜索、后台进程查询与停止、任务清单、提问和断点证据读取按需选择或发现；完整注册名的精确查找不需要辅助模型。常驻集合不等于整轮工具上限，已选择的技能、活动目标和历史工具仍会补充所需能力。

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

在 TUI 中使用 `/skills` 按名称和描述搜索技能，或输入 `/skill:` 选择补全候选。确认只将 `/skill:<name>` 放入可编辑草稿并保留已有正文；补充任务后再次按 Enter 才提交。Esc 退出选择器不会清除草稿。

运行时先根据当前请求选择相关 Skill，主模型收到的是名称和简介。普通 Skill 的正文由模型调用 `Skill` 时读取；手动选择、`/skill:<name>` 点名和全选也只展示简介，不会提前加载全部正文。正文中的 references、scripts 和 assets 继续按需读取。只有正文成功读入上下文才显示为已加载，预选名单不算加载结果。

frontmatter 的 `always-inject: true` 让该 Skill 的正文在每个回合进入系统提示，不依赖能力分析选中，是普通按需加载的显式例外。本回合明确关闭 Skill，或在设置中禁用该 Skill 时，正文不注入；常驻声明不会扩大工具权限。声明该字段的 Skill 会在可用列表里标注常驻状态，模型无需再调用 Skill 工具重复加载。

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

`create` 将本地 `SKILL.md` 安装到 Biny 受管全局目录，也可用 `--file -` 从标准输入读取。名称须与目录名一致，使用 1–64 位小写字母、数字和单连字符；描述不可为空或超过 1024 个 UTF-16 代码单元（补充平面字符如常见 emoji 占两个）。不符合这些要求时会在写入前报错。

运行时加载标准 `SKILL.md` 时也会拒绝超长描述；兼容旧式独立 Markdown 文件的描述则截断到 1024 个 UTF-16 代码单元。技能元数据列表按 1024、300、160、80 的描述上限逐级缩短，必要时省略条目，使该列表及其发现指引不超过 8000 个 UTF-16 代码单元（不含随后拼接的常驻技能正文）；Skill 工具准备阶段的展示描述上限为 200。截断包含末尾的 `…`，不会拆开原本完整的代理对，也不修复输入中已有的未配对代理项。

`check` 校验声明的需求，不运行技能脚本。搜索结果不表示已经安装，安装成功也不表示当前回合已经选用。

运行时先读取文件的前 64 KiB 解析元数据，frontmatter 的结束分隔线 `---` 必须完整位于该字节范围内。本地导入来源库或通过 `skill create` 创建时会在写入前检查这一要求；正文不受此元数据读取范围限制，在按需调用或常驻装配时受独立大小限制。资源路径受目录与文件身份检查；Skill 不能自行授予脚本执行权限。

仓库根目录的 Skill 以 `.` 标识，与同名真实子目录分别展示和选择。安装只接受真实完整目录；旧的仓库名根别名、短目录名和大小写猜测不再自动解析，找不到所选目录时刷新后重选。已保存的 `.` 来源仍可更新。

Desktop 的技能设置可管理启用状态与自动提取。成功回合结束后，自上次分析以来新增的外层工具调用达到阈值时，后台模型分析累计会话；脚本子调用不重复计数。分析结果为不值得提取或生成失败时也记录分析进度，等待足够的新调用后再分析。最近 8 条消息保留详细内容，更早内容压缩，素材截止于触发回合。

值得提取的流程会自动生成、校验并保存，无需审核；新技能写入全局受管目录，更新已有技能时读取旧正文并写回原位置。内置技能和不可变版本不自动覆盖，生成期间原文发生变化也会停止覆盖。该过程额外消耗模型用量；失败结束进度提示，不改变已完成聊天的终态。

本地 `SKILL.md` 导入受管来源库时会校验可选元数据：`license` 与 `compatibility` 可省略或设为 `null`，填写时应为文本，`compatibility` 去除首尾空白后不超过 500 个字符；`allowed-tools` 应为字符串或字符串数组，`metadata` 应为对象。无效内容不会写入来源库；已保存的来源若被改成无效内容，会显示跳过警告并拒绝安装，保留原文件和现有安装。

## Plugins

Plugin 可注册工具、Provider、模型目录或凭据处理能力，也可注册回合前的临时上下文与回合后的同步回调。回调失败不会改变 Agent 回合结果。项目与全局插件通过受管目录和启用配置加载。

`extensions.plugins` 声明项目插件路径，`extensions.globalPlugins` 声明全局插件路径。项目路径与全局 `~/.config/biny/plugins/` 的解析边界不同，不能把任意外部绝对路径当作受管插件。

Plugin 的 JavaScript 在 Biny 进程中运行。受管安装、路径校验和工具审批各自提供约束，不构成 Plugin 代码沙箱。启用前检查实际来源和代码。

## Nowledge Mem

`plugins/nowledge-mem` 使用已配置的 Nowledge Mem MCP 服务。新消息到来时读取 context bundle 并搜索相关记忆，将结果作为本轮临时外部上下文；成功回合结束前，把当前活动消息分支中的用户与助手可见文本同步到该服务。原始用户消息不包含检索结果，工具调用、工具结果和思考内容不会同步。自动 MCP 调用仍经过 Biny 的 schema 校验、权限、回合工具额度、session 事件和结果归档。Biny 的记忆召回开关关闭时跳过检索，记忆贡献开关关闭时跳过同步。服务不可用时跳过对应操作，不阻断聊天。

要启用它，配置本地 MCP 服务，并把 `plugins/nowledge-mem` 加入项目的 `extensions.plugins`。默认识别名含 `nowledge-mem` 的 MCP 配置；其他别名可通过 Biny 进程环境变量 `BINY_NOWLEDGE_MEM_SERVER` 指定。同步会把用户和助手消息发送给该 MCP 服务；如需本机留存，请使用本地服务地址。

## 子代理

`extensions.subagent.enabled` 控制子代理能力，当前默认关闭。Desktop 在「设置 → 通用」的 Coding Agent 卡片选择默认执行后端，使用页面底部的保存按钮提交；运行任务时不可修改。自动优先使用本地 Claude Code CLI，不可用时回到内置 Agent；Claude Code 使用 CLI 默认模型，内置 Agent 沿用当前聊天模型。ACP 选项按已配置连接列出，不要求在 Biny 中另建模型别名，执行时采用 ACP Agent 默认模型。没有配置的 ACP 目录项不显示；卡片提供 Provider 数量和跳转到模型供应商设置的入口。Codex CLI 仍可由具名定义使用并指定模型。具名定义可覆盖默认运行方式和模型。

步数、期限、并发与允许工具继续在配置文件中管理；Desktop 修改默认执行后端不会覆盖这些限制。外部运行方式有不兼容的权限、沙箱或额度配置时，设置页显示限制原因，保存不会自动放宽它们；启动前仍执行完整校验。

子代理的工具范围与全局允许集合求交集，不能扩大父任务权限。任务结果以持久 TaskRun、Attempt 和可选验证记录为准；子代理的文字报告不代替文件或测试证据。管理与恢复见 [目标与自动化](AUTOMATION.md)。

具名定义放在 `.biny/agents/<name>.md`（项目级）或 `~/.config/biny/agents/`（全局）；项目级同名优先。`runtime` 可选 `auto`、`builtin`、`codex`、`claude-code`、`acp`，省略时使用 `extensions.subagent.runtime`，默认 `builtin`。`model` 优先使用定义值，其次使用 `extensions.subagent.model`；内置运行时最终可沿用主模型。显式 ACP 定义可用 `providerAlias` 选择连接并沿用 Agent 默认模型，也可设置该 Provider 下的模型别名；Codex CLI 仍需指定外部模型 ID。不自动安装或在执行失败后切换后端。

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

外部任务启动前接收已排队消息并关闭消息入口，运行中不支持追加任务消息或子端 `TaskReport`。任务、模型身份、工具事件和最终回答记录在子 Session，可通过既有任务详情查询。中断后不重放外部请求，显式恢复也会拒绝；核实副作用后可创建新任务。CLI 错误输出不原样展示，避免泄露进程诊断中的凭据。真实 CLI 的登录、版本和模型可用性需要用户环境验证。

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
