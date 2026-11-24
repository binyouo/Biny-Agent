# Computer Use

Computer Use 用于在 macOS 上对原生桌面应用进行观察与受控操作。Desktop 桌面端通过内置 MCP 协议提供工具；外部调用方可拉起独立 MCP 进程，开发者亦可通过 `biny cu` 命令行直接调用底层能力。

## 观察与输入的执行链路

```
[Agent 决策 / CLI]
       ↓ (MCP 协议)
[Desktop 桌面执行服务 / Controller]
       ↓
[macOS Native Helper 驱动]
       ↓
[读取无障碍控件树 / 窗口截图 / 局部事件注入]
```

- **统一单控制器**：桌面端所有操作均经由单一 Controller 与原生 helper 执行，避免并发控制器竞争。
- **动态凭据绑定**：观察结果绑定精确的 PID、窗口 ID、截图尺寸、有效控件 Token 与单次有效的捕获凭据（`captureId`，60 秒有效期且单次消费）。
- **生命周期分层**：
  * **模型观察结果**：为下一次操作提供目标定位依据，发生新动作或窗口变化后立即失效。
  * **监督预览（PiP）**：悬浮展示目标窗口实时画面，不生成模型凭据。
  * **窗口镜像**：独立的视频流或抓取会话，会话关闭时即刻释放资源。
  * **操作日志**：本地记录动作类型、耗时与执行结果元数据。

## 开启与 macOS 系统权限

Computer Use 配置项 `computer.enabled` 默认开启，但**在实际发起调用前不会无故启动后台组件或申请系统权限**。

在 Desktop「设置 → Computer Use」中开启功能并授予 macOS 原生权限：
1. **辅助功能（Accessibility）**：用于读取 UI 控件树、定位元素、触发无障碍动作及模拟键盘鼠标输入。
2. **屏幕录制（Screen Recording）**：用于截取目标应用窗口的画面供视觉模型解析。

系统能力快速诊断：

```bash
biny cu status --json
biny cu doctor --json
```

## 应用审批（Application Approval）

为防止 Agent 随意操作未经许可的敏感应用，Biny 提供应用级白名单管理：
- **首次自动授权**：默认模式下，首次操作某应用时自动记录授权。
- **严格审批模式（Strict Mode）**：开启后，仅允许操作已明确加入白名单的应用，任何未授权应用均被强制阻断（`full-access` 权限模式亦无法绕过严格审批）。

```bash
biny computer status --json
biny computer strict on --json
biny computer approve <bundle-id> --json
biny computer revoke <bundle-id> --json
```

撤销授权仅影响后续的观察与动作，无法撤回已经落盘的系统调用。

## 内置 MCP 与操作工具

Desktop 启动后自动连接内置 `computer-use` MCP 服务，无需手动添加配置。核心工具集包括：
- `ComputerList`：枚举当前运行的应用、前台聚焦状态及可用窗口清单。
- `ComputerLaunch`：启动目标应用并等待其窗口就绪。
- `ComputerObserve`：获取指定窗口的截图、控件树与捕获凭据 `captureId`。
- `ComputerAction`：在有效 `captureId` 基础上执行点击、文字输入、按键或滚动。
- `ComputerSequence`：在同一窗口连续执行 1–5 步紧凑操作。
- `ComputerMirror`：开启窗口画中画镜像。

必须遵循**先观察，再操作**原则。禁止凭空猜测坐标或复用跨窗口的陈旧引用。

## 后台局部投递机制

Biny 的输入模拟默认采用**窗口局部事件投递**，最大程度减少对用户正常工作的干扰：
- **无感交互**：直接向目标进程窗口分发事件，不抢夺全局鼠标指针，不随意弹窗切换前台焦点。
- **自绘应用兼容**：针对无标准 AX 控件的自绘界面（如部分游戏或定制应用），支持直接基于截图像素坐标点击，并向已聚焦处输入文字。
- **键盘与按键支持**：
  * `type_text`：支持 `auto`、`physical`（按当前键盘布局映射物理键码）、`unicode`（文字写入）与 `ax`。
  * `press_key`：支持组合键与功能键（如 `cmd+s`、`ctrl+shift+t`、`cmd+opt+esc`、`F1`、`Return`）。若目标窗口未聚焦，会自动尝试匹配并执行对应的无障碍菜单快捷键。

## 连续动作与条件等待

```bash
biny computer sequence '{"pid":42,"windowId":"900","captureId":"凭据","actions":[{"action":"type_text","text":"Biny"},{"action":"press_key","key":"Return"}]}' --session edit --json
```

- **连续执行（`ComputerSequence`）**：在同一窗口内连续执行最多 5 步简单动作（总限时 15 秒）。首步支持元素定位，后续仅允许向焦点连续按键或输入文字；任一步骤遇阻或失败立即终止后续动作。
- **轻量仅截图模式（`content: "image"`）**：跳过控件树深度遍历，仅抓取最新窗口截图并派发坐标凭据，显著提升视觉推理速度。
- **条件等待（`waitFor`）**：支持轮询等待目标控件标题或文本出现（例如 `{"text":"已保存","timeoutMs":5000}`），匹配成功立即返回。

## 窗口画中画镜像（PiP）

```bash
biny cu pip open <window-id> --pid <pid> --json
biny cu pip open <window-id> --pid <pid> --on-minimize --json
biny cu pip list --json
biny cu pip close --all --json
```

- **悬浮置顶预览**：在屏幕上实时置顶呈现目标窗口的当前画面，甚至在其他 Spaces 与全屏应用中也可浮动展示。
- **操作指示器（Lens）**：在目标窗口上以橙色指示器清晰标注 Agent 的点击落点与输入动作，约 8 秒静默后自动淡出。通过 `biny cu lens off/on` 可随时关闭或开启该指示。

## 外部独立 MCP 与 CLI

### 独立 MCP 服务

可将 Biny Computer Use 作为独立 MCP 提供给其他客户端：
- **stdio 协议**：`biny computer mcp`
- **本地回环 HTTP 协议**：`biny computer mcp --http --port 0`（支持 Bearer Token 认证与 1 MiB 载荷限制）。
- 兼容 `sky_` 前缀工具族（如 `sky_list_apps`、`sky_get_app_state`）。

### 开发者直接 CLI（biny cu）

```bash
biny cu windows <pid> --json
biny cu get_app_state <pid> --window <window-id> --json
biny cu click --pixel 120 80 --pid <pid> --window <window-id> --json
biny cu type_text "Hello" --pid <pid> --json
```

`biny cu` 是为开发者提供的直接原生测试工具，不经过 Agent 审批管线。Agent 自身在执行任务时严禁通过 Shell 调用 `biny cu` 绕过安全拦截。

窗口附件快捷键见 [活动记录与 Appshots](ACTIVITY.md#appshots)，通用授权说明见 [工具与权限](PERMISSIONS.md)。
