# 手机远程访问

Biny Desktop 提供手机配对入口：在「设置 → 远程访问」连接自托管中继后显示二维码和配对链接，访问授权这台 Biny 上的全部项目。后续原生 iOS App 使用这些信息建立端到端加密连接，在项目列表中选择项目后查看会话、发送消息、停止运行并处理工具授权。运行和写入由电脑上对应项目的 Runtime Host 管理，配置、权限及会话记录与本地客户端共享。

目前完成的是桌面入口及移动端协议，原生 iOS App 尚未发布。二维码不是网页地址，不会打开浏览器聊天页；iOS App 接入前，不能仅靠手机相机完成远程使用。

## 桌面端配对

1. 准备自己管理的 [alma-relay](https://github.com/yetone/alma-relay) 服务，以 HTTPS 对外提供访问。Biny 使用第一版隧道协议的注册与 WebSocket 转发帧。
2. 打开 Biny 的「设置 → 远程访问」，填写中继地址。如果中继要求注册密钥，填写可选的注册密钥。
3. 点击「开启远程访问」。中继确认注册后显示二维码，可以复制同一份配对链接。中继连接成功与手机已连接分别显示；只有完成加密认证的设备计入在线数量。
4. 原生 App 接入后，在 App 中扫码或粘贴配对链接，再从项目列表中选择要操作的项目。各项目的 Runtime Host 按手机端请求接入，打开或新建会话时才连接对应 Host。

「重新生成」会关闭原有手机通道并生成新码，旧链接随即失效。「关闭远程访问」或完全退出 Biny 会撤销本次连接，但不会取消已经提交给 Host 的任务。需要停止任务时，应通过已连接的手机或本地客户端明确取消。关闭设置窗口不关闭远程访问。

中继地址、注册密钥及配对码只用于当前应用运行，不自动持久化或开机启用。应用重启后需要重新开启。二维码和链接包含访问凭据，只交给自己的设备；注册密钥不出现在二维码中。

## CLI 入口

在项目目录保持前台远程连接：

```bash
cd /path/to/project
biny remote run --relay https://relay.example.com
```

中继确认注册后输出连接码和原生配对链接。注册密钥通过 `BINY_RELAY_REGISTRATION_KEY` 环境变量提供。`--json` 在 stdout 输出一条含 `relay`、`code`、`pairingUrl` 和 `workspace` 的配对记录；后续状态写入 stderr。

保持终端运行，Ctrl+C 撤销本次远程访问。CLI 的配对与 Desktop 开启的配对分别持有连接。模型凭据沿用现有配置；由 Desktop 管理的凭据仍需要相应 Desktop 运行时可用。

## 原生客户端协议

配对链接格式为：

```text
biny://connect?v=1&e2e=1&u=<编码后的中继 origin>&k=<连接码>
```

`v=1` 标识 Biny 移动协议，`e2e=1` 表示必须使用端到端加密。`u` 是 HTTPS 中继 origin，`k` 是 32 个随机字节的无填充 base64url 编码（43 字符）。原生客户端需要注册 `biny` URL scheme 并解析这些字段，也可以直接解码二维码中的同一链接。

连接步骤与权威实现：

- 按 [crypto.ts](../src/remote/crypto.ts) 的 `routingToken` 从连接码派生路由 token，建立 `wss://<relay>/c/<token>/__biny_e2e__` WebSocket。
- `hello` / `welcome` 使用 P-256 ECDH 临时密钥，HMAC-SHA256 认证双方转录，HKDF 派生两个方向的 AES-256-GCM 密钥。派生参数、编码与 nonce 序号必须遵循同文件实现。序号拒绝重放、乱序和跨连接复用。
- 认证后使用 [api.ts](../src/remote/api.ts) 中的 `remoteRequestSchema`：`projects`、`sessions`、`open`、`create`、`history`、`send`、`cancel`、`permission`。请求携带 UUID `id`；`projects` 返回可选项目清单，`sessions`/`open`/`create` 携带 `projectId` 指定目标项目，其余会话动作携带明确的 `sessionId`，与该设备所选会话不匹配时拒绝执行。
- `response` 携带对应 `id` 及 `result` 或 `error`；`update` 携带当前会话视图与事件类型。列表和历史每次读取 20 项；正文在用户消息和回合终态后按需读取，不随每个 token 拉取全量历史。
- 断线和重连不得自动重发消息或授权答复；操作结果未知时先读取会话确认。取消携带 run ID；授权只允许本次或拒绝，需要完整确认的操作须携带 `yes`。

协议允许原生实现独立于 Web Crypto，但必须保持相同字节编码与认证规则。当前测试通过 Node 客户端验证协议，没有宣称 Swift/CryptoKit 互通已验收。

## 数据与限制

电脑主动连接中继，不需要开放入站端口。中继只收到派生路由标识和加密帧；仍能看到连接和流量元数据。电脑端拒绝明文 HTTP 请求和其他 WebSocket 路径，不开放任意 Host RPC。每条通道最多 1 MiB 加密消息，最多同时连接 8 台设备；超限或阻塞会关闭相关通道。生产使用 HTTPS，只有本机调试允许 loopback HTTP。

尚不提供附件、桌面画面、手机推送或设备长期信任管理。退出、取消、重新生成均不重放操作，不扩大既有工具权限。

## 实现与验证入口

[SettingsRemoteAccess.tsx](../src/desktop/renderer/src/components/settings/SettingsRemoteAccess.tsx) 展示设置入口；[access.ts](../src/remote/access.ts) 管理连接生命周期；[tunnel.ts](../src/remote/tunnel.ts) 实现中继适配；CLI 入口见 [remote.ts](../src/cli/commands/remote.ts)。二维码使用本地依赖生成，不把链接发送到外部二维码服务。

`node scripts/run-tests.mjs remote-` 覆盖加密、真实本机 HTTP/WS、主窗口 IPC 校验、配对轮换与停止，以及构建后 CLI、真实 Host、授权和持久会话。`node scripts/run-tests.mjs settings-remote-access` 覆盖设置状态、二维码显示条件及复制操作。模型端使用本地替身。真实 iOS 扫码、手机网络、公网中继和桌面视觉交互仍需人工验收。
