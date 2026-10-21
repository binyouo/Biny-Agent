# CLI 使用指南

Biny 的命令行可以启动对话、执行任务，以及直接管理已有的配置、会话、记忆和项目能力。完整阅读入口见[文档索引](README.md)；开发新命令时参阅 [CLI 开发规范](CLI.md)。

## 启动与帮助

在源码仓库构建并链接命令，然后切到需要操作的项目目录：

```bash
pnpm build:cli
pnpm link --global
cd /path/to/project
biny --help
```

仓库开发时可用 `pnpm dev -- <命令>`。更新源码后重新构建 CLI；依赖 Desktop 的新命令还需要构建并重启 Desktop，已有应用进程不会因构建自动更新。

```bash
biny                                  # 新建终端对话
biny resume                           # 选择历史会话
biny run "检查项目并说明结果" --headless
biny memory --help
biny session compact --help
```

命令按 `biny <模块> <操作>` 组织。尖括号参数如 `<session-id>` 需要替换；含空格或换行的文本作为一个加引号的参数传入。具体参数以当前命令的 `--help` 为准。

## 命令在哪里执行

`run`、`chat`、`tui` 的 Agent 执行统一连接或启动 Runtime Host，连接失败直接报错。`run --isolated` 可与模型覆盖、截止时间和验收契约一起使用。`memory serve` 和静态 `graph create/start` 已移除；记忆管理及监督式 plan 保留。

工作区由执行命令时的当前目录决定。全局配置和用户资料由配置目录管理；项目登记、主题、预览和内嵌终端属于 Desktop；运行中的会话属于 Runtime Host。

| 命令 | 执行条件 |
| --- | --- |
| `config`、`provider`、`model` | 使用共享全局配置存储；配置目录有 Desktop 加密凭据时通过正在运行的 Desktop 读取和保存。 |
| `user`、`agent` | 直接使用本地用户资料和具名子代理定义，无需启动模型。 |
| `project`、会话元数据管理与复制、`preview`、`terminal` | 需要正在运行的 Desktop，操作它管理的同一份状态。 |
| `config get/set themePreference/appearancePreference/fontPreference` | 需要 Desktop，通过现有偏好存储保存并刷新外观。 |
| `session create/usage/compact`、`tool list/call` | 连接当前工作区已有的 Host；创建以外的操作需要指定会话，不为查询或调用启动新 Host。 |
| `session messages/search`、`usage` | 读取本地持久记录，无需启动 Host 或模型。 |
| `iab` | 需要 Desktop 的内置浏览器。 |

其他命令的启动方式和限制见对应专题。`BINY_AGENT_DIR` 可同时重定向配置和运行数据；访问同一份数据的 Desktop、Host 与 CLI 必须使用相同值。

一次性命令的 `--json` 用于脚本读取，结果写入 stdout。本文的新增管理命令失败时写 stderr 并返回非零退出码；不要只凭 stdout 非空判断成功。部分现有控制命令在 JSON 模式返回错误对象，同样需要检查退出码。

## 配置、Provider 与模型

```bash
biny config get --json
biny config get heartbeat --json
biny config set heartbeat.intervalMinutes 45 --json
biny config set heartbeat.enabled true --json
biny provider list --json
biny model list --json
biny model list --provider example --json
biny model set <model-alias> --json
```

这些配置命令读取、修改**全局配置**，不把当前项目的覆盖写回全局。`config set` 的值优先按 JSON 解析，例如 `true`、`45`、`null` 或完整对象；其他文本作为字符串。输入须满足所属配置字段的类型和约束，非法输入不会保存。查询结果中的密钥等敏感字段会打码。

`model list` 合并已配置别名和有效的本地模型目录缓存，不主动请求在线目录；`model set` 使用列表中的别名，复用模型选择的解析、凭据与配置校验。它修改全局默认模型；项目的 `.biny/settings.json` 若声明了自己的 `defaultModel`，该项目继续使用项目覆盖。`run --model` 是本次运行的覆盖，作用范围不同。

新增连接时将 Provider 配置写入 JSON 文件。例如 `provider.json`：

```json
{
  "type": "openai-compatible",
  "baseUrl": "https://api.example.test/v1",
  "apiKeyEnv": "EXAMPLE_API_KEY"
}
```

```bash
biny provider add example --file provider.json --json
biny provider remove example --json
```

`add` 不覆盖同名连接；连接仍被模型别名引用时，`remove` 会报告配置错误并保留原配置。添加连接本身不等于已获取模型目录或服务已可用。不同 Provider 的真实字段、凭据存储与项目覆盖见[模型与配置](CONFIGURATION.md)。

配置保存成功表示持久化已完成。已运行的功能按各自生命周期读取配置；Heartbeat 的开关和节奏在创建 Runtime 时读取，修改后需要重新启动相应 Host 才应用，不会因一次 `config set` 自动重启运行中的任务。

主题沿用同一配置入口，不增加一套重复的主题设置命令：

```bash
biny theme list --json
biny config get appearancePreference --json
biny config set appearancePreference.darkTheme tokyonight --json
biny config set themePreference system --json
```

`theme show <id>` 查看某个主题的颜色；`theme validate/import` 校验或转换主题文件。它们与当前主题选择的读取、保存分别承担不同操作。

## 会话、用量与工具

```bash
biny sessions --json
biny session create --json
biny session search "发布检查" --json
biny session messages <session-id> --offset 0 --limit 20 --json
biny session messages <session-id> --offset 20 --full --json
biny session rename <session-id> "新的会话标题" --json
biny session pin <session-id> --json
biny session unpin <session-id> --json
biny session archive <session-id> --json
biny session unarchive <session-id> --json
biny session duplicate <session-id> --json
biny session delete <session-id> --json
biny session usage --session <session-id> --json
biny usage --json
biny session compact --session <session-id> --hint "保留未完成事项" --json
biny tool list --session <session-id> --json
biny tool call Read '{"path":"README.md"}' --session <session-id> --json
```

`session create` 在当前工作区已有 Host 中创建新的空会话，不发起模型请求。`messages` 读取当前消息分支，包含压缩前的消息；默认每条正文预览 80 字符，`--full` 返回全文及结构化内容。分页返回 `nextOffset`，读完为 `null`。`search` 在当前目录所属工作区按会话 ID、标题、标签和当前分支消息正文搜索，返回目录元数据；`--cursor` 继续相同查询，不能当作全局消息检索。跨工作区的消息检索仍使用 `history search`。

重命名、置顶、归档、复制和删除通过 Desktop 的会话管理服务执行，默认项目是当前目录对应的登记项目，也可显式指定 `--project <project-id>`。重命名、置顶和归档接受 `--revision <revision>`，用于携带已观察到的元数据版本。`unpin/unarchive` 撤销对应状态；`duplicate` 复制为新会话。删除会移除会话记录，不删除项目文件；运行中的会话沿用已有的拒绝删除规则。

会话用量、压缩和工具通过 Host 查询或执行，`--session` 可由 `BINY_AGENT_SESSION_ID` 提供；不隐式选择“最近会话”。`session usage` 返回目标会话的汇总、报告和请求统计。`usage` 汇总全局运行目录中已落盘的用量，以运行事件 ID 去除复制记录中的同一事件；旧记录或导入数据缺少原始身份时无法识别重复，父子会话的关联用量也可能重复计入。它是本地记录汇总，不是 Provider 账单；缺失计价仍返回未知金额。

`tool list` 查看可用工具目录及参数，不代表它们已全部暴露给当前模型请求。`tool call <name> [JSON]` 不调用模型，直接通过所属 Host 的工具执行器执行，沿用参数 schema、路径权限、审批规则和会话审计。它需要空闲会话及写入权；不能从正在运行的 Agent Shell 中用它另开执行器插入该会话，活动回合继续使用自身的工具调用。明确要求完整确认的操作不会自动获批。调用进程退出或按 Ctrl+C 断开连接时，Host 取消该次工具执行并等待执行器收尾。压缩同样沿用 writer 与忙闲规则。

历史恢复、搜索和导入导出继续使用 `resume`、`history`、`session export/import`，详见[会话与恢复](SESSIONS.md)。

## 项目、预览与终端

```bash
biny project list --json
biny project show <project-id> --json
biny project add /path/to/existing-project --json
biny project create /path/to/new-project --json
biny project rename <project-id> "项目名称" --json
biny project remove <project-id> --json
```

`add` 登记已有目录；`create` 新建目录再登记。`remove` 从 Desktop 项目列表移除登记，保留项目目录与文件；运行中的项目仍按现有规则拒绝移除。

进入已登记项目的目录后，可直接操作它的预览和终端；在其他目录操作时传入 `--project <project-id>`：

```bash
biny preview detect --json
biny preview start --json
biny preview start --entry pages/demo.html --json
biny preview status --json
biny preview stop --json

biny terminal list --json
biny terminal create --name work --json
biny terminal read <terminal-id> --json
biny terminal write <terminal-id> $'pwd\n' --json
biny terminal close <terminal-id> --json
```

预览复用 Desktop 的 HTML 静态服务或项目开发服务器，`detect` 返回可用类型、入口或不可用原因。HTML 的 `--entry` 从检测结果中选择。停止预览关闭对应服务或预览终端。

终端使用 Desktop 已有的 PTY 和命名槽；相同项目、相同名称复用同一终端。`write` 发送原样输入，不自动追加 Enter；示例中的 `$'pwd\n'` 为 macOS/Linux shell 写法。`read` 返回最近的回放文本及序号，受现有 256 KiB 缓冲限制，不是完整日志文件。终端 ID 必须属于指定项目；`close` 使用已有的终端关闭流程。

## 用户资料与具名子代理

```bash
biny user show --json
biny user set "项目文档使用中文；提交说明使用英文。" --json
biny agent list --json
biny agent show reviewer --json
biny agent create reviewer --file reviewer.md --json
biny agent create reviewer --file reviewer.md --global --json
biny agent delete reviewer --json
```

`user` 读写持久化的用户资料，复用已有版本检查、正文规范化和历史保存。`soul` 管理人格内容，职责与用户资料不同。

`agent list/show` 查询具名子代理定义，不启动子代理。`create` 接收完整 Markdown 定义，frontmatter 的 `name` 须匹配命令参数，并提供 `description` 和正文；名称使用 1–64 个小写字母、数字、下划线或连字符。默认写入第一个配置的项目 Agent 目录，`--global` 写入全局目录，不覆盖已有同名定义。创建结果返回完整定义及路径。

项目级同名定义优先于全局定义。`delete` 删除当前选中的定义，项目覆盖删除后可重新显露全局定义；`delete --global` 明确删除全局定义。定义文件格式与执行约束见[扩展与子代理](EXTENSIONS.md#子代理)。

## 内置浏览器

```bash
biny iab envs --json
biny iab status --json
biny iab goto https://example.test --env Work --json
biny iab info --json
biny iab click '#save' --json
biny iab fill '#query' '项目 CLI' --json
biny iab press Enter --selector '#query' --json
biny iab scroll 600 --json
biny iab back --json
biny iab forward --json
biny iab reload --json
biny iab history --json
biny iab screenshot --out page.png --json
biny iab eval 'document.title' --json
biny iab cdp Page.getNavigationHistory '{}' --json
biny iab viewport set 390 844 --mobile --json
biny iab viewport reset --json
biny iab upload 'input[type=file]' reports/summary.pdf --json
biny iab download https://example.test/report.pdf --out report.pdf --json
biny iab export pdf --out page.pdf --json
biny iab export html --out page.html --json
biny iab export mhtml --out page.mhtml --json
biny iab export md --out page.md --json
biny iab dialog watch --json
biny iab dialog get --json
biny iab dialog accept "提示框回复" --json
biny iab dialog dismiss --json
biny iab dialog stop --json
biny iab clipboard write "待粘贴文本" --json
biny iab clipboard read --json
biny iab tab list --json
biny iab tab new https://example.test --env <environment-id> --json
biny iab tab select <tab-id> --json
biny iab tab close <tab-id> --json
biny iab tab float <tab-id> --json
biny iab tab stop <tab-id> --json
biny iab env create --file browser-environment.json --json
biny iab env update <environment-id> --file browser-environment.json --json
biny iab env clear <environment-id> --json
biny iab env import-cookies <source-environment-id> <target-environment-id> --json
biny iab env delete <environment-id> --json
biny iab profile list --json
biny iab profile import <profile-id> --json
```

`click/fill/press` 操作当前内置页面，`fill` 替换控件值，`press --selector` 先聚焦指定元素再发送按键。`info` 已提供当前页面读取；`fetch` 用所选登录环境抓取页面。`browser` 命令操作 Chrome Relay 连接的浏览器，目标与 `iab` 不同，详见[浏览器](BROWSER.md)。

`status` 不创建页面。`back/forward/reload` 等待页面停止加载，导航失败会返回错误；没有可后退/前进的记录时返回当前页面。`scroll <y> --x <x>` 按像素滚动，负数向上或向左。`history` 只列当前页面的导航栈；`screenshot` 保存可见视口的 PNG，默认文件为当前目录的 `biny-browser.png`。

`eval` 在当前页面执行 JavaScript 表达式并返回结果，成功但没有返回值时 JSON 输出为 `null`；`cdp` 发送指定的原始 DevTools Protocol 方法和 JSON 参数，保留协议本身的能力与副作用。`viewport set/reset` 设置或还原页面视口模拟，不改变应用窗口大小。`clipboard` 读写 Desktop 系统剪贴板的文本，无需打开页面。

上传、下载、截图和导出沿用浏览器文件传输边界：读写路径必须在当前工作区内，拒绝被禁止的路径，上传最多 10 个文件且合计不超过 8 MiB，单次保存不超过 8 MiB，输出文件须尚不存在且父目录已存在。`upload` 将文件传给指定的文件输入控件并触发 input/change；`download` 使用当前页面环境的登录状态请求 HTTP(S) URL；`export` 支持 PDF、HTML、MHTML 和可读正文 Markdown。

需要处理网页 alert、confirm 或 prompt 时先运行 `dialog watch`。监听保留在 Desktop 中，`get` 查看当前弹窗，`accept [text]` 接受并可填写 prompt，`dismiss` 拒绝，`stop` 只停止监听；关闭页面会清理监听。弹窗命令可以在页面 JavaScript 正等待回复时执行，不需要自动同意弹窗。

`tab` 管理当前目录登记项目的标签页，可传 `--project <id>`；`float` 切换独立浮窗，`stop` 停止加载。页面交互命令使用当前选中的页面，不隐式选择其他标签。环境文件格式为 `{"name":"Work","proxy":{"mode":"system"}}`，代理字段沿用浏览器环境设置。默认环境不能修改、删除或清空。`clear` 清空指定环境的本地站点数据；`import-cookies` 用源环境 Cookie 替换目标环境 Cookie；`profile import` 将本机浏览器配置的 Cookie 导入默认环境。它们操作真实登录状态，沿用 Desktop 的运行门禁。

## 其他命令入口

以下按任务列出其余命令域，具体操作和参数通过 `biny <模块> --help` 查看。

| 任务 | 命令入口 | 说明 |
| --- | --- | --- |
| 初始化、环境与 ACP 检查 | `init`、`doctor`、`acp` | 配置初始化、本机诊断和已配置 ACP 连接检查。 |
| 终端对话与一次性执行 | `chat`、`tui`、`run`、`resume` | [会话与恢复](SESSIONS.md)。 |
| 长期事实、历史与日记 | `memory`、`history`、`diary`、`reflection`、`heartbeat` | [长期记忆](MEMORY.md)。 |
| 活动采集与工作日报 | `activity` | [活动记录与 Appshots](ACTIVITY.md)。 |
| 人格与个性化 | `soul`、`emotion`、`crystal`、`fatigue`、`sleep`、`wake`、`rest`、`selfie`、`travel` | 按对应帮助读取或维护已有状态与内容。 |
| 对象引用与双链 | `ref` | 搜索、解析、关联、引用图、片段和固定对象，见[扩展](EXTENSIONS.md)。 |
| 任务、目标与自动化 | `todo`、`task`、`goal`、`plan`、`graph`、`automation` | [目标与自动化](AUTOMATION.md)。 |
| 交互提问 | `input` | 发起问题、查看待答项与提交回答，见[扩展](EXTENSIONS.md)。 |
| 扩展与外部数据导入 | `skill`、`imports` | [Skills](EXTENSIONS.md#skills) 与[应用导入](IMPORTS.md)。 |
| Computer Use | `computer`、`cu` | [Computer Use](COMPUTER_USE.md)。 |
| 图片、视频与交互内容 | `image`、`video`、`widget` | 生成或编辑图片、分析视频、渲染 HTML 内容。 |
| Telegram | `telegram` | 渠道运行与已配置接收方的消息操作。 |
| 常驻运行与评测 | `daemon`、`runtime-host`、`eval` | [架构](ARCHITECTURE.md)、[评测](EVALUATION.md)。 |

源码入口：[命令注册](../src/cli/index.ts)、[配置操作](../src/config/commands.ts)、[Desktop 命令服务](../src/desktop/electron/main/DesktopCommandService.ts)。
