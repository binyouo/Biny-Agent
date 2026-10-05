---
name: computer-use
description: "Operate native macOS apps on the user's behalf — observe a window's accessibility tree plus a screenshot, then click, type, press keys, scroll, drag, open a context menu, write a control value or select text. Use when the user asks Biny to drive a Mac app (邮件, 备忘录, 音乐, 网易云音乐, Notion, Numbers, Clock…), to read what is on screen, or to perform actions inside an app that has no CLI or API. Not for web pages — use the `browser` skill for those. Requires the user to have granted Accessibility and Screen Recording, and to have approved the target app."
---

# Computer Use Skill (macOS)

用 Biny 操控本机 Mac 应用。所有动作都在**后台**执行：不移动用户的真实光标，也不把目标应用拿到前台。

## 什么时候用

- 用户让你操作某个 Mac 应用（点按钮、输入、切视图、播放…）
- 用户问「屏幕上现在是什么」「那个窗口里写了啥」
- 目标应用没有 CLI / API，只能走界面

**不要用**：网页内容（用 `browser` 技能）；命令行能干的事（用 Bash）。

## 两个接口

| 场景 | 用什么 |
|---|---|
| Biny 内置 agent | `ComputerList` / `ComputerObserve` / `ComputerAction` 工具 |
| 外部 MCP 客户端 | `biny computer mcp` 暴露的 13 个工具 |

两者共用同一个守护进程（`computer-use.app`），能力完全一样。

## 优先用 ref，不要用像素——这不只是精确度问题

`click` 既能给元素 ref，也能给截图坐标。**能用 ref 就用 ref。**

区别在焦点：ref 走无障碍 API，让控件执行它自己的动作，**不需要键盘焦点、也不会动前台**；
像素点击是合成鼠标事件，而**合成鼠标事件本身就会把目标窗口带到前台**。

参照实现的硬规则把这条写死了：绝不能抢用户的焦点，**"连一瞬都不行，也绝不许用
'先把窗口提到前面再放回去'这种做法"**。像素点击正是会触发它的那条路。

所以：控件有可用 ref 时用 ref；点了没反应再退像素，并知道这一次会短暂动到前台。
## 滚动：两条路由，守护进程按目标自己选

| 目标 | 路由 | 表现 |
|---|---|---|
| 原生滚动区（备忘录、文本编辑、Numbers…）| **AX**：写滚动条的 `AXValue` | 返回里带 `route: "ax"` 和 `from`/`to` 位置 |
| 网页内容（Chrome、内嵌 CEF 应用）| **滚轮**：向该进程投滚轮事件 | 返回里带 `route: "wheel"` |

不用你选——两者是互补的，不是备选：网页内容由浏览器自绘，**根本不暴露** `AXScrollBar`，
只有原生区才暴露。所以按目标暴露了什么定，而不是按猜测。

`pages` 是**页**（默认 1）：一页 = 视口 / 内容，由守护进程从滚动区**量出来** ——
滚动区里最大的那个非滚动条子元素就是内容（活动监视器实测：内容 13836、视口 472 → 一页 3.4%）。

网页内容不暴露内容高度，量不出页，那里会按 20 行/页估算。**回执里的 `unit` 会说明
用的是哪个单位、是量的还是估的** —— 关心滚动距离时先看它。
两者单位不同，别把它们当同一个距离。
## 先看有什么

`list_apps` 给两类：

- **运行中**：带 `pid`，可以直接 `get_app_state` 观察、直接操作
- **近 30 天用过但没在运行**：只有 `bundleId`（没有 pid，正常），这些是 `launch_app` 的候选

只跑后端的辅助进程（`LSUIElement`/`LSBackgroundOnly`）已被滤掉，所以列表里剩下的
都是用户真会用的应用。**要用哪个应用先在这里查 bundle id，别猜。**

## 挑窗口：把一个应用的窗口列出来

`ComputerList` 带上 `pid` 就是问**这个应用有哪些窗口**，返回真实的 `window_id`：

```
{ "apps": [{ "pid": 653, "name": "Google Chrome", "windows": [
  { "window_id": 121, "title": "Biny-Agent", "frame": {...} },
  { "window_id": 104, "title": "新标签页",   "frame": {...} } ] }] }
```

**多窗口应用必须挑**：把挑中的 `window_id` 传给 `ComputerObserve`，观察和截图都会
落在那一个窗口上，并且回报的 `window_id` 就是你请求的那个。不传也能用，守护进程
会挑该应用的第一个普通窗口。

可用的动作共 8 个：`click` · `type_text` · `press_key` · `scroll` · `drag` ·
`perform_secondary_action`（右键/上下文菜单）· `set_value`（直写控件值）· `select_text`。

## 启动应用：绝不用 `open -b`

`open -b <bundle>` **默认会激活应用**，把用户正在做的事顶掉。**永远不用它。**

- 直接用 `ComputerObserve`（或 `biny cu snap`）就够 —— **目标没在跑时守护进程会后台把它拉起来**，
  这是默认行为，不用先 launch。
- 要显式控制就用 `launch_app` / `biny cu launch_app <bundle>`：它走
  `NSWorkspace.openApplication` 并把 `activates` 关掉。

目标只有一个：**即使用户要的应用是冷启动，他的前台应用和当前 Space 也不该被动到。**

⚠️ 但这是一条**请求**，不是保证：实测「预览」「App Store」冷启动都不动前台，
而 **FaceTime 会自己跳到前面**（通话类应用如此）。所以别把它当成不可能失败的前提 ——
真在意的话，动作前后各确认一次前台。

## 每一轮都从观察开始

先 `ComputerObserve`（或 MCP 的 `get_app_state`）拿一次快照：它一次返回**无障碍树和窗口截图**两样东西。

- **元素 ref 只对最近一次快照有效。** 报 `ref_stale` / `element_not_found` 就重新观察，
  不要拿着旧 ref 反复试。
- 有 AX 树时优先用 ref：走无障碍接口，省 token 也不受坐标换算影响。
- 没有 AX 树时（Qt 应用、自绘界面）`elements` 会是空的，但**截图照有**——
  从截图读出坐标，用像素点击。见 `playbooks/NetEaseMusic.md`。

## 动作之后要回读

动作工具会**带回动作后的新截图**，这样一步做完就能看到结果，不必再观察一次。

但截图只能说明「画面变了」，不能证明「变成你想要的样子」。要做实的事情
（写进了内容、切到了某个视图），再观察一次读回真实值确认。

## 绝不做的事

- **不抢用户的焦点。** 不把应用调前台，不移动真实光标。这是硬规则，没有例外。
  守护进程自己也不会抢；目标应用自己抢走时，焦点守卫会把它还回去。
- **不重放结果未知的动作。** 传输中断或进程退出时，输入可能已经送达也可能没有。
  这时重新观察、看当前状态再决定，**不要重发**。
- **不绕过应用授权。** 未批准的应用会被拒绝。让用户去 设置 → Computer Use 批准，
  不要试图绕开。

## 输入送不进去的时候

有些应用会丢弃合成的键盘事件。**看 `type_text` / `press_key` 的返回里有没有 `warning`**：

- 有 `keystrokes_may_be_dropped` → 目标不在前台且没有任何聚焦的 UI 元素，
  这些按键**大概率已经被系统丢掉了**。别把它当成写进去了。
- 没有警告也**不等于**安全：回读一次确认才作数。

遇到丢弃就去换路径：用 `set_value` 直写控件值，或先 `select_text` 定位再输入；
都不行的话，这类自绘输入框只能请用户手动操作。

网易云音乐的搜索框就是典型：点击可用，键盘输入进不去。

## 限速与代价

- 截屏约 150ms，观察一棵大 AX 树再花 100–300ms。别在循环里频繁观察。
- 每次动作都带回执截图，够用就别额外观察。
- 应用审批、动作日志都在 设置 → Computer Use 里可见。

## 常见问题

| 症状 | 原因 / 做法 |
|---|---|
| `computer_disabled` | 用户在设置里关了桌面控制 |
| `computer_app_approval_required` | 严格审批模式下该应用未批准，让用户批准 |
| `ax_not_granted` | 辅助功能没授权；设置页有「授权辅助功能」按钮，它会弹出系统框 |
| `sc_not_granted` | 屏幕录制没授权，观察拿不到截图 |
| `ref_stale` | 快照过期，重新观察 |
| `app_not_found` | 应用没运行；`get_app_state` 会在后台把它拉起来 |
| `element_not_found` | 该元素这一拍不在树里（收起了/滚走了），重新观察 |

## 应用说明书

`playbooks/` 下有逐个应用的要点（布局、捷径、已知坑）：

- `AppleMusic.md` · `Spotify.md` · `NetEaseMusic.md`
- `Notion.md` · `Numbers.md` · `Clock.md` · `IPhoneMirroring.md`
