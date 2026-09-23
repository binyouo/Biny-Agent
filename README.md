<h1 align="center">Biny</h1>

<p align="center">本地优先的开发协作 Agent，面向 macOS 的 Desktop、TUI 与 CLI。</p>

<p align="center">
  <a href="https://github.com/JubinJean/Biny-Agent">GitHub</a> ·
  <a href="#about">About</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#development">Development</a>
</p>

> 🚧 This project is under active development. APIs, commands, and behavior may change as the implementation evolves.

## About

Biny 是一个用于本地工作的 AI Agent 底座。它支持在同一套会话中完成对话、任务执行、文件与项目上下文处理，目标是让工作在本地环境内连续、可追踪、可恢复。

项目面向两类用户：

- 用户：直接用桌面端或终端启动助手，处理日常工作。
- 开发者：扩展工具链、接入 MCP/Plugin/Skill，并参与本地运行时能力建设。

## Features

- Desktop、TUI、CLI 多入口统一会话与配置。
- 会话和上下文优先落在本地，默认减少对云端状态的依赖。
- 任务能力支持轻量清单、可恢复流程和长期目标。
- 本地记忆与活动记录用于跨会话延续。
- 可通过 MCP、Plugin、Skill 扩展外部能力。

记忆管理、历史检索、Sleep 与本地接口见下方[记忆使用指南](#记忆与历史检索)。

## Quick Start

```bash
git clone https://github.com/JubinJean/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

初始化可以重复执行，不会覆盖已有配置。完成后配置模型连接：

- Desktop：在设置页配置模型；
- CLI：也可用 `providers.<alias>.apiKeyEnv` 指定密钥来源。

```bash
export DEEPSEEK_API_KEY="YOUR_API_KEY"
pnpm dev -- doctor
```

## Usage

### Desktop

```bash
pnpm desktop:dev
```

### TUI / Chat

```bash
pnpm dev -- tui
pnpm dev -- chat
```

### One-shot Command

```bash
pnpm dev -- run "梳理这个仓库，并说明最优先的风险点"
```

查看完整命令参数：

```bash
pnpm dev -- --help
```

## 记忆与历史检索

事实记忆保存在 `~/.biny/agent/memory/memory.sqlite`，所有工作区共享一个库。切换项目不会隔离记忆；标签不是权限边界。没有 `selector`、`scope` 或按项目清空参数。

### 日常操作

```sh
biny memory add "用户喜欢简洁中文回答"
biny memory add --entry '{"content":"用户喜欢简洁中文回答","tags":["preference"],"importance":0.5}'
biny memory list
biny memory search "回答偏好" --tag preference
biny memory get <id> --json
biny memory update <id> --entry '{"content":"更新后的事实"}'
biny memory stats --json
biny memory archive-entry <id> --yes
biny memory archived --json
biny memory restore <archive-id>
biny memory delete <id> --yes
biny memory clear --yes
```

`add` 接受正文或结构化 JSON，二选一。支持 `content`、`tags`、`importance`、`durability`、`rationale`。重要性默认 0.5，持久性为 `permanent` 或 `temporary`。多个搜索标签按任意一个匹配。

自动召回依赖 embedding，失败时不注入事实。显式搜索可降级到词法检索，结果含降级信息。向量索引是可重建的派生数据；索引失败不撤销已保存的事实。

`archive-entry` 可恢复，恢复使用归档列表里的 ID；`delete` 永久删除目标；`clear` 删除整个共享库的活跃和归档事实，不能恢复，但不删除会话 JSONL。

记忆写操作不再要求 `expectedRevision`，由 SQLite 事务保证原子提交；版本计数只标记内容变更。内部记忆协议不再使用 `-v3` 后缀，CLI、Desktop 与宿主需要一起重建并重启。

### 原文与 Markdown

```sh
biny history search "发布检查" --json
biny memory grep "a[b].ts" --json
biny memory archive
```

检索前增量刷新本机旧会话，只检索用户和助手原文，不把工具输出当成对话事实。`grep` 按字面子串查找，不解释正则表达式。

`memory archive` 表示立即导出会话原文到 `~/.biny/agent/threads/<session-id>.md`，不再表示归档单条事实；后者使用 `archive-entry`。Runtime Host 启动时补写旧会话，存活期间每 30 分钟更新，正常退出前再补写一次。未变化的 Markdown 不重写，正在追加的半行留待下一轮；失败会话下次重试，结果可查看 `threads/.mirror-status.json`。导出不调用模型、不删除原始 JSONL；原会话删除后，下一轮只清理带 Biny 生成标记的对应快照，用户自建文件和无标记的旧导出保留。

文件记忆使用 `~/.config/biny/MEMORY.md` 和 `memory/YYYY-MM-DD.md`，个人资料使用 `USER.md`，心跳清单使用 `HEARTBEAT.md`。设置 `BINY_AGENT_DIR` 会将配置和运行数据一起重定向，适合隔离测试。

### 自动写入与 Sleep

完成的对话可后台提取事实；聊天的记忆贡献开关控制这条路径，显式保存不受该开关影响。抽取使用对话文本并遵循外部上下文排除策略。缺少语义能力时自动贡献会跳过或延后，不宣称已保存。删除结果在会话元数据中标为 `deleted`。

```sh
biny memory sleep --json
biny memory sleep --preview --json
biny memory sleep --runs --json
biny memory sleep --run --yes --json
biny memory sleep --cancel --json
```

Sleep 默认每天本地时间 03:00 调度，处理重复、临时记忆过期、相似聚类及可选 LLM 合成。默认临时 TTL 和归档保留期均为 30 天。直接相似归档要求每条来源与保留事实达到阈值；用户在维护期间编辑的事实不会被旧决定归档，合成失败时来源保持可召回。预览不改事实；取消停止后续工作，不回滚已提交结果。启动时只恢复已失去执行权的中断运行，同日失败有退避限制。自动任务要求 Runtime Host 存活，不等于系统级唤醒。

Heartbeat 默认关闭；`biny heartbeat status`、`show`、`run` 用于查看和手动执行。全局配置的 `heartbeat` 控制自动间隔和活动时段；未增加群聊或 Telegram 通路。

### 本地 HTTP 接口

```sh
export BINY_MEMORY_API_TOKEN="$(openssl rand -hex 32)"
biny memory serve --port 23001

# 在已设置相同 token 的另一个终端请求
curl -H "Authorization: Bearer $BINY_MEMORY_API_TOKEN" \
  http://127.0.0.1:23001/api/memories
```

仅监听 `127.0.0.1`，要求 Bearer token，不提供浏览器跨域访问。不要把 token 写进仓库或聊天记录。退出 `serve` 会关闭 HTTP 服务，Runtime Host 继续运行。请求体使用 JSON，上限 64 KiB。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/memories?limit=20&offset=0` | 活跃事实分页 |
| `GET /api/memories/stats` | 数量、条目与维护快照 |
| `POST /api/memories` | 新增，正文为 `{ "content": "…" }` |
| `GET /api/memories/:id` | 读取，不存在返回 404 |
| `PUT /api/memories/:id` | 更新字段 |
| `DELETE /api/memories/:id` | 永久删除 |
| `DELETE /api/memories` | 清空活跃与归档事实 |
| `POST /api/memories/search` | `{ "query": "…", "tags": ["preference"] }` |
| `GET /api/memories/archive` | 归档列表 |
| `POST /api/memories/archive/:id/restore` | 恢复 |
| `GET /api/memories/sleep/status`、`/sleep/runs` | 维护状态与历史 |
| `POST /api/memories/sleep/run`、`/sleep/preview`、`/sleep/cancel` | 运行、预览、取消 |
| `GET /api/memories/rebuild-progress` | 索引状态 |
| `POST /api/memories/rebuild`、`/cancel-rebuild` | 重建、取消 |
| `GET /api/local-embeddings/models`、`/progress` | 本地模型状态 |
| `POST /api/local-embeddings/download` | `{ "model": "multilingual-e5-small" }` |
| `DELETE /api/local-embeddings/models/multilingual-e5-small` | 删除本地模型文件 |
| `POST /api/history/search` | `{ "query": "…", "literal": true }`，literal 可省略 |
| `POST /api/threads/archive` | 导出会话 Markdown |

事实读写和维护复用 Runtime Host。运行时拒绝返回 409；输入错误 400、未授权 401、来源拒绝 403、宿主错误 502。返回 Biny 原生结果，不承诺其它客户端的字段级兼容。

同一端口提供 `ws://127.0.0.1:23001/ws/memory` 只读订阅。握手必须带相同的 `Authorization: Bearer …` 请求头，不接受 URL token 或浏览器 Origin。连接和重连后发送当前快照，之后只推送变化，消息格式为 `{ "type": "…", "data": {}, "timestamp": "ISO 时间" }`：

- `memory-changed`：事实库版本与数量；收到后可通过 REST 拉取条目。
- `memory-sleep-progress`：Sleep 状态与运行记录。
- `memory-embedding-status`：模型及派生索引状态；`memory-rebuild-progress`、`local-embedding-progress` 分别推送重建和下载操作状态。
- `memory-stream-error`、`memory-stream-ready`：状态源暂时不可用及恢复。

数据库文件变化触发刷新，内存进度每秒采样；无订阅者时不读取状态。它是最新状态流，不是逐次变更审计日志，短暂中间状态可能合并。连接上限 32，慢消费者会断开并需重连补快照。退出 `serve` 会清理 WebSocket、文件监听和定时器。

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

如需在本地验证 TUI 改动，请在目标项目目录中执行 `biny tui` 或 `biny chat`，并先运行 `pnpm build:cli`。
