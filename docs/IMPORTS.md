# 从其他应用导入

在 Desktop 的“设置 → 导入”检测来源，选择要导入的模型设置、MCP 服务器和会话，再选择目标项目。项目菜单里的“导入会话”也会打开此页面。预览不会修改来源或创建会话，提交后逐项显示已导入、已跳过、失败或结果待确认。

## 支持的来源

| 来源 | 读取内容 |
| --- | --- |
| Claude Code | `~/.claude/settings.json`、`~/.claude.json` 中可表达的模型与全局 MCP 配置，以及 `~/.claude/projects/` 下的 JSONL 会话。 |
| Codex | `~/.codex/config.toml` 中可表达的模型与 MCP 配置、API-key 认证配置，以及 `~/.codex/sessions/` 下的 rollout JSONL。 |
| ChatGPT | 用户选择的官方导出 JSON：会话数组，或其中一个带 `mapping` 的会话对象。编号导出 JSON 文件可分别选择。 |

ChatGPT 导出包含多条会话时可以逐条选择。导入沿 `current_node` 的父链读取当前分支；缺少该字段时只接受能够唯一确定的链。损坏、循环或分支不明确的记录会拒绝导入。仅转换公开的用户与助手文本；媒体、文件、隐藏消息、system 和工具消息会报告跳过，不恢复远端工具或抓取附件链接。ZIP、网页共享链接和任意第三方导出格式不在当前解析范围内。

新导入的会话拥有独立的 Biny 消息身份，日期详情、消息引用和分支使用这些身份；来源标识作为出处保存。缺少有效时间的消息不会以导入时间补造。旧导入日志不自动改写。

## 配置与结果

模型设置和 MCP 属于全局配置；目标项目仅决定会话归属。模型配置添加为来源对应的独立别名，保留 Biny 当前默认模型。已有同名模型或 MCP 服务器会跳过；不能准确转换的认证、配置或字段也会跳过并说明，不猜测其含义。OAuth 登录不迁移，模型和 MCP 的凭据通过 Biny 的凭据存储保存，预览和导入历史不显示其值。

MCP 导入后默认停用，可以在“设置 → MCP 服务器”检查并启用。导入后刷新空闲运行实例；刷新失败会提示重启，已成功导入的配置保留，不重复导入。导入不会运行来源中的 MCP 命令或会话工具。来源文件保持只读；预览之后来源发生变化，需要重新预览。

历史记录逐项保留状态。同一来源项及相同内容重复提交会跳过：会话按目标项目去重，模型和 MCP 按全局配置去重；有变化的会话保存为新会话，原聊天保留。写入已开始但结果无法确认时显示“结果待确认”，停止自动重放，请先检查目标内容。附件导入清理无法确认归属时保留文件并报告残留路径。

## 自动同步

首次选择导入内容后，可以开启“保持导入同步”。Desktop 每分钟检查已选的来源项；“自定义”可修改或清空选择，“立即检查”执行一次同样的检查。配置冲突继续跳过，来源中没有选中的新会话不会自行导入。关闭同步保留历史和选择；停用操作等待当前已准入的导入批次结束，返回后不再启动同步。清空最后一组选项会同时关闭同步。

同步设置与历史保存在本机，Desktop 运行时执行周期检查。运行任务或设置事务未恢复时暂停写入；其他设置有未保存更改时也不会自动导入。退出应用后不会保留额外的导入后台进程。

## CLI

CLI 与 Desktop 使用同一导入实现，目标是执行命令时的项目目录。

```bash
biny imports --json
biny imports preview claude --json
biny imports preview codex --json
biny imports preview chatgpt --file conversations.json --json
biny imports run <preview-id> --item <item-id> --json
biny imports enable-sync --json
biny imports sync --json
biny imports disable-sync --json
```

`run` 的 item ID 来自预览，可一次选择多项。`select-sync` 保存同步范围，参数见 `biny imports select-sync --help`。CLI 的 `sync` 执行单次检查，不启动常驻进程。

单条 ChatGPT 会话也可以直接导入：

```bash
biny session import conversations.json --format chatgpt --conversation <conversation-id> --json
```

文件中只有一条会话时可省略 `--conversation`。多条会话使用导入中心预览获得选择 ID。直接 `session import` 每次创建新会话；持久去重与同步选择由 `imports` 管理。

每个导入中心预览最多 256 项，目录扫描最多检查 4,096 项，来源读取总量上限 64 MiB；来源配置单文件上限 2 MiB。达到扫描上限会提示，不能将截断结果理解为完整来源。最近 50 次导入历史保留在本地，去重收据独立保存，收据达到 4,096 项时停止新增写入。

一般会话导入导出见 [会话与恢复](SESSIONS.md)，配置管理见 [模型与配置](CONFIGURATION.md)，MCP 启用见 [扩展](EXTENSIONS.md)。
