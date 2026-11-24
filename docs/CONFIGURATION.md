# 模型与配置

Biny 采用本地优先的配置体系：全局配置文件使用 `biny-config` v2，项目级设置使用 `biny-project-settings` v2。

Biny 将**服务商连接（Provider）**与**模型选择（Model）**解耦管理：一个服务商连接可提供多个模型；会话通过模型别名调用，别名映射到具体服务商与实际模型 ID。

## 配置存放在哪里

| 配置文件 / 目录 | 实际用途 |
| --- | --- |
| `~/.config/biny/config.json` | 全局配置：模型服务商、别名、权限、快捷键与扩展设置。 |
| `<项目>/.biny/settings.json` | 项目级配置：覆盖当前项目的默认模型、思考档位与运行参数。 |
| `~/.config/biny/models-store.json` | 服务商模型目录本地缓存。 |
| `~/.biny/agent/` | 按项目分区存储会话事件、索引与本地状态。 |

* **环境隔离**：设置环境变量 `BINY_AGENT_DIR` 可同时重定向配置目录与运行数据根目录。在使用同一套数据的 Desktop、CLI 与 Host 间需保持一致。
* **项目级覆盖支持字段**：项目配置仅接受受支持的运行字段（如 `defaultModel`、`thinking`、`agent`、`context`、`sandbox`、`checkpoints`、`diagnostics`）。项目文件引用的模型别名必须在全局 `models` 中已声明。

### 工作区指令预算

配置项 `context.instructionsMaxBytes` 限制工作区各级指令正文的累计 UTF-8 字节上限（不含路径与提示词包装标签）：
- 截断时严格保护 Unicode 代理对不被拆碎。
- 剩余可用预算大于 12 字节时，截断处追加换行与 `[truncated]` 标记；否则仅保留容纳的前缀文本。
- 计数与边界控制由 [WorkspaceContext](../src/agent/context/WorkspaceContext.ts) 负责，回归测试见 `tests/workspace-instruction-unicode-budget.test.ts`。

## 第一次配置

配置可通过命令行或 Desktop 桌面端完成。

### 命令行快速配置

```bash
biny config get --json
biny provider list --json
biny model list --json
biny model set <model-alias> --json
```

命令行管理与 Desktop 加密存储互通。具体命令与参数详见 [CLI 使用指南](CLI_USAGE.md#配置provider-与模型)。

### Desktop 桌面端配置

在源码开发环境下启动应用：

```bash
pnpm dev -- init
pnpm desktop:dev
```

在 Desktop「设置 → 模型服务商」中添加与管理连接：
1. **添加服务商**：选择 Provider 类型，填写服务商别名、API 端点（地址与协议收纳在「API 端点」中）与凭据。
2. **获取与添加模型**：点击「获取模型列表」自动同步服务商可用模型，或展开「手动添加」自定义模型 ID 与别名。
3. **测试连接**：点击「测试连接」会对选定模型发送真实探测请求，验证网络与凭据可用性。
4. **服务商与模型开关**：
   * **服务商总开关**（`providers.<别名>.enabled`）：停用时保留所有连接信息与模型偏好，阻止发起新请求；重新开启即刻恢复。
   * **单个模型开关**：控制该模型是否在输入框选择器中展示，关闭不删除配置。
   * **安全保存与回退**：保存或连接测试期间，编辑控件临时禁用以防丢字；若保存失败保留原输入并提示原因。

## 使用环境变量提供凭据

推荐将 API Key 存放于环境变量中，避免将敏感明文直接保存在配置文件里。以 DeepSeek 为例：

```json
{
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    }
  }
}
```

配置字段解析：
- `deepseek`：服务商别名（Provider Alias）。
- `deepseek-v4-flash`：Biny 内部引用的模型别名。
- `models.<别名>.model`：实际发给服务商的模型 ID。
- `apiKeyEnv`：环境变量名称。该变量必须对启动 Biny 的进程可见（从 Dock 启动 Desktop 不会自动继承终端中临时 export 的环境变量）。

## Desktop 设置的保存机制

设置底栏固定呈现「关闭」与「保存」，提示是否有未提交的表单草稿：
- **底栏一次性保存**：Coding Agent 后端选择、记忆策略、技能启用范围等表单设置，修改后需点击底栏「保存」统一生效；未保存时退出会有提示。
- **即时保存与生效**：模型服务商管理、API Key 修改、通用页的工具/视觉模型选择、Computer Use 开关、导入设置与插件管理在各面板操作后即时生效，不产生底栏待保存草稿。
- **Token 节省统计**：优先展示本地索引快照，回合结束后自动更新，无需手动刷新。

## 凭据安全存储与迁移

Biny 将凭据正文与普通配置文件分离保存：
- **存储介质**：macOS 命令行使用系统 Keychain；Desktop 及其独立 Electron Host 使用 Desktop 安全凭据存储；无持久安全存储的环境使用 `apiKeyEnv` 环境变量。
- **跨端凭据共享**：Desktop 启动时会登记自身路径，终端冷启动若检测到桌面加密凭据，可复用同一安装的 Electron Host 解密，无需重复录入。
- **旧配置平滑迁移**：若配置文件中存有历史内联 `apiKey` 或 OAuth `refreshToken`，读取时会自动迁移至系统安全存储，确认写入后自动擦除配置文件中的内联明文。
- **脱敏机制**：可在「设置 → 隐私脱敏」或执行 `biny config set redaction.enabled true` 开启发送前脱敏，详见 [隐私脱敏](PRIVACY.md)。

## Telegram 渠道

通过 `biny telegram run` 可将 Telegram 消息桥接至当前工作区的 Agent 会话。

### 基础环境与配置

1. 配置环境变量：
   * `BINY_TELEGRAM_BOT_TOKEN`：Telegram Bot Token（不会写入持久化配置）。
   * `BINY_TELEGRAM_OWNER_ID`：主人的数字 Telegram User ID。
   * `BINY_TELEGRAM_GROUP_IDS`：（可选）获准响应的群组或超级群数字 ID，多个用逗号分隔。
2. 运行桥接进程：`biny telegram run`（前台常驻运行）。

### 权限与交互规则

- **私聊**：主人的私聊直接映射为工作区独立 Session，具备完整的工具调用与 Skill 权限。
- **白名单群聊**：
  * 群成员 @提及 Biny 或回复 Biny 发送的消息时触发。
  * 主人发送的消息保留已配置工具；其他群成员触发的回合**自动禁用工具与 Skill**，仅作为问答回复，防止越权操作或泄露隐私。
  * **群巡查**：群静默至少 5 分钟后触发，单群 30 分钟最多巡查 1 次。巡查先使用工具模型，可回复群聊、私信主人或保持安静。
- **媒体与语音识别**：
  * 支持接收图片、贴纸、视频、音频与语音附件。单文件上限 20 MB，每条消息总附件上限 40 MB。
  * **本地语音识别**：配置 `BINY_TELEGRAM_WHISPER_MODEL`（Transformers.js 支持的 ONNX 模型 ID 或路径）可离线转写语音（需本地已安装 `ffmpeg`，转写限长 15 分钟）；亦可配置 `BINY_TELEGRAM_WHISPER_LANGUAGE` 指定语言。
- **主动通知与指令**：
  * 开启 Heartbeat 后，系统通知会自动转发给主人（前 200 字符去重保护）。
  * Agent 可通过 `biny telegram dm-owner <消息>` 主动私信主人；或在主人明确要求下通过 `biny telegram dm <用户ID> <消息>` 联系他人。相册原图仅允许发送至主人私聊。

## 模型切换与辅助请求

### Desktop 模型选择器

- **键盘导航**：按上下键浏览入口，按右方向键或 `Enter` 进入二级模型与推理强度选择，按 `Esc` 返回上一级或关闭选择器。
- **快速档位（Priority Tier）**：当前模型明确支持 `priority` 时，输入框会展示「快速」开关。开启后通过 Provider 请求优先服务档位；自定义网关需在模型 Profile 中声明 `serviceTiers: ["priority"]`。
- **切换时效**：当前已启动的回合保持准入时的模型；新选择从后续根回合开始生效。

### 辅助模型调度与请求头

- **`toolModel` 调度**：用于压缩、记忆提取、情绪分析与日记总结等后台任务。未显式配置时，依次尝试：预设辅助型号 → 当前聊天主模型 → 可用的其他服务商兜底。
- **费用独立计量**：辅助模型请求的用量与费用按实际选中的模型分别核算，不与主对话混淆。
- **请求头标识**：请求默认携带 User-Agent（`biny` 或 `biny-auxiliary`），请求头 `x-biny-operation` 区分操作类别，有会话时携带 `x-session-id`。

### 辅助请求的凭据续期与取消

复用同一 Provider 实例的并发文本请求共享进行中的凭据准备：
- 单个请求取消不会阻断其他正在等待的调用；仅当全部等待者均取消时才终止共享凭据准备。
- 实现见 [ProviderRuntime.ts](../src/llm/ProviderRuntime.ts) 与 [nativeJson.ts](../src/llm/nativeJson.ts)，回归测试见 [provider-credential-cancellation.test.ts](../tests/provider-credential-cancellation.test.ts)。

### 聊天输出额度与截断

- **`chat.maxOutputTokens`（最大令牌数）**：控制单次模型请求的输出上限（非全轮总额度）。留空默认沿用模型 Profile 声明；在高级设置中填写数值会全局覆盖该额度，点击“恢复自动”可清除覆盖。
- **思考模型与长度截断**：思考过程（Thinking Tokens）同样计入输出额度。当模型返回 `length` 截断时，Biny 保留已完成步骤，将回合标为“未完成”并允许继续生成；未执行完的工具调用不会被错误重放。
- **输入容量指示器**：输入区实时呈现最近请求的输入 Token 占上下文窗口的比例（使用 K/M 简写）。缺少声明时采用保守基准（默认 32K 或按输入上限折算），防止无限制超额。

## 图片生成

通过 `biny image generate` / `biny image edit` 调用多模态生图能力：

```sh
biny image models
biny image generate "a cat on a windowsill, afternoon light"
biny image generate --aspect 16:9 "cinematic landscape"
biny image edit /path/to/source.jpg "make the background blue"
```

- **模型配置**：`imageGen.model` 指定默认生图模型（如 `gem:gemini-2.5-flash-image` 或 OpenAI 兼容图片端点）。
- **本地安全模型（NSFW 约束）**：`imageGen.localModel` 专供 `biny selfie take --nsfw` 使用，严格限定为 `localhost`、`127.0.0.0/8` 或 `::1` 的本地 loopback 地址，坚决拒绝远程转发或回退到公网模型。
- **参数控制**：`--aspect`（或 `--size`）覆盖默认比例（如 `16:9`、`1:1`）；`--reference <路径>` 可指定参考图（限 20 MiB 内）。
- **产物与超时**：图片输出至独立临时目录，单张限制 20 MiB；生成超时默认为 5 分钟，下载超时为 30 秒。

## 视频理解

当 Agent 收到视频或需要阅读视频时，可通过视频阅读 Skill 调用 `biny video analyze`：

```sh
biny video analyze /path/to/clip.mp4 "总结关键事件并标出时间戳"
biny video analyze '@attachments/clip.mp4' "视频中的演讲者说了什么？"
```

- **格式与体积**：支持 MP4、MOV、WebM、AVI、MKV 等主流格式；本地文件支持至 2 GB，会话附件路径读取上限 40 MB。
- **执行机制**：优先调用 Gemini 原生接口，视频上传至 Gemini Files API，分析完成后立即触发远端删除。

## 桌面控制（Computer Use）

- 配置项 `computer.enabled` 默认为 `true`，首次实际调用时按需启动底层原生组件，启动前不会无故申请系统权限。
- 在 Desktop「设置 → Computer Use」中统一管理系统权限（辅助功能、屏幕录制）、受信任应用白名单、操作审计日志与画中画镜像；详细规则见 [Computer Use](COMPUTER_USE.md)。

## 本地配置检查与排查

运行 `biny doctor` 可诊断配置有效性：

```bash
biny doctor
```

命令会校验全局配置与当前工作区配置的 JSON 格式、类型约束与模型别名，通过时输出 `configuration: valid`；输出中会自动脱敏任何内联密钥。

### 常见排查速查

| 常见现象 | 排查方向 |
| --- | --- |
| **找不到模型别名** | 检查当前项目 `.biny/settings.json` 的 `defaultModel` 是否存在于全局 `models` 中。 |
| **缺少密钥或凭据失效** | 检查当前运行入口的安全存储（Keychain / Desktop Store）或环境变量 `apiKeyEnv`。 |
| **连接存在但调用失败** | 核对 Provider 端点协议、真实模型 ID、网络连通性及账户额度。 |
| **修改配置后当前轮次未更新** | 模型选择在回合开始时确定，新配置从后续根回合开始生效。 |
| **全局设置被覆盖** | 检查当前项目目录下是否存在 `.biny/settings.json` 覆盖了全局默认模型。 |

配置模式定义见 [schema.ts](../src/config/schema.ts)、[项目设置](../src/config/projectSettings.ts) 与 [paths.ts](../src/config/paths.ts)。权限机制见 [工具与权限](PERMISSIONS.md)。

## 子代理执行预算与权限

子代理默认执行至任务完成、用户取消或遇阻停止，亦可通过全局配置 `extensions.subagent` 设置硬性上限：
- **`maxSteps`**：模型调用最大轮数限制（1–100,000 轮）。
- **`timeoutMs`**：单任务总耗时硬上限（毫秒，含排队时间）。
- **`maxCostUsd`**：任务累计消耗费用上限（需模型价格元数据完整）。
- **`inactivityTimeoutMs`**：连续静默无活动超时（默认 300,000 ms，即 5 分钟），超时后标记为“无响应”并停止。

### 权限与沙箱隔离

- **严格父级审查**：子代理调用的每项工具均逐次通过父会话权限管理器校验。只读任务不暴露写操作与 Bash 工具。
- **命令沙箱**：工作区任务可在同等命令沙箱内执行构建或测试程序；系统无法落实安全限制时拒绝启动。
- **阻断状态回传**：权限被拒或需人工确认时，子代理保存失败现场并停止，卡片显示“权限受阻”或“待父代理处理授权”，由父会话决定后续动作，不私自盲目重试。

## ACP 外部 Agent

Desktop「设置 → 模型服务商」支持通过 Agent Client Protocol（ACP）接入外部 Agent（如 Claude Code 或 Codex）：

### 快速接入步骤

1. **安装适配器**：
   * Claude Code：`npm install -g @agentclientprotocol/claude-agent-acp` 并执行 `claude-agent-acp --cli auth login`
   * Codex：`npm install -g @agentclientprotocol/codex-acp` 并执行 `codex-acp cli login`
2. **连接与测试**：在 Desktop 服务商面板选择对应预设，点击「连接并保存」。Biny 会启动临时探测会话验证连通性。

### 配置范例与参数

```json
{
  "providers": {
    "external": {
      "type": "acp",
      "acp": {
        "command": "/absolute/path/to/codex-acp",
        "args": [],
        "env": { "API_KEY": "MY_AGENT_KEY" },
        "mcpServers": [],
        "allowMemory": false
      }
    }
  },
  "models": {
    "external-default": { "provider": "external", "model": "default" }
  }
}
```

* `command` / `args`：启动命令绝对路径与参数数组（不经 Shell 解析）。
* `env`：映射至子进程的环境变量（默认仅透传 PATH、HOME 等必要系统变量）。
* `timeoutMs`：连接握手超时（默认 30 秒）；`promptTimeoutMs` 为单轮执行超时（默认 30 分钟）。
* `allowMemory`：是否允许向外部 Agent 共享检索到的 Biny 记忆背景（默认 `false`）。
* `mcpServers`：指定转交的已启用 MCP 服务白名单（仅在完全访问模式下允许）。
* **会话绑定**：外部会话关联保存在 `.acp.json` 中，切换命令或账号时需新建聊天。

## 独立视觉模型

在「设置 → 通用」中可配置独立的视觉辅助模型（`visionModel` 与 `visionModelEnabled`）：
- **能力补充**：当主模型未声明图片输入能力时，图片附件与工具返回的截图先交由独立的视觉模型进行描述转述，再将结构化描述提交给主模型；主模型自身支持图片时直接接收原图。
- **Coding Agent 后端选择**：支持在「自动模式」（本地已安装 Claude Code 时优先，否则使用内置 Agent）、「内置 Agent」与「ACP Agent」之间切换，统一受会话权限体系管控。
