---
name: computer-use
description: "Operate native macOS applications through screenshots and accessibility controls, including custom-drawn apps without a usable accessibility tree. Use for desktop app interaction or reading a window; prefer browser for web pages and dedicated tools when available."
allowed-tools:
  - ComputerList
  - ComputerLaunch
  - ComputerObserve
  - ComputerAction
  - ComputerSequence
  - ComputerMirror
---

# 操作 macOS 本机应用

用窗口截图和辅助功能（AX）控件完成原生应用交互与窗口内容读取。网页任务优先使用 `browser`，有适用的专用工具时优先使用专用工具。

## 后台操作与焦点

- 使用本次会话提供的 Computer 工具。所有输入始终后台投递，不激活或抬升目标窗口，也不移动用户的系统光标。
- “先切到前台操作，再恢复原窗口”仍然会干扰用户，不能这样做。也不能使用终端、`open -b`、AppleScript `activate`、剪贴板或其他服务绕过拒绝、暂停、接管和应用审批。
- 后台派发不可用时说明原因。如果任务必须依赖前台操作才能继续，停下说明限制，不自行切换输入通路。
- 不在后台应用展开菜单栏或弹出菜单找命令。菜单可能留在用户屏幕上，并让应用暂停响应自动化查询；优先用 `press_key` 调用匹配的快捷键，或操作具体控件。

## 两条操作路径

1. **控件引用**：观察得到可用的 AX 控件时，按其身份定位。需要执行控件自身的辅助功能动作时，点击指定 `strategy: "ax"`；可写控件可用 `set_value`。
2. **截图坐标**：Qt、自绘界面等可能没有可用控件树，但截图仍能显示操作目标。根据当前画面定位，使用截图内的坐标点击、滚动或拖动，不编造控件引用。

点击的 `auto` 策略在控件有位置时优先物理事件，没有位置时单次左键尝试 AX；输入报错后不会自动换路径重放。双击、其他鼠标按键和拖动需要物理事件。引用定位不等于已经执行 AX 动作。

## 工具入口

| 工具 | 用途 |
| --- | --- |
| `ComputerList` | 列出应用；传 `pid` 查询该应用的准确窗口 |
| `ComputerLaunch` | 按 `bundleId` 后台启动应用，已运行时返回现有进程 |
| `ComputerObserve` | 观察指定 `pid`、`windowId`，取得截图、控件引用和观察凭据 |
| `ComputerAction` | 在已观察的窗口点击、右键、输入、按键、滚动、拖动或编辑 |
| `ComputerSequence` | 在同一窗口连续执行已经确定的一至五步，最长十五秒 |
| `ComputerMirror` | 打开、列出或关闭当前会话的监督镜像；不激活源窗口 |

工具尚未提供或当前连接不可用时，报告缺少的能力。

## 基本工作流

1. **选定目标**：通过 `ComputerList` 取得真实应用身份。未启动时调用 `ComputerLaunch`，再列出窗口。PID、窗口 ID 和控件引用都使用实际返回值，不复用旧进程号。后台启动不保证目标应用自身不会改变焦点。
2. **观察准确窗口**：调用 `ComputerObserve`。默认一次取得画面和控件树；选择目标后、引用过期或切换窗口时重新观察。
3. **操作**：`ComputerAction` 使用同一 `pid`、`windowId`，把最新返回的 `capture_id` 传为 `captureId`，控件引用传为 `elementToken`。
4. **检查返回画面**：动作自动返回新观察。信息足够时直接使用新凭据继续，不为取得同一画面再观察；确认用户要求的结果后结束。

观察凭据绑定调用方和准确窗口，有效期六十秒且只能消费一次。下一步使用上一步返回的新凭据，不能把最初的凭据重复用于多个动作。监督镜像只供用户查看，不更新模型的观察凭据或控件引用。

## 权限与启动

桌面控制开关、应用审批、macOS 辅助功能权限和屏幕录制权限是不同条件。按错误说明用户需要在“设置 → Computer Use”启用或授权的项目；严格审批拒绝时指出具体应用，通用工具批准不替代应用审批。

`ComputerLaunch` 只负责请求后台启动；窗口尚未出现、存在多个候选或目标已退出时，按当前返回值处理，不猜测窗口、不重复启动。

## 坐标、轻量观察与等待

- 像素坐标来自当前截图，默认按 `coordinateSpace: "screenshot"` 解释；不按屏幕分辨率猜测缩放。窗口大小、位置或画面变化后重新定位。
- 只需检查画面时，`ComputerObserve` 可传 `content: "image"`。它跳过控件读取、使旧控件引用失效；下一步可使用新截图的坐标。
- Electron 应用首次观察的控件树可能较少，可再观察一次；持续为空时使用截图，不反复扫描不存在的控件。
- 等待已知控件文字可用 `waitFor: { text: "完成", timeoutMs: 5000 }`，最长十秒。它不识别截图文字，也不证明整个任务完成。超时后检查原因；没有控件文字的自绘页面不使用这项等待。

## 常用操作

| 目的 | `ComputerAction` 的关键参数 |
| --- | --- |
| 点击、双击 | `action: "click"`，使用 `elementToken` 或 `x`、`y`；双击加 `clickCount: 2` |
| 控件次要动作或右键 | `action: "perform_secondary_action"`，使用控件引用或完整坐标 |
| 保存文档 | `action: "press_key", key: "cmd+s"`；检查回执及保存后的状态 |
| 输入文字 | `action: "type_text", text: "内容"`；先确认目标输入框已聚焦 |
| 替换控件值 | `action: "set_value"`，使用可写 `elementToken` 和 `value`；需要保留原文时先读取 |
| 滚动 | `action: "scroll", direction: "down", pages: 1`，指定控件引用或完整坐标；单位为页，回执会注明实际计量方式 |
| 拖动 | `action: "drag"`，提供当前截图中的 `x1`、`y1`、`x2`、`y2` |

`type_text` 的 `auto`、`physical`、`unicode` 可向键盘焦点输入，`ax` 必须指定可写引用。`auto` 带引用时先尝试 AX；需要回退键盘时，该控件或其内部元素必须已聚焦。`physical` 只适合当前键盘布局可表达的文字；中文等内容可用 `unicode`。输入已投递仍需检查结果，不能把接受回执当作文字已经写入。

没有 AX 输入框的通用流程是：从截图点击输入位置，检查焦点，再输入并检查结果。搜索和播放、查找和修改是不同目标，只执行用户要求的步骤。

## 连续动作与文字选区

不需要中间画面就能决定的步骤可合并为 `ComputerSequence`，例如已确认输入框聚焦后的输入文字与按 Return。首步可定位或操作控件，之后只能向当前焦点输入或按键，不能沿用旧控件引用。需要找新按钮、切换窗口或根据结果分支时拆开调用。

序列逐步返回回执，只把最终画面交给模型；拒绝、回图失败、暂停或中断会停止剩余步骤。完成数量只表示收到输入回执，不能重放整组动作。

精确文字选区使用 `select_text`：`location`、`length` 是 UTF-16 位置；`text` 会替换当前选区。只查找并选择文字时用独立的 `matchText`，可用 `prefix`、`suffix` 消除歧义，`selectionType` 指定 `text`、`cursor_before` 或 `cursor_after`。文字匹配不写入正文，不能与 `text` 或位置参数混用；无匹配、多处匹配或正文已变化时停止。

## 应用专用指南

观察可能自动附带当前应用的 playbook。只使用与目标相关的说明，将其中的操作意图转换为当前工具参数，布局以本次截图为准。需要补读时，通过 `read_skill_resource` 传 `skill: "computer-use"` 和下列相对 `path`，不要求用通用 Read 读取工作区外的路径。

- [Apple Music](playbooks/AppleMusic.md)：侧栏、搜索和播放控件。
- [Spotify](playbooks/Spotify.md)：Electron 控件树与播放操作。
- [Notion](playbooks/Notion.md)：块编辑器和文字选区。
- [Clock](playbooks/Clock.md)：闹钟、计时器和世界时钟。
- [Numbers](playbooks/Numbers.md)：单元格编辑。
- [NetEase Music](playbooks/NetEaseMusic.md)：自绘界面的搜索和播放。
- [iPhone 镜像](playbooks/IPhoneMirroring.md)：镜像窗口和快捷键。

这些是按应用加载的操作提示，不是进入本技能后必须执行的任务，也不增加授权。

## 核对、故障与恢复

| 情况 | 下一步 |
| --- | --- |
| 引用过期、控件消失或目标窗口已变化 | 重新观察并定位，不套用旧引用或坐标 |
| 接口接受、输入已投递或效果待核对 | 检查返回画面中的业务结果，不因此重复输入 |
| 动作回执已收到，但回图失败 | 先只读重新观察，再决定尚未完成的操作 |
| 超时、取消或断线导致执行情况未知 | 停止本轮输入；用户恢复后先观察，不自动重试 |
| 用户暂停、接管或停用 | 等待用户恢复，不更换工具、脚本或输入通路 |
| 目标不接受后台键盘或物理事件 | 报告具体限制，不激活窗口或盲目重放 |

macOS 受保护的系统界面可能拒绝合成输入。截图变化、输入回执和任务成功是不同证据；以用户要求的界面结果为准。
