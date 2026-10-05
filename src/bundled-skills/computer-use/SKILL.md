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

## 滚动：两条路由，守护进程按目标自己选

| 目标 | 路由 | 表现 |
|---|---|---|
| 原生滚动区（备忘录、文本编辑、Numbers…）| **AX**：写滚动条的 `AXValue` | 返回里带 `route: "ax"` 和 `from`/`to` 位置 |
| 网页内容（Chrome、内嵌 CEF 应用）| **滚轮**：向该进程投滚轮事件 | 返回里带 `route: "wheel"` |

不用你选——两者是互补的，不是备选：网页内容由浏览器自绘，**根本不暴露** `AXScrollBar`，
只有原生区才暴露。所以按目标暴露了什么定，而不是按猜测。

`amount` 是"格"（1–10）：AX 路由上一格 = **滚动范围的 10%**（滑块尺寸读不到，
算不出"一页"多大，这是约定不是测量值）；滚轮路由上一格是系统的一个行单位。
两者单位不同，别把它们当同一个距离。
可用的动作共 8 个：`click` · `type_text` · `press_key` · `scroll` · `drag` ·
`perform_secondary_action`（右键/上下文菜单）· `set_value`（直写控件值）· `select_text`。

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
