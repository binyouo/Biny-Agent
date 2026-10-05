# Computer Use 与参照实现的对齐状态

> 目标：剔除 `@trycua/cua-driver` 后，对照 `/Volumes/T7/alma-reverse` 做 1:1 复刻（含 UI 界面与展示界面）。
> 参照物：`notes/19`（实现说明）· `notes/31`（CLI 人机工学）· `resources-0.4.147/`（随包发布的 CLI 脚本与
> `Alma Computer Use.app` —— 有产物时以产物为准，它比文档精确）。
> 本文把每一项标成三类：**已对齐** / **故意不同** / **不去做**。每条都写"依据"，说明是怎么验的；
> 只写得住的话，没验过的一律标"未验证"。

## 0. 一句话状态

动词面 **21/21 齐**；daemon / CLI / 模型工具三层的单位与语义一致；
UI 三类界面齐全，并补上了参照实现有、本仓库原本没有的**动作指示器（lens）**。
另有 **4 处刻意不抄**、**2 处机制差异**，逐条在 §2 §3 列明原因与依据。

---

## 1. 已对齐

### 1.0 手动运行的入口

参照的 helper 有正经 usage（`daemon [--socket PATH] [--idle-seconds N]` / `version`，
并注明"The daemon is normally launched automatically by the app. Users do not need to run it
directly."）。本实现原先**忽略子命令、缺 `--socket` 就静默 `exit(64)`** ——
"可以手动跑"这条文档路径是断的：跑一下什么都不说。

同一段文本里还有一处该对齐的：参照的权限提示**明说去哪儿开**——

```
Accessibility permission not granted to Alma Computer Use.
Open System Settings → Privacy & Security → Accessibility and enable "Alma Computer Use".
```

本实现原先只抛 `ax_not_granted` 一个错误码，截图那条更糟：缺屏幕录制时抛的是
**ScreenCaptureKit 的原始错误**。而这两项授权 **macOS 每次新构建都会重置** ——
也就是说用户会反复撞到它，只给错误码等于让他自己猜。

现在两条都给全：`ax_not_granted` / `screen_recording_not_granted` 各自带上
系统设置里的确切路径，并在截图入口先自查一次屏幕录制权限（不等 SCK 报错）。

⚠️ 这条**没法自动化测**（要测就得撤销权限），靠的是正常路径仍通过 + 文案在源码里可核对。

现在三样齐了：`version` 打印版本、未知子命令报错并附用法、`daemon` 有默认 socket
（用**用户级**路径；参照那个是机器级的 `/Library/Application Support/Alma/`，那是它的安装器建的，
普通用户写不进去，照抄会让手动跑必然失败）。

复验：裸跑 → socket 建起来 → `status` 回执正常 → 已清理。

### 1.1 动词面：21/21

`status` · `doctor` · `grant` · `list_apps` · `apps` · `windows` · `get_app_state` · `snap` ·
`click` · `perform_secondary_action` · `drag` · `type` · `type_text` · `press` · `press_key` ·
`set_value` · `scroll` · `raise` · `shot` · `lens` · `shutdown`

| 项 | 参照 | 本实现 | 依据 |
|---|---|---|---|
| `type` / `type_text` 是两个动词 | `/api/computer-use/type` 与 `/type_text` | 同 | CLI 产物里的 REST 端点列表；两者机制不同（AX 写值 vs 合成按键） |
| `press` / `press_key` 同上 | `/press` 与 `/press_key` | 同 | 同上；`press` 触发控件 AX 动作（Enter/Escape/Space/Increment/Decrement/ShowMenu） |
| `click --strategy` | `auto\|physical\|ax` | 同 | 两条路由是不同机制：AX 让控件执行自己的动作；物理合成鼠标事件。`auto` 回执如实说走了哪条 |
| `click --button/--clicks` | `left\|right\|middle`、双击 | 同 | 双击靠 `mouseEventClickState` 序列，不是发两次单击 |
| `scroll --pages` | 页 | 同 | 页 = 视口/内容，**量出来的**（见 §4.2） |
| `windows` | 列应用的窗口 | `list_apps <pid>` 返回 `windows[]`，带真实 `CGWindowID` + 标题 | 请求 121 回 121、请求 104 回 104 |
| `snap --no-shot / --depth` | 同 | 同 | `--no-shot` 1338ms → 665ms，树一致 |
| `launch_app --activates` | 默认不激活 | 同 | 实测：默认前台不变；带 flag 才变 |
| `raise` | `bundle\|pid [--window=ID]` | 同 | 走 Apple Events（见 §3.1） |
| `lens on\|off\|toggle` | 动作指示器 | 同 | 见 §1.2 |

### 1.2 展示界面

| 界面 | 参照 | 本实现 | 依据 |
|---|---|---|---|
| 设置页 Computer Use 节 | 36 个 i18n key | **内容逐条覆盖**（权限 / 审批 / 严格模式 / 画中画 / 操作日志 / helper 诊断 / 焦点保护 / 测试我的配置）| 见下 |
| PiP 监督窗 | 悬浮画中画 · 3fps · 90s 无活动自动结束 | **同**（寿命逻辑逐行对得上）| 窗口 `vibrancy: hud`；见下 |
| 权限引导浮层 | 520×76，贴目标控件 | 同 | 几何模块 + OCR 定位行 |
| **动作指示器（lens）** | `Overlay.swift` · `LensOverlay`/`ActionCursor` · `alma.lens.scrollBadge`/`typeBadge` | 同 | 见下 |

**lens 是全屏覆盖层，三条硬约束**（缺一条就会打扰用户）：

1. **穿透点击** `ignoresMouseEvents = true` —— 否则它会吃掉用户所有点击
2. **不抢焦点** —— `NSWindow` 子类覆写 `canBecomeKey/canBecomeMain` 为 false，用 `orderFrontRegardless()`
3. **不进 Dock** —— daemon 本身是 `LSUIElement`

穿透这条**是验的不是声明的**：lens 在点击**之前**弹出、盖满全屏，此时双击仍能选中词。
开关行为：`off` 与 `show_cursor:false` 都不出现，默认出现（用 `.optionOnScreenOnly` 判可见）。

**PiP 的寿命逻辑与参照代码逐行吻合。** 参照的 `out/main/chunks/computerUsePip-*.js`：

```js
setTimeout(() => { f() }, 9e4)     // 90000ms —— 90 秒
export { COMPUTER_PIP_ITEM_ID, endComputerUsePipSession,
         isComputerUsePipEnabled, noteComputerUseActivity }
```

四个导出名与 90s 常数，与本实现的 `noteComputerUseActivity` / `previewIdleMs = 90_000` 一致
（本实现当初是照 notes 写的，这次是从代码本身复核）。

**浮窗可以挪，而且记住挪到哪儿。** 参照有 `pip/move`（`state` 也返回 `bounds`）——
PiP 是常驻置顶的，挡到东西时必须能挪开；而窗口每次打开都重建，不记住位置用户就得每次重挪。
本实现：头部是拖动区（里面的链接 `-webkit-app-region:no-drag`，否则点不动），
`moved` 记下位置、下次 `open()` 还原。窗口位置只在内存里记（同一次运行内有效），
跨重启持久化留给设置层。

**但组织方式不同：参照的 PiP 是一「栈」。** 路由表与实现里可见：

```
pip/state → { open, activeItemId, items, bounds }      getPipItems · isPipStackOpen · getPipStackBounds
pip/present · pip/hide · pip/frame · pip/move · pip/invalidate
```

即**按窗口的多个镜像叠在一起**，可整体定位（`bounds` / `move`）、可失效（`invalidate`）。
本实现是**单个预览面**，跟随当前观察目标。差别属于组织方式，不是能力缺失
（§6 另记了「按窗口镜像 + 最小化劫持」这一条）。

### 1.1a 空 AX 树会唤醒重试（参照的 wakeup 那套）

继续往 helper 的字符串里读，读到一组没见过的符号：

```
wakeupAttempts · wakeupDurationMs · wakeup_duration_ms
no_wakeup_budget · empty_after_wakeup
```

即：**树读回来是空的时候，参照会「唤醒」应用并重试**，带预算与耗时上报。本实现原先
**一次性的**——设完标志遍历一次，空就是空。现已对齐：只在「只有窗口、没有元素」时重试，
预算 2 次、每次间隔 150ms（免得把正常观察拖慢），回执带 `wakeupAttempts` / `wakeupDurationMs`，
用尽预算仍为空则明确报 `empty_after_wakeup` —— 让调用方分得清"这应用没有 AX 树"和"我该再试一次"。

实测（网易云音乐，本来就无 AX 树）：`attempts=2` + `empty_after_wakeup` ✓。

### 1.1b 顺带修掉一个**会静默吞字段**的缺陷

写上面那条的测试时发现：**同一个功能带截图和不带截图，字段居然不一样。**

原因是 driver 的 `shape()` 在有截图时用 `toCapture()` **重建**回执对象，而它只搬运
**自己认识的**字段 —— 新加的 `wakeupAttempts` / `warning` 一律消失。这和我早先修的
「参数被某一层吞掉」同族，但影响面更大：**任何 observe 回执上新增的字段都会这样没掉**。

修法：`toCapture` 先把 daemon 其余字段铺进来，只丢掉自己的内部字段（截图路径、原始 elements、
原始宽高）。现在两条路字段一致、且不泄漏内部字段。

同一轮还发现 `--no-shot` 那条路**根本不过 shape**，于是它的元素带 `ref` 而另一条带
`element_token` —— 渲染层只认后者，**`snap --no-shot` 出来的行集没有 ref，点了没用**
（我早先跑过一次、看到 `[0] AXWindow @0,44` 光秃秃，当时没意识到那是缺陷）。
两条路形状不同是有原因的（`captureSchema` 要求截图宽为正，"没有截图"满足不了它），
所以修在渲染层：**两种引用字段都认**。现在 `[0] (e0) AXWindow …` ✓

### 1.2a AX 增强标志是**有作用域**的，用完要还原

参照把它做成一个「断言」（`AXEnablementAssertion`，里面有字段 `prevEnhanced`）——
记下 `AXEnhancedUserInterface` 的原值，用完恢复。

本实现原先**设了就不管**：每次观察都会在目标应用上留下「增强无障碍树」常开。
后果是具体的 —— 对 Electron 应用意味着**一直渲染完整无障碍树**，可能持续变慢。
**那是留在用户正在用的应用上的副作用**，不该由我们留下。现已改为断言式。

复验方法（三步，需要能读 AX 的进程）：

```bash
# 1. 把基准设成 false，确认读回 false
# 2. 让守护进程对它观察一次（get_app_state）
# 3. 再读 —— 应为 false（旧实现会留 true）
```

实测：基准 false → 观察后仍 false ✓。顺带一提，改之前 TextEdit 读回是 **true** ——
那就是旧行为留在这台机器上的残留，等于亲眼看到了这个副作用。

### 1.2b 观察会自动后台拉起目标

参照 SKILL 原文：`get_app_state` **auto-launches the target app in the background if it is
not running** —— 调用方不必先 launch 再 observe。本实现原先对未运行的应用直接
`app_not_found` 失败，现已实现同样的语义（`resolvePid` 走 `NSWorkspace.openApplication`
且 `activates: false`）。

**同时补上了参照明令的一条**（本实现原先没有）：

> ## Opening apps — DO NOT use `open -b`
> `open -b <bundle>` activates the app by default, which steals focus. **Never use it.**

这条已写进本仓库的 SKILL.md。

⚠️ 但 `activates: false` 是**请求不是保证**，实测：

| 冷启动目标 | 前台 |
|---|---|
| 预览 | 不变 ✓ |
| App Store | 不变 ✓ |
| **FaceTime** | **被顶到前面** ✗（通话类应用自己会跳）|

与 §5 的 URL 派发是同一个规律：**"不动前台"是具体应用的性质**。

### 1.3 生命周期与并发

| 项 | 参照 | 本实现 |
|---|---|---|
| socket 按**二进制 sha1** 隔离 | 是 | 按二进制**内容**哈希（还没构建时退回路径） |
| 空闲自退 | 900s | 同 |
| 多调用方**共用一个 daemon** | 是 | 先试探已有 socket，连不上才 spawn |
| 请求超时 | 默认 20s / 截图 30s | 同 |
| 启动握手 | 连不上就 **100ms×4s 重试** | 等 daemon 打出 `ready` 再单次连接 |

**依据与来源**（这一节的数来自 notes/19 §1，未逐条在参照代码里复核；已复核的标出来）：
- socket 隔离 + 多调用方共用：**已验** —— 同一二进制换目录跑 socket 名不变；第二个 driver 能用到第一个观察到的 ref
- 空闲 900s：`--idle-seconds 900` 同一参数，**已验**（daemon 自退）
- 启动握手：**行为等价而非相同**。参照重试连接（100ms×4s）；本实现等 daemon 的 `ready` 输出再连一次 ——
  等的是一个更强的信号，所以不需要重试。这只是不同的做法，不是缺口，但记在这儿免得被当成"已对齐"。

### 1.4 安全护栏

| 项 | 参照 | 本实现 |
|---|---|---|
| 按 app 审批 | `check_approval`，strict 未批准即拒 | 同（本地配置表） |
| 操作日志 | tool/bundle/pid/**args**/duration/error_code | tool/**bundle**/pid/**error_code**/duration（**不含 args**，见 §2.1） |
| 焦点护栏失败提示 | 附在动作结果上，30s 节流 | 同 |
| 前台铁律 | MCP instructions + 守护进程文案双写 | 同 |
| 未验证的交付不算成功 | 是 | 同（`action_unverified`） |

**这一节的来源**：notes/19 §5 的三条（`check_approval`、`action_log` 字段、30s 节流）与 §3 的
「前台铁律写进 MCP instructions 和守护进程文案」。其中两条**已验**：
`action_log` 字段差异见 §2.1（有测试守着）；前台铁律的两处文案都在代码里。
审批与 `action_unverified` 来自 notes，未在参照代码里逐条复核 —— 标在这里，
免得读者把"照文档写的"和"对照代码验过的"当成一回事。

### 1.4b 失败的**说法**：区分"没传"和"过期"

参照的每条失败都说得具体（`click: element has no AX action and no screen bounds for a
physical click`、`set_value (AXValue not settable on this element)`、
`select_text (element has no readable AXValue text)` …）。本实现原先多处是裸码
（`ref_stale` / `set_value_failed` / `select_text_failed`），
`perform_secondary_action` 在"AX 不认菜单且元素没有坐标"时**静默什么都不做** ——
没有任何消息。

已逐条对齐，并守住一条不变量：**「没传参数」和「ref 过期了」必须分开报** ——
调用方要做的下一步完全不同（补参数 vs 重新 snap）。
这条在 `click` 和 `perform_secondary_action` 上先后漏过一次（`if let ref = …, let element = refTables[…][ref]`
把两件事并在一个条件里），现在四个动词都有测试钉住。

### 1.4c 原生意图层：补上通用派发与 Music/Spotify/Mail

参照的意图目录比本实现宽。从 helper 的**工具描述散文**里能读到完整清单：

- **通用派发**：`route` 参数取 `dailyRecommend / historyRecommend / historyPlaylist /
  styleRecommend / similarArtist / ranking / playlist / album / artist / albumlist /
  musicDesktop / localMusic / login` —— 而且**"Other values may also work"**，
  它就是 raw `orpheus://route/<name>` 桥。本实现原先只有两个具名路由。
- `Open Music.app in the background.` / `Open an Apple Music URL (music.apple.com/… 或 music://…)`
- `com.spotify.client` / `Play a Spotify URI, e.g. spotify:track:…`
- `Open a new message. All params optional: to, subject, body, cc, bcc.`（走 `mailto:`）

已全部补上。未知路由名**原样放行**（不是错误）—— 这正是参照的语义。

失败分成四种，各自给下一步：`unknown_intent` / `intent_missing_url` /
`intent_bad_url` / `intent_handler_not_installed`。
（后者例如这台机器没装 Spotify —— 如实报，不假装成功。）

### 1.4d 动作指示器的单次抑制：`--no-cursor`

参照的 help 末尾有一行：

> **Action flags: `--no-cursor` hides the lens for one action.**

**这一行我读过两次，两次都滑过去。** 补它的时候才发现：守护进程侧的 `show_cursor` 早就写好了
（`guard lensEnabled, args["show_cursor"] as? Bool ?? true`，注释里甚至写着"对应 `--no-cursor`"），
**而四个调用层（protocol / controller / driver / CLI）一处都没有传** ——
能力在、路不通，又一次。

现已全线接上：协议加 `show_cursor`、驱动在 `withPid` 旁边统一带上（8 个动作一处覆盖，
好过每个 case 各写一遍 —— 那种写法漏一个就静默失效）、CLI 每个动作动词都有 `--no-cursor`。

**顺带修了两件事**：
1. `scroll` 原先**一个落点都不记** —— 于是它既不亮指示器、也吃不到这个开关。
   参照在滚动这条路上有专门的 `alma.lens.scrollBadge` 角标，所以它本该有。
   落点取窗口中心（滚动是窗口级动作，没有单点）。
2. `lens <mode>` 的 `default` 分支是 `toggle`，于是**任何不认识的 mode 都会翻转开关** ——
   连"查一下状态"都是一次扰动。加了只读的 `status`。

**并且让结局可读**：指示器是全屏透明窗口，"看不见"和"没显示"肉眼分不开，
所以 `lens status` 报 `lastIndicator` = `shown` / `suppressed` / `disabled` / `none`。
有了它 `--no-cursor` 才是可验证的，而不是"我没看见所以应该没显示"。

### 1.4e MCP 的参数面：又一处「对过名字、没对过参数」

上轮 diff MCP 契约时我 diff 的是**工具名**（13 个，为空 ✓）—— **参数看不见**。
这轮读参照 MCP 的本体，`get_app_state` 一个工具上就暴露出我之前**四个都没暴露**：

```
depth:                 max(20)   "AX tree depth. Default 6."
interactive_only:      boolean   "Limit to interactive elements. Default true."
screenshot_max_width:  int       "Downsample width for the screenshot (default 1280)."
auto_launch:           boolean   "Auto-launch the app in the background if not running. Default true."
```

- `depth` / `screenshot_max_width` —— **daemon 早已支持**（`max_width` 默认就是 1280），
  MCP 没开口 → 已开（命名随本仓的 camelCase 惯例）。
- `interactive_only` / `auto_launch` —— **daemon 里没有**，不假装有，标为未覆盖。
- **顺手逮到一处描述与实现矛盾**：我的 `get_app_state` 描述写着
  "if the app is not running the call **fails** — use launch_app first"，
  而实现是 `resolvePid` 走 `openApplication(activates: false)` **后台自启** ——
  **描述在教 agent 一件错的事**。已改准。

**这轮还差点照抄一个参照没有的东西**：我数到参照 MCP 里 `strategy` 出现 7 次，
差一步就加进 click —— 读上下文发现那 7 处**全是 zod 的内部字段**，
参照的 MCP **并不暴露** `strategy`。所以我没有它是对的。
→ **计数不是证据，上下文才是。**

### 1.4f `scroll` 按 ref（参照的用法）+ `shot --max-width`

参照的两条 CLI 签名：

```
scroll <ref> <up|down|left|right> [--pages=N]      ← **目标由 ref 指定，不带 pid**
shot <bundle|pid> [--window=ID] [--out=PATH] [--max-width=N]
```

本实现原先 `scroll <direction> --pid`，**ref 这条路完全没有**；`shot` 有 `--out` 没有 `--max-width`
（而 daemon 早就支持 `max_width`，默认 1280 —— 又是能力在、路不通）。

已补。三件附带发现：

1. **参照的 ref 是全局的**。它的 CLI 只给 ref 不给 pid 就能滚 → 说明元素存储全局
   （helper 类名表里的 `ElementStore`）。本实现的 `refTables` **按 pid 分表**，
   所以"只给 ref"要跨表反查。规则定为：**最近一次观察的 pid 优先，其次唯一命中，不唯一就报错不猜**
   （ref 本来就是"最近一次观察"里的引用，跨轮次即失效 —— 与参照给 agent 的提示一致）。
2. **给的 ref 常指向内容元素而不是滚动区**。参照的提示是
   "ref points at an unscrollable element (snap the parent ScrollArea)" —— 它让调用方自己往上找。
   本实现加了 `scrollAreaAncestor` 替调用方走完（有界 8 层）。
3. 命令行只给 ref 时**不能传 `Number(undefined)`（= NaN）**，否则 daemon 报 `app_not_found`。

### 1.4g 动词**名**也是契约：`get_app_state` / `perform_secondary_action`

拿到参照的完整 help 文本后把动词表整个重对了一遍（之前那次对的是旧印象），
逮到两个"能力在、名字不对"：

| 参照 | 本实现（原先） |
|---|---|
| `get_app_state <bundle\|pid> [--window=ID] [--depth=N] [--no-shot] [--shot-out=PATH] [--shot-max-width=N]` | `snap`（名字是参照里 **tree-only 的 legacy 名**）|
| `perform_secondary_action <ref>` / `--pixel <x> <y> [--pid=N]` | `menu`（只有 ref 一种形式）|

**名字本身就是给 agent 的契约** —— 参照的 help 明写：

> Hint: start every turn with `alma cu get_app_state <bundle>` — refs become stale across turns,
> so the screenshot is your visual anchor.

agent 是按名字找能力的。已补上两个正式名（**保留原名**，不让已有调用断掉），
并补了缺的那条像素形式 `--pixel` 与 `--shot-max-width`（实测 1280 → 640 生效）。

### 1.4h `interactive_only`（`--all`）：默认值也是契约

从参照实现里读到（不是猜的）：

```
if (hasFlag('all')) body.interactive_only = false;     ← get_app_state 与 snap 各一处
```

**参照默认只给「可交互元素」，`--all` 才给完整树。** 角色的那份清单从 helper 二进制的
独立角色串里筛出来（去掉动作 / 属性 / 内部符号）：16 个，`AXButton` … `AXTextField`。

已实现并全线接通（daemon / protocol / CLI `--all` / MCP `interactiveOnly`）。
**默认取 true，与参照一致** —— 实测差异：活动监视器 **200 → 401** 个元素。

**过滤只作用于「给调用方看的列表」，ref 表保持完整** —— 看见的变少，不会把已给的 ref 弄失效。

**顺带补上一个语义缺口**：过滤开着时，「列表为空」不再等于「这应用没有 AX 树」
（可能是有树、只是没有可交互元素）。这两件事调用方要做得不一样
（前者放弃用 ref，后者加 `--all` 再看一次），所以回执里加了 `interactiveOnly`，
并在过滤后为空时给出 `no_interactive_elements` 提示。

### 1.4i `auto_launch`：只有 MCP 有，CLI 没有 —— 两边都要对

参照 MCP 的 `get_app_state` 描述里写着：

> AUTO-LAUNCH: if `bundle` is given and the app is not running, it is launched in the
> **BACKGROUND** — the user's frontmost app stays put. Pass `auto_launch: false` to disable.

本实现一直就是后台自启的（`resolvePid` 里 `config.activates = false`），**只是没有开关**。

已加。关掉时**明确报 `app_not_running` 并给出下一步**，而不是静默照旧启动 ——
关它的人要的就是"别动我的机器"。

**它只加在 MCP，不加进 CLI**：参照的 CLI help 里没有 `--auto-launch`
（只有 `--window/--depth/--no-shot/--shot-out/--shot-max-width`）。
参照把这个开关给 agent、没给命令行 —— **对齐包括"对不上的地方"**，
不能因为"顺手"就给两边都加。

两个方向都实测过：
- 默认（不传）→ 应用起来了，且**前台仍是原来的应用**（正是契约那句话）
- `auto_launch: false` → 报 `app_not_running`，**且确认它真的没被启动**
（正面那半会启动一个应用，属于用户机器上的副作用，所以只手动验、不进测试套件。）

### 1.4j agent 面的契约文字：`input_method` 与 `verification_note`

一整个面我从头到尾没对过：**发给 agent 的契约文字**（MCP 描述 + daemon 的失败文案）。
它们只面向 agent —— 而 agent **只读得到这些字**，读不到实现。

参照在这些字里放了三样本实现没有的东西：

1. **`input_method must be auto|physical|unicode|ax`** —— 三条输入路径**暴露成参数**，
   而且 `input_method=ax requires ref`（AX 那条按元素走、不按焦点）。
   本实现原先只有 unicode 一条。已实现 auto/unicode/ax；
   **`physical` 如实拒绝**（需要「字符→键码」的键盘布局翻译，本实现没有 ——
   选它的人正是因为别的方式不管用，偷偷降级成 unicode 是最坏的回答）。
2. **`verification_note` = "sent, but could not confirm it landed"** ——
   一个**承认不确定性**的字段。它比 `warning` 准：warning 读起来像"出错了"，
   而这种情况是"**不知道**有没有落地"，agent 该据此去核实，而不是据此认定失败。
3. 交付失败文案里**点明了那个显而易见的错误修法**：
   > … Use set_value with the element's ref to write the field directly.
   > **Do NOT bring the app forward to make typing land** — Alma never takes the user's foreground.
   本实现原来只写了铁律，**没给替代做法** —— 而 agent 最容易做的正是那件被禁止的事。

**没做的**：`visual refs (v*)` —— 参照还有第二套 ref 命名空间（视觉 ref）。
那是一条独立的机制，标为未覆盖，不假装有。

### 1.4k `visual refs (v*)` —— 读了，**但没做**（格式不可考）

参照的 daemon 侧有**第二套 ref 命名空间**，面向坐标：

```
visual refs (v*) require `pid` or `bundle`
no screenshot mapping for pid <n>; run get_app_state first
```

已知的：它是**截图坐标系**里的引用，靠 pid 找到那张截图的映射，用前必须先 `get_app_state`。

**但编码格式在能拿到的产物里读不出来** —— 符号在（`visualRefs` 在 helper 里出现 4 次），
语法不在；发布的 CLI 里一次都没提；`notes/` 里也没有。
→ 按既有原则（"它没说清所以不能猜的"）：**不去猜它的格式**，保留差异并写明。

**它解的那件事本来也已经有了**：截图坐标 → 屏幕坐标的映射（`coordMaps`）+ `click --pixel`。
缺的只是一个名字。名字要靠猜才能对上 —— 猜错了比没有更糟。

### 1.4l 同一屏里的两句"为什么"：像素点击的失败要分四种

```
click by pixel requires either `pid` or `bundle` of a running app — without a target
  we'd have to post globally and move the real cursor.
click --pixel requires both x and y
```

第二句本实现**没有对应物**：只有一句笼统的「要么给 ref，要么给 x/y 坐标」——
于是**"只给了 x"的调用方，被告知"要给 x/y 坐标"**。这是「合并 guard」那族，
**今天第三次**栽在同一处（前两次是 `click`/`menu` 的 ref 查找、和 `interactive_only` 的 scope）。
本实现拆成四种：缺 x / 缺 y / 缺目标 / 缺全部定位。

**顺序也有讲究**：先查**调用本身完整不完整**，再查**策略**。
"只给了 x"连点都点不了，比"没有目标"更前面；两条都成立时报后一条，
会让人先去找目标、补完才发现坐标还是缺的。

第一句的**"为什么"**也补上了：没有目标就只能全局投递，那会**移动用户的真实光标**。
只说"缺参数"，调用方分不清是它调用错了还是我们的策略 —— 把代价说出来，它才知道下一步。

### 1.4m 按**原则**扫一遍全部错误分支（不是按上次修的那个形状）

上一条教训是「按原则扫，不按你刚修的那个形状扫」。这轮照做：
把 daemon 里 **54 条错误分支**全列出来，逐个数"它背后有几种原因"。

**先要分清两类**：
- 一句话里带"或"的，多半是**选项清单**（"改用 A 或 B"）—— 那没问题，是在给下一步。
- 有问题的是把**不同情形**并成一句的 —— 它们读起来同样像"给了建议"，但建议指向两件事。

按代码里的多条件判断再扫一遍，逮到四处：

| 处 | 并在一起的两件事 | 拆后 |
|---|---|---|
| `appshot_monitor_start` | **没给 hotkey** vs **给了但解析不了** | `hotkey_missing` / `invalid_hotkey` |
| `drag` | 四个坐标里**少了哪个** | `drag_missing_coordinate: 缺 y2` |
| `appshot_frontmost` | **取不到前台** vs **前台是自己**（没得拍） | `appshot_frontmost_unavailable` / `_is_self` |
| `set_value` / `select_text` 的参数守卫 | 三样需要的东西并成一句 | **留着了**（见下）|

**明确留下的**：参数守卫那句（"需要 ref、pid 和 value"）列全了清单，调用方看自己的调用就知道缺哪个 ——
与"ref 过期了"那种**看不出来**的情况不同，拆分价值低。
**判定标准是"读的人能不能从自己那边补上信息"**，不是"有没有并列"。

### 附带：我在这轮里又踩了一次「断言取决于机器的值」
新测试里我写了「`appshot_frontmost` 应当 reject」—— 而它的注释上写着"两种情形要能分开"。
前台是真实应用时这一路**本来就该成功**，于是报 `Missing expected rejection`。
→ 改成断言**可判别性**（成功路径或两种坏法之一），而不是"这一刻落在哪一种"。
→ 又一次印证：**把教训写进注释，不等于把它写成检查。**

### 1.5 工具 / 技能层

- 模型侧工具：`ComputerList` / `ComputerObserve` / `ComputerAction`（8 个动作动词）
- MCP 出口：13 个工具（stdio）

**MCP 工具表逐条核对过**（权威源是参照自己的 server 本体
`resources-0.4.147/cli/alma-computer-use-mcp.mjs`，不是文档）：

```
参照 registerTool 共 23 个：原生 13 + Codex 别名 10
原生 13: click drag get_app_state grant launch_app list_apps perform_secondary_action
         permissions press_key scroll select_text set_value type_text
本实现 MCP: 与上面 13 个**完全一致**（diff 为空）
```

同一份源码还确认了三件事：
- `scroll` 的参数是 **`pages`**（`number().int().max(20)`），不是 notches —— §1.1 那条对齐属实
- 每个动作都带 **`show_cursor: true`** —— lens 默认显示，与 `--no-cursor` 是单次抑制互为表里
- `list_apps` 的默认窗口是 **14 天**（"used in the last N days (default 14)"）
  —— 本实现原先写 30，已改成 14
- 每个工具都被 `gated(tool, args, …)` 包一层（审批 + 日志），对应本实现的执行服务
- 内置 skill + 7 个 playbook
- **可判别的失败信号**：`keystrokes_may_be_dropped`（按键被系统丢弃）· `scroll_route_unavailable` ·
  `element_ref_not_observed`（并提示先 snap）· `ax_cannot_express_this_click`

---

## 2. 故意不同：照抄会更差

### 2.1 操作日志不记 `args`

参照落 `args`；本实现**不落**。`type_text` 的 `text` 是**用户输入**，`elementToken` 是**私有引用** ——
留档等于把用户敲的内容存起来。`tests/computer-use-diagnostics.test.ts` 有断言
`doesNotMatch(JSON.stringify(entries), /private|capture|image|token/)` 守着这条不变量。
**这条是我先照着加了 args、被测试拦下来才改的。**

### 2.2 审批失败姿态：fail-closed

参照在审批 API 不可达时 **fail-open**（放行）。本实现读本地配置，不存在"不可达"；
配置读失败即拒绝。**照抄等于把一个安全洞搬进来。**

### 2.3 不做 `sky_*` 兼容别名 ×10

那是给 Codex CLI 的兼容层。本项目不面向 Codex；加了等于永久维护两套调用约定。

### 2.4 MCP 不自动注册

参照把 server 写进 `mcp.json`，因为**它的 computer use 本来就走 MCP**。
本实现走**原生工具**（带 capability 门控），再注册一遍等于同一批工具两条路。

### 2.5 CLI 直连 daemon socket

参照链路是 `CLI → REST → 主应用 → daemon` 三跳；本实现 CLI 直接连 daemon 的 unix socket，一跳
（daemon 按需自启，所以桌面应用关着也能用）。**副产品**：命令行拿到的 ref 在下一条命令里仍有效。

---

## 3. 不去做：验过才决定的

### 3.1 `CGEventTap` 焦点零抢占（只做到事后补救）

参照做的是**事前拦截**。从 helper 二进制里能读到的东西比文档多：

```
FocusStealPreventer                      （Swift: _TtC4main19FocusStealPreventer）
CGEvent.tapCreate  ·  CGEventTapCreateForPid
observed_activations  ·  suppressed      ← tap 在**统计并抑制**激活事件
CGEventTap disabled (                    ← 运行时被系统禁用时记日志
[alma-cu] FATAL: focus-steal prevention could NOT be armed (CGEvent.tapCreate returned nil).
          Actions will steal the user's focus. Check Accessibility permission for this helper binary.
```

所以**机制的性质是清楚的**：按 pid 建 tap，拦截/抑制会把目标应用带到前台的事件；
建不起来时它选择 FATAL 而不是降级 —— 宁可停，也不假装零抢占。

**仍然不知道的是事件掩码与判定规则** —— 哪些事件类型、什么条件下抑制。
事件 tap 是系统级输入面，掩码猜错会改掉用户的键盘/鼠标行为，所以补不了。

本实现的替代：动作后每 5ms 巡查、一被抢立刻还（可见窗口 30ms → ~5ms）。

**参照是两层，本实现只有其中一层。** helper 二进制里的类名与字段：

```
FocusStealPreventer          ← 第一层：tap，事前不让激活事件生效
PreserveFrontmostWatcher · VictimObserver · preservePid · frontmostApplication
                             ← 第二层：记下要保全的 pid，把前台还回去
```

**第二层的形状和本实现的 `withFocusGuard` 一样**（记前台 → 动作 → 还原）。
所以差异是"**缺第一层**"，不是"采用了参照否定的做法"。

（这一条我先前**过度纠正**过**一次**：读到 MCP instructions 里
"never by bringing a window forward and putting it back" 就断言自己踩了反模式。
但那句是写给 **agent 自身的主动性**的 —— 原文紧接着 "Never activate, raise, or otherwise
front an app **on your own initiative**"，说的是 agent 不许主动去 activation，
不是禁止护栏在事后收拾。参照自己也做同样的事。）

根因仍然具体：**全局投递的鼠标事件（§4.1 的修法）本身会激活目标窗口**，
而 AX 路由不需要焦点 —— 这也是参照让 `auto` 优先走 AX 的原因。
所以缓解是行为上的：优先 ref 点击，像素是知道代价的退路（工具指引已这么写）；
`focus_guard_unavailable` 在护栏没武装上时告警（30s 节流）。

### 第一层为什么补不了：**实测那个 API 在本构建里不可用**

不是"文档没说清"，也不是没做 —— `doctor` 现在会分两种 tap 分别报：

```
accessibility: granted | screenRecording: granted | focusTap: session-only
```

同一次调用里：**全会话 tap 能建；按 pid 的 tap（参照第一层用的那个）建不起来。**
两者都需要辅助功能权限，而权限是 granted，所以不是权限问题。

### 更准的一层：能建 ≠ 能用（2026-10-05 补测）

做 appshot 全局热键（§5.5）时又量了一次，结论要修正：

```
armed: true · live: true（tap enabled，source 确实挂在主 runloop 上）
注入输出: 已全局注入 keycode=46        ← 注入真的执行了（探针 CGPreflightPostEventAccess = 允许）
eventsSeen: 0                          ← tap 一个事件都没收到
```

**这段后来又被推翻了，见下 —— 我的测量手段本身是坏的。**

#### 第二次修正：投递这件事**根本没测到**（同日更晚）

上面那个"收不到事件"的结论，前提是"我注入了一个事件"。后来单独验了一下注入本身：
往已聚焦的文本框里全局注入字母 `x`，然后读回 —— **文本没变**。
所以**注入压根没出去**，而"tap 收不到"这件事**没有被测量过**。
`CGPreflightPostEventAccess()` 报的是「允许」，但事件并没有生效 ——
**又一个「报告允许 ≠ 真的生效」**，和这条本身的「能建 ≠ 能用」是同一类。

#### 第三次：换一个**能工作的注入源**，测出来是**通的**

外部探针的全局投递没生效，但 **daemon 自己的全局投递是有效的**
（鼠标那条已经证过：全局 post 的双击真的选中了词）。给 `press_key` 加 `global` 选项后：

```
③ 装热键 Ctrl+Alt+M → {"armed":true}
④ 用 daemon 全局派发 ctrl+alt+m
   状态: {"eventsSeen":1, "lastCapture":"/var/…/biny-appshots/appshot-…jpg", "live":true}
   文件: JPEG 1280×832，36883 字节 —— 抓的正是前台应用
```

**会话 tap 收得到事件，热键端到端可用。** 前面那句"不投递"是**仪器的错，不是 tap 的错**。

| 问题 | 状态 |
|---|---|
| per-pid tap 能不能建 | 量过，**会飘**（同一机器 2/3 · 3/3 · 3/3）|
| 会话 tap 能不能建 | 量过，能 |
| **tap 能不能收到事件** | **量过，能**（第三次，用可工作的注入源）|

`doctor` 仍报三次采样的**模式**（`per-pid` / `session-only` / `intermittent(n/3)` / `none`）——
单次值会让下游得出随机结论。

**"机制不明"到现在只剩一件事没查清**：那条按 pid 的 tap 会飘，是不是签名身份导致的。

**推测**（未验证，故标为推测）：差异在**签名身份** —— 参照发的是正式 Developer ID 的公证包，
本仓库是 ad-hoc 签名。要证实得有一份正式签名，本环境没有。

诊断保留在 `doctor` 里：换签名、换机器时它会立刻反映出来，比"机制不明"这种句子有用。

### 3.2 `type_text` 三级降级（对目标场景无效）

参照是 AX 插入 → 物理键码 → Unicode CGEvent 三级。据 playbook 里"网易云搜索框收不到键盘输入"
把它列成待补能力，**动手前先做了实验**：

| 路径 | 结果 |
|---|---|
| Unicode CGEvent | ❌ 没进去 |
| 物理键码（按键盘布局翻译） | ❌ 没进去 |
| 占位词是否消失 | **没消失** → 焦点压根没进去 |

所以三级救不了这个场景（一级更不行，那应用没有可用的 AX 树）。
**替代路径**：`type <ref>` 直写控件 AXValue（已实现）；控件不接受写入时明确报错而不是假装成功。

---

## 4. 实测方法（可复验）

### 4.1 鼠标事件必须全局投递

| 方式 | 结果 |
|---|---|
| `CGEvent.postToPid` | 双击后选区 `loc=0 len=0`（纹丝不动） |
| 全局 `post(tap: .cghidEventTap)` | `loc=0 len=8` —— 选中整个词 |

**API 两者都返回成功**，所以 `postToPid` 那些点击一直在报假成功。
现在全局投递 + 前后保存/还原光标（用户不该因为一次自动化发现鼠标换了位置）。

### 4.2 一页 = 视口 / 内容

滚动区里**最大的那个非滚动条子元素就是内容**：

- 活动监视器：`AXOutline` 高 13836，视口 472 → 一页 **3.4%**
- 滚一页实测：滚动条 `0.2976 → 0.3317` = **3.405%**（预测 3.45%）
- 反方向核对：从底部往上 20 页停在 `0.2976`，正是 `0.99 − 20×0.0345`

网页内容不报告高度 → 量不出页，按 20 行/页估算，**回执里标注**
（`unit=pages(estimated as 20 notches)` vs `unit=pages`）。

### 4.3 复验命令

> ⚠️ `biny` 跑的是 `dist/` 里的**构建产物**，不是当前源码。改过源码后要么先构建，
> 要么用开发态入口 `pnpm tsx src/cli/index.ts cu ...`（本节命令都用后者核对过）。

```bash
node scripts/run-tests.mjs --standard computer          # 74 用例
pnpm typecheck

pnpm tsx src/cli/index.ts cu status                     # helper 包 + 守护进程状态
pnpm tsx src/cli/index.ts cu windows <pid>              # 真实 CGWindowID
pnpm tsx src/cli/index.ts cu snap <pid> --no-shot       # 只读树
pnpm tsx src/cli/index.ts cu scroll down --pid <pid> --pages 1 --json   # 看 unit（AX 路由还给 fraction）
pnpm tsx src/cli/index.ts cu lens off
```

`fraction` 只在 **AX 路由**上有；网页内容走滚轮路由，回执是
`unit=pages(estimated as 20 notches)`、没有 fraction —— 因为那里量不出页大小。

---

## 5. 已实现：原生意图层（Layer 1 app-command dispatch）

参照的 helper 二进制里有一整层本仓库原先没有的东西 —— 按应用注册的**原生意图**：
不驱动 UI，直接把已知意图派给应用。

```
Invoke a pre-registered app-native intent (Layer 1 app-command dispatch).
  Example: intent='play_song', bundle='com.netease.163music', args={'id': 12345}.
Open NetEase Music without changing frontmost app.
Open a URL via LaunchServices. Routes a URL-scheme or document URL to the handler app
  without simulating a click (Layer 1).
```

机制从产物里读得到（URL scheme + `NSWorkspace.open`）：

```
" this is the raw `orpheus://route/<name>` bridge."
orpheus://song/?id=  ·  orpheus://song/?id=  ·  orpheus://playlist/?id=
orpheus://route/dailyRecommend  ·  orpheus://route/historyRecommend
```

本实现落地为 `intent` 动词（daemon + `biny cu intent`），注册了上面四个网易云路由
加一个通用的 `open_url`。

**它顺带解掉了此前那个死结**：网易云的搜索框收不到合成按键（§3.2），
但 **`orpheus://` 路由它认** —— 所以对这类应用，能派意图就别去点界面。

**一条重要的边界（实测）**：`activates: false` 只是**请求**，处理者可以不理。

| 目标 | 派发后前台 |
|---|---|
| 网易云 `orpheus://route/historyRecommend` | **不变**（与参照描述一致）|
| Chrome 处理 `https://` | **被顶到前面** |

所以"不动前台"不是这条路径的性质，是**具体应用的性质** —— 参照选 orpheus 路由正是为此。

---

## 5.5 Appshot：全局热键抓当前应用（daemon 侧已实现，热键投递受阻）

参照有一条**面向用户**的通路：设置里的 `appshots.hotkey`，按下就把**当前前台应用**
（排除自己）抓下来，还带快门声（二进制里的 `[appshot-sound]`）。daemon 侧动词：

```
appshot_monitor_start { hotkey }  ·  appshot_monitor_stop
appshot_frontmost { exclude_bundle_id }  ·  appshot_capture
```

**归属更正（同日更晚）**：我先前写"实际是用户按一下就能触发的抓取"，**也不够准**。
查 app 侧消费方后：appshot 属于**活动记录**那条线（`frontmost` 跟踪、`maybeCapture("visual_change")`
那套），热键是**用户手动抓一张进记录**。所以它不是独立功能，是活动记录的一个入口。

**这决定了应用侧接线的归属**：本仓库的活动记录有自己的 sidecar（`native/activity-ocr`），
要接就是把 recorder 的抓帧换成 daemon 的 appshot —— 属于活动记录那块，**不在本次改动范围内**
（那块当前有未提交改动）。daemon 侧动词已齐并已验证，接线留给那条线自己决定。

**已实现**：动词齐了、前台识别准了。热键写法 `Ctrl+Alt+C` / `double-cmd`（单按修饰键两次，
对应参照的 `BareModifierMonitor` + `doubleTapWindow`）。**参照的确切格式没完全还原**，
这是一套合理子集。

**已验证**：热键端到端可用。用 daemon 的全局派发（`press_key … global: true`）触发，
`eventsSeen: 1` 且落下一张 **1280×832、36883 字节**的 JPEG —— 抓的是当前前台应用。
（过程见 §3.1 第三次修正：先前"收不到事件"是我的注入源无效，不是 tap 的问题。）

`appshot_status` 仍分别报 `armed` / `live` / `eventsSeen` —— 这三个是三个不同的失败点，
合成一个布尔值就分不出"没装"、"装了没生效"、"装了在等按键"。

---

## 6. 尚未实现：daemon 自带 TCP MCP server

helper 二进制里还有一条本仓库没有的接口：

```
MCPServer · MCPError · boundPort · bearerToken · tokenPath
/Library/Application Support/Alma/computer-use.sock     ← 系统级 socket（与用户级并存）
alma-cu://tool-catalog                                  ← MCP resource
[alma-cu] MCP server listening on 127.0.0.1:
[alma-cu] MCP peer pid=
```

即：**参照的守护进程自己监听一个本地 TCP 端口并提供 MCP**，用 bearer token 鉴权
（token 落盘，`tokenPath`）。这比"主应用写进 mcp.json 的 stdio server"多一层 ——
外部 MCP 客户端可以**不经主应用**直接连守护进程。

从类名还能看出 daemon 的内部分工（`strings` 提取的 Swift 类名）：

```
FocusStealPreventer · LensOverlay · MCPServer · ElementStore · Daemon
PIPManager · PIPFloaterWindow · PIPContentView · PIPLens · PIPSession · PIPMinimizeArmer
PreserveFrontmostWatcher · VictimObserver · AXEnablementAssertion
ShareableContentCache · BareModifierMonitor · AppshotEvents
```

其中三块本仓库没有对应物，一并记在这里：

- **PiP 是按窗口的镜像会话**（`PIPSession` + `main/PIPWindow.swift`），而且**劫持最小化**：
  `PIPMinimizeArmer` / "armed minimise-hijacks" / "PIP auto-open on minimise failed for wid=" ——
  被监督的窗口一旦最小化，PiP 自动顶上（否则用户就看不见 agent 在干什么了）。
  它的 MCP tool 描述也在二进制里："Close one (by window_id) or all (all: true) PIP mirrors."
  本仓库的 PiP 是**单个预览面**，由用户偏好 × 活动驱动，没有按窗口镜像、也没有最小化劫持。
- **Appshot / AppshotEvents**：另一套 tap + AX 快照的监控（`[appshot-monitor] tap disabled`、
  "AX snapshot timed out"、"Target app has no on-screen window to appshot"），给活动记录用。
  本仓库的活动记录走独立 OCR sidecar + 定时截图，不是事件驱动。
- `ShareableContentCache`：缓存 `SCShareableContent` 枚举。**实测只值 15–47ms**
  （而一次截图 ~670ms），本仓库每次重枚举，暂不改。

本仓库现状：有原生工具（模型侧）+ `biny computer mcp`（stdio）。**没有** daemon 侧 TCP MCP。
未实现的原因不是难，是**收益与已有两条路重叠较多，且 token 鉴权 + 端口暴露面需要单独设计**；
先记为缺口而不是照抄。

---

## 7. 已知未覆盖

- **设置页没有 i18n 层**：参照那一节是 36 个 `settings.computerUse.*` key；本仓库**全仓没有
  i18n 机制**（整个设置区都是内联文案），所以对齐的是**内容**而不是键名。
  校验方式：把参照的 36 个 key 逐条映射到本实现的界面元素，全部有对应物
  （含容易漏的两处：`focusGuardTitle/Body` 的焦点保护告警、`testMySetup` 的"测试我的配置"按钮）。
- **仅 macOS**：全部实现基于 AX / ScreenCaptureKit / CGEvent，无跨平台路径。
- **网页内容量不出页**：§4.2 的估算路径。
- **`CGEventSetWindowLocation`** 在本环境对双击选词**没有区别**（两种都选区不变），
  故未采用；它是参照 §3 提到的"窗口局部坐标管线"，本实现的鼠标事件走全局投递。
- **本仓库另有两处不属于本工作的测试问题**（不在本文件范围，仅记录）：
  `tests/activity-tray.test.ts` 因未提交的改名断言过时会中止整个套件。
