# Computer Use

Computer Use 用于观察和操作 macOS 原生应用。Biny 内置工具与外部 MCP 使用受控执行入口；直接 `biny cu` 命令提供本机用户调用的原生入口。

## 观察与输入的执行链路

内置工具和外部 MCP 将请求交给受控 Controller，由原生 driver 与 macOS helper 执行辅助功能读取、窗口捕获及输入。Controller 管理启用状态、会话所有权、应用授权、当前观察与取消；helper 完成系统调用并返回结果。系统权限与 Biny 应用授权在不同层检查。

观察结果绑定精确 PID、窗口、捕获身份、截图尺寸及可用控件 token。输入需要使用当前有效的观察，并在派发前再次确认目标与授权；切换控制状态、撤销授权或取消会使旧观察失效。坐标与控件引用描述一次观察中的目标，不能作为跨窗口或跨进程的永久地址。

| 资料 | 用途与生命周期 |
| --- | --- |
| 模型观察结果 | 为下一次输入提供目标与控件依据，按 Controller 状态失效。 |
| 监督预览 | 临时显示目标画面，像素刷新不改写观察凭据，不进入活动历史作为记录。 |
| 窗口镜像 | 独立捕获与监听会话，关闭或连接结束时释放所属资源。 |
| 动作日志 | 开启后保存动作类型、目标、耗时和结果等本地元数据。 |

动作有未派发、已完成和结果未知等结果边界。系统调用已经派发后发生取消或断线，不能把它解释为没有操作目标，也不能自动重复动作。

## 开启与系统权限

产品内 Computer Use 默认关闭。在 Desktop 的“设置 → Computer Use”开启，并按设置页引导授予 macOS 辅助功能和屏幕录制权限。

辅助功能用于读取控件与操作，屏幕录制用于捕获窗口。授权其中一项不代表另一项可用；应用重新构建后系统可能需要重新确认授权。先在设置页测试，失败时根据实际权限状态重试。

```bash
biny cu status --json
biny cu doctor --json
```

这些命令检查原生 helper 与系统能力。它们通过不代表某个目标应用已获产品授权。

## 应用审批

应用授权在“设置 → Computer Use”管理，并跨会话保存。严格审批默认关闭，首次使用应用时自动保存授权；开启严格审批后，只允许已批准应用，通用工具的自动批准不覆盖此条件。

```bash
biny computer status --json
biny computer strict on --json
biny computer approve <bundle-id> --json
biny computer revoke <bundle-id> --json
```

批准和撤销操作针对已发现的应用记录。`bundle-id` 标识应用，PID 标识当前运行实例；不能用旧 PID 推断当前应用身份。审批存储错误、身份无法确认或目标冲突时停止执行。

撤销影响后续观察与输入，不能撤回已经派发的动作。记录只保存应用授权与使用元数据，不保存输入正文或截图。

## 观察再操作

内置工具包括 `ComputerList`、`ComputerObserve`、`ComputerAction` 与 `ComputerMirror`。输入使用当前有效观察结果中的精确应用、窗口和控件引用；预览画面用于监督，不能代替模型观察凭据。

直接 CLI 可以先列窗口，再观察指定目标：

```bash
biny cu windows <pid> --json
biny cu snap <pid> --window <window-id> --json
```

PID 和窗口 ID 使用当前返回值。输入方式、控件可写性和窗口存在性按本次观察确认，不复用另一个窗口的引用。动作取消或结果不明时，先重新观察，不自动重复输入。

## 按窗口镜像

```bash
biny cu pip open <window-id> --pid <pid> --json
biny cu pip open <window-id> --pid <pid> --on-minimize --json
biny cu pip list --json
biny cu pip close --all --json
```

普通镜像实时显示指定窗口；`--on-minimize` 先监听，在源窗口最小化时显示，不激活或恢复源窗口。列表返回会话状态与 `last_frame_age_ms`；没有收到帧时帧龄为 `null`，最后画面不能证明当前仍在更新。

关闭会话释放捕获和监听。内置 `ComputerMirror` 沿用应用审批。Desktop 将浏览器与电脑监督画面放在统一 PiP 中，可切换来源、关闭单项并返回聊天；预览默认开启，开关与布局跨重启保存。

## 文本输入

```bash
biny cu type_text "ABC" --pid <pid> --input-method physical --json
```

`physical` 按当前键盘布局规划整个文本。布局无法表示的字符会在输入前拒绝，不静默改走 Unicode。`auto`、`unicode` 与 `ax` 是另外的输入选择；`ax` 需要有效的可写控件引用。以返回的实际路线和重新观察结果判断输入是否送达。

## 外部 MCP

stdio 入口：

```bash
biny computer mcp
```

在客户端配置命令 `biny` 和参数 `["computer", "mcp"]`。stdout 传输 MCP 协议。

本地 HTTP 入口：

```bash
biny computer mcp --http --port 0
```

输出包含 `url` 与 `tokenPath`。客户端从私有令牌文件读取值，以 `Authorization: Bearer <token>` 鉴权；服务监听本机回环地址。正常关闭时删除由本次服务创建的令牌文件，不能把强制终止当作清理已经完成。

外部 MCP 共用全局 Computer Use 开关、应用审批及可选动作日志。输入前需观察同一精确目标；Desktop 运行时动作通知进入统一 PiP。断开会释放该连接拥有的镜像。

## 直接入口与日志

`biny cu` 是用户显式调用的直接原生入口，不经过产品应用审批与观察凭据校验。它受 macOS 权限与原生命令自身校验约束；Agent 不能用这个入口绕过已被拒绝的工具操作。

操作日志按需开启，只保存本地动作元数据。窗口附件快捷键见 [活动记录与 Appshots](ACTIVITY.md#appshots)，通用授权说明见 [工具与权限](PERMISSIONS.md)。
