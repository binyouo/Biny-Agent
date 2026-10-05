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
| 设置页 Computer Use 节 | 全 i18n key | 同 | 键名逐条对齐 |
| PiP 监督窗 | 悬浮画中画 · 3fps · 90s 无活动自动结束 | 同 | 窗口 `vibrancy: hud`；寿命由偏好 × 活动驱动 |
| 权限引导浮层 | 520×76，贴目标控件 | 同 | 几何模块 + OCR 定位行 |
| **动作指示器（lens）** | `Overlay.swift` · `LensOverlay`/`ActionCursor` · `alma.lens.scrollBadge`/`typeBadge` | 同 | 见下 |

**lens 是全屏覆盖层，三条硬约束**（缺一条就会打扰用户）：

1. **穿透点击** `ignoresMouseEvents = true` —— 否则它会吃掉用户所有点击
2. **不抢焦点** —— `NSWindow` 子类覆写 `canBecomeKey/canBecomeMain` 为 false，用 `orderFrontRegardless()`
3. **不进 Dock** —— daemon 本身是 `LSUIElement`

穿透这条**是验的不是声明的**：lens 在点击**之前**弹出、盖满全屏，此时双击仍能选中词。
开关行为：`off` 与 `show_cursor:false` 都不出现，默认出现（用 `.optionOnScreenOnly` 判可见）。

### 1.3 生命周期与并发

| 项 | 参照 | 本实现 |
|---|---|---|
| socket 按**二进制 sha1** 隔离 | 是 | 按二进制**内容**哈希（还没构建时退回路径） |
| 空闲自退 | 900s | 同 |
| 多调用方**共用一个 daemon** | 是 | 先试探已有 socket，连不上才 spawn |
| 请求超时 | 默认 20s / 截图 30s | 同 |

依据：同一二进制换目录跑，socket 名不变；第二个 driver 能用第一个观察到的 ref。

### 1.4 安全护栏

| 项 | 参照 | 本实现 |
|---|---|---|
| 按 app 审批 | `check_approval`，strict 未批准即拒 | 同（本地配置表） |
| 操作日志 | tool/bundle/pid/**args**/duration/error_code | tool/**bundle**/pid/**error_code**/duration（**不含 args**，见 §2.1） |
| 焦点护栏失败提示 | 附在动作结果上，30s 节流 | 同 |
| 前台铁律 | MCP instructions + 守护进程文案双写 | 同 |
| 未验证的交付不算成功 | 是 | 同（`action_unverified`） |

### 1.5 工具 / 技能层

- 模型侧工具：`ComputerList` / `ComputerObserve` / `ComputerAction`（8 个动作动词）
- MCP 出口：13 个工具（stdio）
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

### 3.1 `CGEventTap` 焦点零抢占（机制不明，保留事后补救）

参照用 `CGEventTapCreateForPid` + dlsym `CGEventPostToPid` + `CGEventSetWindowLocation` 做**事前拦截**。
实测：前两者**动态符号都存在**（无权进程建 tap 返回 nil）。但文档只说"用了哪些 API"、
没说**怎么组合** —— tap 是投递通道还是拦截器，猜不出来。
**事件 tap 是系统级输入面，猜错会改掉用户的键盘行为**，所以没做。

本实现的替代：动作后每 5ms 巡查、一被抢立刻还（可见窗口 30ms → ~5ms）。
**这是把差异压小，不是消除** —— 参照是"不给它抢的机会"，本实现是"抢了快速还"。

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

## 5. 已知未覆盖

- **仅 macOS**：全部实现基于 AX / ScreenCaptureKit / CGEvent，无跨平台路径。
- **网页内容量不出页**：§4.2 的估算路径。
- **`CGEventSetWindowLocation`** 在本环境对双击选词**没有区别**（两种都选区不变），
  故未采用；它是参照 §3 提到的"窗口局部坐标管线"，本实现的鼠标事件走全局投递。
- **本仓库另有两处不属于本工作的测试问题**（不在本文件范围，仅记录）：
  `tests/activity-tray.test.ts` 因未提交的改名断言过时会中止整个套件。
