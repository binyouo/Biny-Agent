# CLI 使用指南

Biny 命令行提供对话启动、任务批处理，以及对配置、会话、长期记忆与本地环境能力的直接管理。完整文档索引见 [文档索引](README.md)；开发新命令时请参阅 [CLI 开发规范](CLI.md)。

## 启动与帮助

在源码仓库构建并全局链接命令，然后切换至目标项目目录：

```bash
pnpm build:cli
pnpm link --global
cd /path/to/project
biny --help
```

在源码开发环境下，可通过 `pnpm dev -- <命令>` 直接调用。修改源码后需重新构建 CLI；若涉及依赖 Desktop 的新命令，还需重新构建并重启 Desktop 桌面端。

常用快捷启动：

```bash
biny                                  # 在当前项目开启交互式终端对话
biny resume                           # 调出会话列表并恢复历史
biny run "检查项目结构并说明结果" --headless # 非交互式执行任务
biny memory --help                    # 查看记忆管理命令帮助
biny session compact --help           # 查看会话压缩帮助
```

- **命令结构**：统一遵循 `biny <模块> <操作> [参数]`。
- **参数约定**：尖括号 `<session-id>` 表示必填占位符；包含空格或换行的内容须使用引号包裹。各项操作具体参数可通过 `--help` 查询。

## 命令在哪里执行

Agent 对话与执行（`run`、`chat`、`tui`）统一连接或拉起本机的 Runtime Host，连接失败时直接报错退出。`run --isolated` 支持与模型覆盖、任务限时及验收规则配合使用。

* **工作区定位**：当前工作区由执行命令时的 Shell 当前目录决定。
* **数据归属**：全局配置与用户画像保存在配置目录；项目登记、主题偏好、本地预览与嵌入终端归属 Desktop；活跃会话由 Runtime Host 维护。

| 命令域 | 执行前置条件与运行时依赖 |
| --- | --- |
| `config`、`provider`、`model` | 使用共享的全局配置存储；配置目录包含 Desktop 安全凭据时，经由运行中的 Desktop 安全读写。 |
| `user`、`agent` | 直接读取与修改本地用户资料与具名子代理 Markdown 定义，无需加载大模型。 |
| `project`、会话元数据（重命名/置顶/归档/复制/删除）、`preview`、`terminal` | 依赖运行中的 Desktop，共同维护同一份桌面状态。 |
| `config get/set themePreference/fontPreference` | 依赖 Desktop，修改偏好存储并即时刷新界面外观。 |
| `session create/usage/compact`、`tool list/call` | 连接当前工作区活跃的 Host；除新建会话外均需显式指定会话 ID，不无故启动新 Host。 |
| `session messages/search`、`usage` | 直接读取本地持久化 JSONL / SQLite 记录，无需启动 Host 或模型。 |
| `iab` | 依赖 Desktop 运行中的内置浏览器服务。 |
| `remote run` | 在当前项目启动前台加密中继，生成原生移动端配对二维码与链接，详见 [手机远程访问](REMOTE.md)。 |

环境变量 `BINY_AGENT_DIR` 可统一重定向配置与运行数据目录；访问同一数据的 Desktop、Host 与 CLI 须保持该变量一致。脚本调用时传 `--json` 会将结构化结果输出至 stdout，失败信息写入 stderr 并返回非零退出码。

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

- **全局配置读写**：`config get/set` 读写全局配置文件，不改写当前项目的局部覆盖。`config set` 输入优先按 JSON 类型解析（如 `true`、`45`、`null` 或对象）；查询结果中的密钥等敏感信息自动打码脱敏。
- **模型管理**：`model list` 整合已配置别名与本地模型目录缓存；`model set <alias>` 设置全局默认模型。若项目 `.biny/settings.json` 单独指定了 `defaultModel`，则当前项目优先遵循项目覆盖。
- **添加 Provider 连接**：编写配置文件（例如 `provider.json`）并执行导入：

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

`provider add` 不覆盖同名连接；若连接仍被模型别名引用，`remove` 会报错拒绝并保留原配置。更多参数与凭据存储机制见 [模型与配置](CONFIGURATION.md)。

- **外观偏好管理**：

```bash
biny config set themePreference system --json
```

`themePreference` 可设为 `system`、`light` 或 `dark`；字体偏好通过 `fontPreference` 控制。

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

### 会话生命周期与检索

- `session create`：在当前工作区 Host 中创建空白会话，不触发模型请求。
- `session messages`：分页拉取指定分支的消息流，包含压缩前原始记录；默认预览 80 字符，加 `--full` 查看完整正文与结构化工具数据。
- `session search`：在当前工作区按会话 ID、标题、标签与消息正文检索，返回目录元数据；跨项目全局检索请使用 `biny history search`。
- `rename / pin / unpin / archive / unarchive / duplicate / delete`：通过 Desktop 维护会话元数据（支持传 `--revision` 进行版本防冲突核对）。删除操作仅抹除会话事件，绝不删除工作区项目文件；运行中会话拒绝删除。

### 用量核算与工具直调

- `session usage`：查询指定会话的 Token 消耗、费用估算与请求统计。
- `biny usage`：汇总全局运行目录已落盘的本地历史用量（基于运行事件 ID 去重）。
- `tool list`：查询当前会话已注册的可用工具目录及参数 Schema。
- `tool call <name> [JSON]`：**不请求大模型**，直接通过所属 Host 工具执行器执行底层工具。调用严格遵循参数校验、路径权限、审批规则与审计日志；要求会话处于空闲状态。调用进程退出或按 `Ctrl+C` 时，Host 自动取消该次执行并安全收尾。

会话恢复、导出与导入规则见 [会话与恢复](SESSIONS.md)。

## 项目、预览与终端

### 项目管理

```bash
biny project list --json
biny project show <project-id> --json
biny project add /path/to/existing-project --json
biny project create /path/to/new-project --json
biny project rename <project-id> "项目名称" --json
biny project remove <project-id> --json
```

- `add`：将本地既有目录登记为 Desktop 项目。
- `create`：新建物理目录并完成登记。
- `remove`：仅从 Desktop 侧栏移除登记，保留全部项目文件与历史记录。

### 本地预览与嵌入终端

在项目目录下执行（或在任意目录传 `--project <project-id>`）：

```bash
biny preview detect --json
biny preview start --entry pages/demo.html --json
biny preview status --json
biny preview stop --json

biny terminal list --json
biny terminal create --name work --json
biny terminal read <terminal-id> --json
biny terminal write <terminal-id> $'pwd\n' --json
biny terminal close <terminal-id> --json
```

- **页面预览**：`detect` 自动探测项目开发服务器或静态 HTML 站点；`start` 启动静态服务或开发服务器，`stop` 关闭预览。
- **嵌入终端**：复用 Desktop PTY 命名槽。`write` 原样发送输入（示例为 Shell 换行写法 `$'pwd\n'`）；`read` 读取最近 256 KiB 回放缓冲区。

## 用户资料与具名子代理

### 用户画像

```bash
biny user show --json
biny user set "项目文档使用中文；提交说明使用英文。" --json
```

`user` 命令用于维护长期用户偏好，具备正文规范化与版本检查机制；人格设定由 `soul` 管理。

### 编辑人格（SOUL.md）

```bash
biny soul edit
```

- **编辑器解析**：优先读取环境变量 `VISUAL`，其次读取 `EDITOR`；macOS 默认回退至 `open -e`。
- **安全参数解析**：编辑器值按标准参数引号规则解析，不经过 Shell，避免恶意指令注入；Soul 文件路径固定作为末尾参数追加。

### 具名子代理定义

```bash
biny agent list --json
biny agent show reviewer --json
biny agent create reviewer --file reviewer.md --json
biny agent create reviewer --file reviewer.md --global --json
biny agent delete reviewer --json
```

- **创建规则**：`create` 接收带 YAML frontmatter 的 Markdown 文件（`name` 需匹配命令参数，包含 `description` 与正文）。
- **作用域优先级**：默认保存在项目级 Agent 目录，传 `--global` 写入全局配置；同名定义**项目级优先于全局**。删除项目定义后自动显露全局同名配置。详见 [扩展与子代理](EXTENSIONS.md#子代理)。

## 内置浏览器

通过 `biny iab` 操作 Desktop 运行中的内置浏览器服务（与 Chrome Relay 的 `biny browser` 区分）：

```bash
biny iab envs --json
biny iab status --json
biny iab goto https://example.test --env Work --json
biny iab info --json
biny iab click '#save' --json
biny iab fill '#query' '项目 CLI' --json
biny iab press Enter --selector '#query' --json
biny iab scroll 600 --json
biny iab screenshot --out page.png --json
biny iab eval 'document.title' --json
biny iab cdp Page.getNavigationHistory '{}' --json
biny iab viewport set 390 844 --mobile --json
biny iab viewport reset --json
```

### 文件传输与数据导出

```bash
biny iab upload 'input[type=file]' reports/summary.pdf --json
biny iab download https://example.test/report.pdf --out report.pdf --json
biny iab download-media 'video' --out clip.mp4 --json
biny iab export pdf --out page.pdf --json
biny iab export md --out page.md --json
biny iab export-gsuite docx --out document.docx --json
```

- **安全边界**：读写文件必须位于当前工作区内，禁止访问受保护路径；单次上传最多 10 个文件且总计 ≤8 MiB，下载单文件 ≤8 MiB，输出文件不可覆盖已有文件。

### 弹窗、标签页与环境隔离

```bash
biny iab dialog watch --json
biny iab dialog accept "确认回复" --json
biny iab dialog dismiss --json
biny iab tab list --json
biny iab tab new https://example.test --env <environment-id> --json
biny iab tab select <tab-id> --json
biny iab tab float <tab-id> --json
biny iab env create --file browser-environment.json --json
biny iab env import-cookies <src-env-id> <dst-env-id> --json
biny iab profile list --json
biny iab profile history <profile-id> --query github --limit 50 --json
```

- **网页弹窗**：`dialog watch` 监听 alert/confirm/prompt，支持手动 `accept/dismiss` 或自动处理。
- **环境与 Cookie**：支持创建隔离的浏览环境并独立管理站点 Cookie，详细说明见 [浏览器](BROWSER.md)。

## 其他命令入口

| 功能类别 | 核心命令 | 专题指引 |
| --- | --- | --- |
| **初始化与诊断** | `init`、`doctor`、`acp` | [模型与配置](CONFIGURATION.md)。 |
| **终端交互与执行** | `chat`、`tui`、`run`、`resume` | [会话与恢复](SESSIONS.md)。 |
| **长期记忆与日记** | `memory`、`history`、`diary`、`reflection`、`heartbeat` | [长期记忆](MEMORY.md)。 |
| **桌面活动与日志** | `activity` | [活动记录与 Appshots](ACTIVITY.md)。 |
| **人格与情绪作息** | `soul`、`emotion`、`fatigue`、`sleep`、`wake`、`rest`、`selfie`、`travel` | 终端运行 `biny <模块> --help`。 |
| **对象双链与引用** | `ref` | [扩展](EXTENSIONS.md)。 |
| **任务目标与自动化** | `todo`、`task`、`goal`、`plan`、`graph`、`automation` | [目标与自动化](AUTOMATION.md)。 |
| **交互提问** | `input` | [扩展](EXTENSIONS.md)。 |
| **Skills 与外部导入** | `skill`、`imports` | [Skills](EXTENSIONS.md#skills) 与 [从其他应用导入](IMPORTS.md)。 |
| **桌面控制** | `computer`、`cu` | [Computer Use](COMPUTER_USE.md)。 |
| **多媒体与可视化** | `image`、`video`、`widget` | [模型与配置](CONFIGURATION.md)。 |
| **Telegram 渠道** | `telegram` | [模型与配置](CONFIGURATION.md#telegram-渠道)。 |
| **后台服务与评测** | `daemon`、`runtime-host`、`eval` | [架构](ARCHITECTURE.md)、[评测](EVALUATION.md)。 |

源码入口：[命令注册](../src/cli/index.ts)、[配置操作](../src/config/commands.ts)、[Desktop 命令服务](../src/desktop/electron/main/DesktopCommandService.ts)。

## 截取 Biny 窗口

在 Desktop 中按快捷键 `Cmd/Ctrl+Shift+S`，或通过菜单「视图 → 截取窗口…」唤出窗口截取工具：
- **截取范围**：可选取整个应用窗口或当前内容工作区。
- **编辑与美化**：支持拖拽、滚轮缩放、矩形裁剪、选区脱敏打码（支持撤销/重做），可自定义纯色、照片或透明背景并调节边距阴影。
- **隐私保护**：内置「会话标题打码」与「邮箱脱敏」开关，即开即用，直接输出安全合成图。

命令行自动化截图：

```bash
biny capture --scope content --out ./biny-content.png --json
biny capture --rect 240,60,900,600 --out ./biny-region.png
```

- 连接正在运行的 Desktop，默认对侧栏与顶部标题打码；传 `--no-privacy` 保留原始标题。
- 仅截取 Biny 自身的应用窗口，不申请 macOS 屏幕录制权限，不读取其他应用界面。
