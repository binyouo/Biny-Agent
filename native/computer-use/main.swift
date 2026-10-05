// 本机 Unix socket 截图 daemon。请求逐行 JSON，主进程负责调度和降级。
import Foundation
import AppKit
import ScreenCaptureKit
import Darwin
import ApplicationServices
import CoreGraphics
import Carbon.HIToolbox

var refTables: [pid_t: [String: AXUIElement]] = [:]
// 截图坐标 → 屏幕坐标的映射（pid → 比例与偏移）。
var coordMaps: [pid_t: (scale: Double, ox: Double, oy: Double, sw: Double, sh: Double)] = [:]
let driverVersion = "native-1"
/// 滚轮路由上「一页」约等于几行。网页内容不暴露内容高度，算不出真正的页，
/// 这是有意的估算（且回执会说明），不是测量值。
let linesPerPage: Double = 20
let startedAt = Date()
let replyLock = NSRecursiveLock()
func reply(_ fd: Int32, _ value: [String: Any]) {
    replyLock.lock(); defer { replyLock.unlock() }
    guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
    data.append(10)
    data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count <= 0 { break }; offset += count
        }
    }
}

// MARK: - 权限检查
// MARK: - Lens：动作指示器

/// 让用户**看见** agent 正在哪里动手。
///
/// 参照实现的 helper 里是 `main/Overlay.swift`，含 `LensOverlay` / `LensView` /
/// `ActionCursor`，以及 `alma.lens.scrollBadge` / `alma.lens.typeBadge` 两个角标图层 ——
/// 也就是「光标落点 + 这一次做了什么」。`lens on|off|toggle` 开关它，
/// 单个动作可以用 `show_cursor=false` 临时不显示。
///
/// 三条硬约束，缺一条就会打扰用户：
/// **穿透点击**（ignoresMouseEvents）· **不抢焦点**（canBecomeKey=false，只用
/// orderFrontRegardless）· **不进 Dock**（daemon 本身是 LSUIElement）。
/// 指示器窗口永不成为 key/main —— 它只是浮在最上面的一层画。
final class LensWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class LensOverlay {
    private var window: NSWindow?
    private var cursorLayer: CAShapeLayer?
    private var badgeLayer: CALayer?
    private var hideTimer: Timer?
    private let size: CGFloat = 44
    private let fadeIn: TimeInterval = 0.12
    private let linger: TimeInterval = 1.1

    private func ensureWindow() -> NSWindow {
        if let window { return window }
        let window = LensWindow(
            contentRect: NSScreen.main?.frame ?? .zero,
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        // 穿透：鼠标事件原样落到下面的应用，指示器本身绝不能吃掉点击。
        window.ignoresMouseEvents = true
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        content.wantsLayer = true
        let cursor = CAShapeLayer()
        cursor.opacity = 0
        let badge = CALayer()
        badge.opacity = 0
        content.layer?.addSublayer(cursor)
        content.layer?.addSublayer(badge)
        window.contentView = content
        self.window = window
        self.cursorLayer = cursor
        self.badgeLayer = badge
        return window
    }

    /// 在屏幕坐标处显示一次动作指示。`symbol` 是这次动作的角标（滚动/输入），空则只显示落点。
    func show(at point: CGPoint, symbol: String?) {
        let window = ensureWindow()
        guard let cursor = cursorLayer, let badge = badgeLayer, let root = window.contentView?.layer else { return }
        hideTimer?.invalidate()

        // 屏幕坐标原点在左下，图层坐标原点在左上 —— 这里必须翻一次，否则指示器会跑到对侧。
        let flippedY = (NSScreen.main?.frame.height ?? 0) - point.y
        let ring = CGRect(x: point.x - size / 2, y: flippedY - size / 2, width: size, height: size)
        cursor.path = CGPath(ellipseIn: ring, transform: nil)
        cursor.fillColor = NSColor.systemBlue.withAlphaComponent(0.18).cgColor
        cursor.strokeColor = NSColor.systemBlue.withAlphaComponent(0.95).cgColor
        cursor.lineWidth = 2.5
        cursor.opacity = 1

        if let symbol, let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            let badgeSize = CGSize(width: 30, height: 22)
            badge.contents = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            badge.contentsGravity = .resizeAspect
            badge.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.92).cgColor
            badge.cornerRadius = 6
            badge.frame = CGRect(x: ring.maxX - 2, y: ring.minY - badgeSize.height + 6, width: badgeSize.width, height: badgeSize.height)
            badge.opacity = 1
        } else {
            badge.opacity = 0
        }

        window.orderFrontRegardless()
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0; fade.toValue = 1; fade.duration = fadeIn
        cursor.add(fade, forKey: "in")
        root.opacity = 1

        hideTimer = Timer.scheduledTimer(withTimeInterval: linger, repeats: false) { [weak self] _ in self?.hide() }
    }

    func hide() {
        hideTimer?.invalidate(); hideTimer = nil
        cursorLayer?.opacity = 0
        badgeLayer?.opacity = 0
        window?.orderOut(nil)
    }
}

let lensOverlay = LensOverlay()
var lensEnabled = true
var lastActionPoint: CGPoint?

/// 记一次动作落点。
///
/// 命令处理跑在全局队列线程上，而 AppKit 只能主线程碰 —— 必须派过去。
/// `show_cursor=false` 表示这一次不要指示器（`--no-cursor`）。
func noteActionPoint(_ args: [String: Any], _ point: CGPoint?, symbol: String?) {
    guard lensEnabled, args["show_cursor"] as? Bool ?? true else { return }
    // 打字这类动作没有坐标：沿用上一次落点，用户仍能看到「它正在这里输入」。
    let target = point ?? lastActionPoint
    guard let target else { return }
    lastActionPoint = target
    DispatchQueue.main.async { lensOverlay.show(at: target, symbol: symbol) }
}

func axTrusted() -> Bool { return AXIsProcessTrusted() }
func screenTrusted() -> Bool { return CGPreflightScreenCaptureAccess() }

// MARK: - AX 元素查找
func axApp(_ pid: pid_t) -> AXUIElement {
    let element = AXUIElementCreateApplication(pid)
    // 单个 AX 调用最多等 1 秒，避免大型应用（Chrome 等）把整个请求拖死。
    AXUIElementSetMessagingTimeout(element, 1.0)
    return element
}
func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}
func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    return axCopy(element, attribute) as? String
}
func axFrame(_ element: AXUIElement) -> [String: Double]? {
    guard let posValue = axCopy(element, kAXPositionAttribute as String),
          let sizeValue = axCopy(element, kAXSizeAttribute as String) else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return ["x": Double(point.x), "y": Double(point.y), "w": Double(size.width), "h": Double(size.height)]
}
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    return (axCopy(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

// 遍历 AX 树，深度与元素数都有上限，并回填可点击元素的 ref 表
func axWalk(_ root: AXUIElement, depth: Int, maxDepth: Int, limit: Int, counter: inout Int, table: inout [String: AXUIElement], out: inout [[String: Any]], deadline: Date) {
    guard depth <= maxDepth, counter < limit, Date() < deadline else { return }
    for child in axChildren(root) {
        // 每次下探前都查预算：单个 AX 调用是跨进程 IPC，最坏情况会明显超时。
        guard counter < limit, Date() < deadline else { return }
        // 每个子元素设独立超时：某个 app 的子树不应把整个请求拖死。
        AXUIElementSetMessagingTimeout(child, 0.5)
        counter += 1
        let ref = "e\(counter)"
        table[ref] = child
        var entry: [String: Any] = ["ref": ref]
        let role = axString(child, kAXRoleAttribute as String) ?? ""
        entry["role"] = role
        // 每个属性都是一次跨进程 IPC。纯容器（AXGroup/AXScrollArea 等）只取 role，
        // 只有可交互或带语义的节点才值得把其余属性拉全——否则深树会把预算烧光。
        let meaningful = !(role == "AXGroup" || role == "AXScrollArea" || role == "AXSplitGroup" || role == "AXLayoutArea" || role == "AXLayoutItem")
        if meaningful {
            // focused 是有用信号：按键能不能落地就看它（type_text 的丢弃警告用的就是同一个属性）。
            if let focused = axCopy(child, kAXFocusedAttribute as String) as? Bool, focused { entry["focused"] = true }
            if let title = axString(child, kAXTitleAttribute as String), !title.isEmpty { entry["title"] = title }
            if let value = axCopy(child, kAXValueAttribute as String) as? String, !value.isEmpty { entry["value"] = value }
            if let desc = axString(child, kAXDescriptionAttribute as String), !desc.isEmpty { entry["description"] = desc }
            if let enabled = axCopy(child, kAXEnabledAttribute as String) as? Bool { entry["enabled"] = enabled }
            if let frame = axFrame(child) { entry["frame"] = frame }
        }
        out.append(entry)
        axWalk(child, depth: depth + 1, maxDepth: maxDepth, limit: limit, counter: &counter, table: &table, out: &out, deadline: deadline)
    }
}

// MARK: - 目标解析
func resolvePid(_ parameters: [String: Any]) throws -> pid_t {
    if let pid = parameters["pid"] as? Int { return pid_t(pid) }
    if let bundle = parameters["bundle"] as? String {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app.processIdentifier }
        throw NSError(domain: "app", code: 1, userInfo: [NSLocalizedDescriptionKey: "app_not_found: \(bundle)"])
    }
    throw NSError(domain: "app", code: 64, userInfo: [NSLocalizedDescriptionKey: "app_not_found: missing pid/bundle"])
}

// MARK: - 输入合成（全部走 PostToPid，不抢焦点、不动真实光标）
/// 鼠标事件必须**全局投递**。
///
/// 实测（TextEdit，双击选词）：`postToPid` → 选区 loc=0 len=0，纹丝不动；
/// 全局 post → 选中 8 个字符。投给进程的鼠标事件到不了窗口，而 API 照样返回成功 ——
/// 调用方会以为点过了。这是键盘那条「按键被丢弃」的同一类失败，只是更隐蔽。
///
/// 代价是光标会被挪一下，所以整段点击序列前后把它放回原处。
func postMouse(_ pid: pid_t, _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, clickState: Int64 = 1, global: Bool = false) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    if global { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
}
func postKey(_ pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { return }
    down.flags = flags; up.flags = flags
    down.postToPid(pid); up.postToPid(pid)
}
func postUnicode(_ pid: pid_t, _ text: String) {
    for scalar in text.unicodeScalars {
        var unit = UniChar(scalar.value)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
        down.postToPid(pid); up.postToPid(pid)
    }
}
let keyNameMap: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
    "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]
func parseKeyCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let last = parts.last, let keyCode = keyNameMap[last] else { return nil }
    var flags = CGEventFlags()
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }
    return (keyCode, flags)
}

/// 目标应用主窗口在屏幕上的真实位置（CGEvent 坐标系）。
/// 某个应用的在屏窗口。
///
/// kCGWindowNumber 就是调用方传回来的 window_id —— 两边同一个编号，所以模型列完窗口
/// 就能指着具体某一个去观察。层 0 才是普通窗口（菜单、浮层、提示在更高层）。
// 私有 API：AXUIElement → CGWindowID。macOS 没有公开的对应接口，
// 而「按 window_id 指定窗口」需要它把两边对上。实测映射准确。
typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let axWindowIdFn: AXGetWindowFn? = {
    guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY),
          let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: AXGetWindowFn.self)
}()

/// 按 CGWindowID 找到对应的 AX 窗口（就是 windowsForApp 列出来的那个编号）。
func axWindow(pid: pid_t, matching windowId: Int) -> AXUIElement? {
    guard let lookup = axWindowIdFn,
          let windows = axCopy(axApp(pid), kAXWindowsAttribute as String) as? [AXUIElement] else { return nil }
    for window in windows {
        var id: CGWindowID = 0
        if lookup(window, &id) == .success, Int(id) == windowId { return window }
    }
    return nil
}

/// 通过 Apple Events 请求目标应用把自己激活。
///
/// 后台进程直接调 `NSRunningApplication.activate` 会被系统拒绝 —— 实测三种写法全都
/// 无效（AX 的 kAXFrontmost 甚至返回成功但前台没变）。Apple Events 是向应用「请求」，
/// 走的是目标应用自己的 scripting 支持，系统允许。
/// 需要 plist 里的 NSAppleEventsUsageDescription，否则连授权弹窗都不会出现。
func activateViaAppleEvents(_ bundleId: String) -> String? {
    guard !bundleId.isEmpty else { return "bundle_unknown" }
    let script = NSAppleScript(source: "tell application id \"\(bundleId)\" to activate")
    var error: NSDictionary?
    _ = script?.executeAndReturnError(&error)
    if let error { return "\(error[NSAppleScript.errorNumber] ?? "?")" }
    return nil
}

func windowsForApp(_ pid: Int) -> [[String: Any]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [[String: Any]] = []
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let number = window[kCGWindowNumber as String] as? Int,
              let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let width = Double(bounds["Width"] ?? 0), height = Double(bounds["Height"] ?? 0)
        // 阴影和辅助小窗不是可观察目标，混进来只会让模型挑错。
        if width < 40 || height < 40 { continue }
        var entry: [String: Any] = [
            "window_id": number,
            "title": window[kCGWindowName as String] as? String ?? "",
            "frame": ["x": Double(bounds["X"] ?? 0), "y": Double(bounds["Y"] ?? 0), "w": width, "h": height] as [String: Double],
        ]
        if window[kCGWindowIsOnscreen as String] as? Bool == true { entry["onscreen"] = true }
        out.append(entry)
    }
    return out
}

/// 某个应用第一个「普通窗口」（层 0）的 CGWindowID，与 windowScreenBounds 选的是同一个。
/// 用来把 windowId 上报成真窗口号，而不是拿 pid 冒充。
/// 按钮名 → CGMouseButton。默认左键。
func mouseButton(_ name: String?) -> CGMouseButton {
    switch name {
    case "right": return .right
    case "middle": return .center
    default: return .left
    }
}

/// 合成一次点击序列。
///
/// 双击**不是"发两次单击"**：系统靠 mouseEventClickState 认这是第几下，
/// 每次都带对序号、中间留出能被认作连续点击的间隔，才会被当成双击。
/// 少了这个，在 Finder 里点两下文件只会被选中两次，永远不会打开它。
func postClick(_ pid: pid_t, _ point: CGPoint, button: CGMouseButton, clicks: Int) {
    let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
    let saved = CGEvent(source: nil)?.location
    let total = max(1, clicks)
    for index in 1...total {
        postMouse(pid, down, point, button, clickState: Int64(index), global: true)
        postMouse(pid, up, point, button, clickState: Int64(index), global: true)
        // 太快会被系统合并成一下，太慢会被当成两次独立点击。
        if index < total { usleep(60_000) }
    }
    // 光标是我们挪的，用完放回去 —— 用户不该因为一次自动化发现鼠标换了位置。
    if let saved { CGWarpMouseCursorPosition(saved) }
}

func windowNumberForApp(_ pid: Int) -> Int? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
              Double(bounds["Width"] ?? 0) >= 40, Double(bounds["Height"] ?? 0) >= 40,
              let number = window[kCGWindowNumber as String] as? Int else { continue }
        return number
    }
    return nil
}

func windowScreenBounds(pid: Int) -> [String: Double]? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0 else { continue }
        return ["x": Double(bounds["X"] ?? 0), "y": Double(bounds["Y"] ?? 0), "w": Double(bounds["Width"] ?? 0), "h": Double(bounds["Height"] ?? 0)]
    }
    return nil
}



/// 截图同样可能挂在无响应的窗口上：独立线程采集，主线程轮询到点就放弃。
/// 焦点守卫：很多 Cocoa/Electron 应用会在自己的点击处理里调
/// `activateIgnoringOtherApps:` —— 那是我们控制不了的代码，会把用户的前台窗口抢走。
/// 动作前记下当时的前台应用，动作后如果前台变成了目标应用，就切回去。
/// 这是安全网，不是操控手段：我们从不主动把应用拿到前台。
func withFocusGuard<T>(_ pid: pid_t, _ body: () async -> T) async -> T {
    let before = NSWorkspace.shared.frontmostApplication
    let restore = (before?.processIdentifier == pid) ? nil : before
    let value = await body()
    guard let restore else { return value }
    // 目标应用的自激活是异步落地的：等太短会漏（我们走了它才抢），
    // 等太久用户就真的看见自己的窗口被顶掉。
    // 所以每 5ms 巡查一次，一发现被抢就立刻还回去 —— 不等满整段。
    // 参照实现用的是 CGEventTapCreateForPid 做**事前**拦截，根本不给它抢的机会；
    // 这里是事后补救，只能把窗口压小，压不到零。
    let deadline = Date().addingTimeInterval(0.075)
    while Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            restore.activate(options: [])
            return value    // 已经还回去了，不必再巡查
        }
    }
    return value
}

/// 给异步工作加一个截止时间。
/// 早期实现用 Thread + 信号量阻塞等待：帧泵每 333ms 调一次，每次都占住一个 OS 线程
/// 最多 10 秒，线程只增不减，daemon 会越跑越慢直到截图彻底拿不到。
/// 这里改成两个协作式 Task 竞争，完全不阻塞线程。
func withDeadline(_ timeout: Double, fallback: [String: Any], work: @escaping () async -> [String: Any]) async -> [String: Any] {
    let lock = NSLock()
    var settled = false
    return await withCheckedContinuation { continuation in
        func finish(_ value: [String: Any]) {
            lock.lock(); defer { lock.unlock() }
            if settled { return }   // 双 resume 会让进程崩溃，必须守住。
            settled = true
            continuation.resume(returning: value)
        }
        Task { finish(await work()) }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            finish(fallback)
        }
    }
}

func collectAccessibility(pid: pid_t, maxDepth: Int, limit: Int, timeout: Double) -> ([[String: Any]], [String: AXUIElement]) {
    let box = AXCollectBox()
    let thread = Thread {
        let app = axApp(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        var elements: [[String: Any]] = []
        var table: [String: AXUIElement] = [:]
        var counter = 0
        if let windows = axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement], let main = windows.first {
            if let frame = axFrame(main) { elements.append(["ref": "e0", "role": "AXWindow", "frame": frame]) }
            table["e0"] = main
            axWalk(main, depth: 0, maxDepth: maxDepth, limit: limit, counter: &counter, table: &table, out: &elements, deadline: Date().addingTimeInterval(2))
        }
        box.store(elements, table)
    }
    thread.stackSize = 1 << 20
    thread.start()
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if box.done { break }
        Thread.sleep(forTimeInterval: 0.02)
    }
    return box.take()
}

/// 采集结果的线程安全暂存。
final class AXCollectBox: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var elements: [[String: Any]] = []
    private var table: [String: AXUIElement] = [:]
    var done: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    func store(_ nextElements: [[String: Any]], _ nextTable: [String: AXUIElement]) {
        lock.lock(); defer { lock.unlock() }
        if finished { return }
        elements = nextElements; table = nextTable; finished = true
    }
    func take() -> ([[String: Any]], [String: AXUIElement]) {
        lock.lock(); defer { lock.unlock() }
        return (elements, table)
    }
}


/// 截图像素 → 屏幕点。coord_space=screen 时原样返回。
func screenPoint(_ pid: pid_t, _ x: Double, _ y: Double, screenSpace: Bool) -> CGPoint {
    var sx = x, sy = y
    if !screenSpace, let m = coordMaps[pid] {
        sx = m.ox + x / m.scale
        sy = m.oy + y / m.scale
    }
    return CGPoint(x: sx, y: sy)
}

/// 拖拽：AX 没有拖这个动作，只能合成鼠标序列（按下 → 若干拖动点 → 抬起）。
func postDrag(_ pid: pid_t, from: CGPoint, to: CGPoint) {
    let saved = CGEvent(source: nil)?.location
    defer { if let saved { CGWarpMouseCursorPosition(saved) } }
    postMouse(pid, .leftMouseDown, from, global: true)
    let steps = 8
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        postMouse(pid, .leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), global: true)
    }
    postMouse(pid, .leftMouseUp, to, global: true)
}

/// 目标应用是否处在能接收键盘输入的状态。
///
/// 后台应用被投递的按键常被系统直接丢弃，而 API 会照常报"已输入"——
/// 这是最坏的一类失败：调用方以为写进去了。Alma 的守护进程会显式报这个
/// （notes/19 §3：「目标是后台 app 且无 key window，按键被系统丢弃」）。
/// AX 路由：写滚动条的 AXValue。
///
/// macOS 没有「整页滚动」这个 AX 动作常量。头文件写得很直接：scrollbar 的
/// kAXValueAttribute 可写，目的就是让调用方滚动。实测写进去立刻回读得到。
///
/// 两条路由是**互补**的，不是备选：网页内容（Chrome）不暴露 AXScrollBar
/// （浏览器自绘），只有原生滚动区才暴露。所以按目标**暴露了什么**来选，
/// 而不是按调用方的猜测。
/// 近 N 天用过的应用（**包含没在运行的**）。
///
/// 只看运行中的应用，模型就看不到这台机器上还有什么可以 launch —— 而 launch_app
/// 要的正是 bundle id。mdls 一次只吃一个文件（逐个问 30ms×N），NSMetadataQuery
/// 一次问完：实测 138 个应用 ~93ms，而且 bundle id 和最后使用时间一起给。
///
/// 结果靠 runloop 投递。主线程在 `RunLoop.main.run()` 上，是唯一确定被泵起来的那个；
/// 在全局队列里手动泵 runloop 会漏结果，所以派到主线程做完再等。
func recentlyUsedApplications(withinDays days: Int) -> [[String: Any]] {
    var collected: [[String: Any]] = []
    let finished = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        defer { finished.signal() }
        let query = NSMetadataQuery()
        query.searchScopes = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
        query.predicate = NSPredicate(format: "kMDItemContentTypeTree == 'com.apple.application-bundle'")
        query.valueListAttributes = [kMDItemLastUsedDate as String, kMDItemCFBundleIdentifier as String, kMDItemDisplayName as String, kMDItemPath as String]
        query.sortDescriptors = [NSSortDescriptor(key: kMDItemLastUsedDate as String, ascending: false)]
        query.start()
        // 守护进程不能因为 Spotlight 卡住就整体失去响应。
        let deadline = Date().addingTimeInterval(2)
        while query.isGathering && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        let cutoff = Date().addingTimeInterval(-Double(days) * 86_400)
        let formatter = ISO8601DateFormatter()
        for index in 0..<query.resultCount {
            guard let item = query.result(at: index) as? NSMetadataItem else { continue }
            guard let used = item.value(forAttribute: kMDItemLastUsedDate as String) as? Date, used >= cutoff else { continue }
            guard let bundle = item.value(forAttribute: kMDItemCFBundleIdentifier as String) as? String, !bundle.isEmpty else { continue }
            // 后台服务（LogiPluginService 这类）也带应用包标识和最后使用时间，
            // 但它们不是用户会去启动的东西。混进来只会淹没真正可用的选项。
            if let path = item.value(forAttribute: kMDItemPath as String) as? String,
               let info = Bundle(path: path)?.infoDictionary,
               (info["LSUIElement"] as? Bool == true) || (info["LSBackgroundOnly"] as? Bool == true) { continue }
            let name = item.value(forAttribute: kMDItemDisplayName as String) as? String ?? bundle
            collected.append(["bundleId": bundle, "name": name.replacingOccurrences(of: ".app", with: ""), "running": false, "lastUsed": formatter.string(from: used)])
        }
        query.stop()
    }
    _ = finished.wait(timeout: .now() + 3)
    return collected
}

func findScrollArea(_ root: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 12 { return nil }
    if axString(root, kAXRoleAttribute as String) == "AXScrollArea" { return root }
    for child in axChildren(root).prefix(40) {
        if let found = findScrollArea(child, depth: depth + 1) { return found }
    }
    return nil
}

/// 一页占滚动范围的比例 = 视口 / 内容。
///
/// 不需要滑块尺寸：滚动区的子元素里最大的那个就是内容。活动监视器实测
/// AXOutline 高 13836、视口 472 → 一页约 3.4%。读不到内容高度（内容不比视口高，
/// 或者结构不暴露）时返回 nil，调用方退回按比例估。
func pageFraction(_ area: AXUIElement) -> Double? {
    guard let areaFrame = axFrame(area), let viewport = areaFrame["h"], viewport > 0 else { return nil }
    var content: Double = 0
    for child in axChildren(area) where axString(child, kAXRoleAttribute as String) != "AXScrollBar" {
        if let frame = axFrame(child), let height = frame["h"], height > content { content = height }
    }
    guard content > viewport else { return nil }
    return min(1.0, viewport / content)
}

func axScroll(_ pid: pid_t, direction: String, notches: Int, pages: Double? = nil) -> [String: Any]? {
    let wantsVertical = direction == "up" || direction == "down"
    let forward = direction == "down" || direction == "right"
    guard let windowRef = axCopy(axApp(pid), kAXFocusedWindowAttribute as String) else { return nil }
    let window = unsafeBitCast(windowRef, to: AXUIElement.self)
    guard let area = findScrollArea(window) else { return nil }
    for bar in axChildren(area) where axString(bar, kAXRoleAttribute as String) == "AXScrollBar" {
        guard (axString(bar, kAXOrientationAttribute as String) == "AXVerticalOrientation") == wantsVertical else { continue }
        guard let current = axCopy(bar, kAXValueAttribute as String) as? Double else { continue }
        // 给了 pages 就按**真实的页**走（视口/内容）；否则退回「一格 ≈ 范围的 10%」
        // 这个有意的约定 —— 后者是估的，前者是量出来的，回执里会说明用的是哪个。
        let fraction: Double
        let unit: String
        if let pages {
            fraction = (pageFraction(area) ?? 0.1) * pages
            unit = pageFraction(area) == nil ? "pages(estimated)" : "pages"
        } else {
            fraction = Double(notches) * 0.1
            unit = "notches(estimated)"
        }
        let step = fraction * (forward ? 1 : -1)
        let target = min(1.0, max(0.0, current + step))
        guard AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, target as CFTypeRef) == .success else { continue }
        return ["scrolled": direction, "route": "ax", "unit": unit, "fraction": fraction, "from": current, "to": target]
    }
    return nil
}

func keyDeliveryWarning(_ pid: pid_t) -> String? {
    if NSRunningApplication(processIdentifier: pid)?.isActive == true { return nil }  // 前台，正常路径
    // 判据是「有没有聚焦的 UI 元素」，不是「有没有 key window」：
    // 实测网易云与文本编辑都有 key window，区别在于前者没有 AXFocusedUIElement，
    // 而它正是按键的去处。没有它，按键就是被系统丢掉。
    let axApp = axApp(pid)
    if axCopy(axApp, kAXFocusedUIElementAttribute as String) != nil { return nil }
    return "keystrokes_may_be_dropped: 目标应用不在前台，且没有任何聚焦的 UI 元素，这些按键很可能已被系统丢弃。先重新观察确认目标状态，别把它当成写进去了。铁律：绝不许为了让它收到输入就把应用调到前台——那是拿用户的焦点换的。"
}

/// 焦点护栏警告：护栏武装不起来时，动作可能真的会把用户的焦点带走。
/// 每 30 秒最多提示一次 —— 每一步都重复同一句话只会把结果淹没（Alma 同样做了节流）。
let focusGuardLock = NSLock()
var lastFocusGuardWarnAt = Date.distantPast
func focusGuardWarning() -> String? {
    if axTrusted() { return nil }   // 护栏靠 AX 还焦点，权限在就没事
    focusGuardLock.lock(); defer { focusGuardLock.unlock() }
    let now = Date()
    if now.timeIntervalSince(lastFocusGuardWarnAt) < 30 { return nil }
    lastFocusGuardWarnAt = now
    return "focus_guard_unavailable: 辅助功能权限缺失，焦点护栏无法武装，这些动作可能把用户的前台窗口带走。请用户到 设置 → Computer Use 重新授权（macOS 每次新构建都会重置该授权）。"
}

func screenshot(_ parameters: [String: Any]) async throws -> [String: Any] {
    guard let output = parameters["out"] as? String else { throw NSError(domain: "capture", code: 64) }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    // 指定 pid 时只截该应用的窗口；否则退化为整屏。
    if let pid = parameters["pid"] as? Int,
       content.applications.contains(where: { Int($0.processID) == pid }),
       let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first {
        // 真实屏幕位置：AX 报的 frame 是 UI 坐标，跟 CGEvent 用的屏幕点不一致，必须用 CGWindowList。
        let screenBounds = windowScreenBounds(pid: pid)
        // 指定了窗口就只拍那一个：调用方列过窗口列表、挑了一个，拍成别的就是契约在撒谎。
        // 没指定才退回「该 pid 的所有窗口」。
        let requestedWindow = parameters["window_id"] as? Int
        let others = content.applications.filter { Int($0.processID) != pid }
        var filter: SCContentFilter
        var capturedWindow: Int?
        if let requestedWindow,
           let match = content.windows.first(where: { Int($0.windowID) == requestedWindow }) {
            filter = SCContentFilter(desktopIndependentWindow: match)
            capturedWindow = requestedWindow
        } else {
            // 只保留目标 app 的窗口：除它之外的应用全部排除。
            filter = SCContentFilter(display: display, excludingApplications: others, exceptingWindows: [])
        }
        let rect = filter.contentRect
        // 截图尺寸必须与窗口内容区一致，否则像素坐标无法换算回屏幕点。
        let width = min(Int(rect.width), max(1, parameters["max_width"] as? Int ?? 1280))
        config.width = width
        config.height = max(1, Int((rect.height * CGFloat(width) / max(1, rect.width)).rounded()))
        // 窗口在屏幕上的真实位置（CGWindowList 的坐标就是 CGEvent 用的屏幕点）。
        let contentFrame: [String: Double] = screenBounds ?? ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "w": Double(rect.width), "h": Double(rect.height)]
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: parameters["quality"] as? Double ?? 0.55]) else { throw NSError(domain: "capture", code: 2) }
        try data.write(to: URL(fileURLWithPath: output), options: .atomic)
        if capturedWindow == nil { capturedWindow = windowNumberForApp(pid) }
        var result: [String: Any] = ["path": output, "width": config.width, "height": config.height,
                                     "screenFrame": contentFrame, "frame": contentFrame]
        if let capturedWindow { result["windowId"] = capturedWindow }
        return result
    }
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw NSError(domain: "capture", code: 1) }
    let width = min(display.width, max(1, parameters["max_width"] as? Int ?? 1280))
    config.width = width
    config.height = max(1, Int((Double(display.height) * Double(width) / Double(display.width)).rounded()))
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: parameters["quality"] as? Double ?? 0.55]) else { throw NSError(domain: "capture", code: 2) }
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
    let frame = windowScreenBounds(pid: parameters["pid"] as? Int ?? 0)
    return ["path": output, "width": config.width, "height": config.height, "screenFrame": frame as Any, "frame": frame as Any]
}
let activityLock = NSLock()
var lastRequestAt = Date()
let idleIndex = CommandLine.arguments.firstIndex(of: "--idle-seconds")
let idleSeconds = idleIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? Double(CommandLine.arguments[$0 + 1]) : nil } ?? 900
let idleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    activityLock.lock(); let elapsed = Date().timeIntervalSince(lastRequestAt); activityLock.unlock()
    if elapsed >= max(1, idleSeconds) { exit(0) }
}
let socketIndex = CommandLine.arguments.firstIndex(of: "--socket")
let socketPath = socketIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? ""
if socketPath.isEmpty { exit(64) }
signal(SIGPIPE, SIG_IGN)
let server = socket(AF_UNIX, SOCK_STREAM, 0)
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let bytes = Array(socketPath.utf8CString)
if bytes.count > MemoryLayout.size(ofValue: address.sun_path) { exit(64) }
withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
unlink(socketPath)
let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
if bound != 0 || listen(server, 8) != 0 { exit(1) }
chmod(socketPath, 0o600)
print("ready"); fflush(stdout)
DispatchQueue.global().async {
    while true {
        let fd = accept(server, nil, nil)
        if fd < 0 { continue }
        DispatchQueue.global().async {
            var buffer = Data(); var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = Darwin.read(fd, &chunk, chunk.count)
                if count <= 0 { close(fd); return }
                buffer.append(contentsOf: chunk.prefix(count))
                if buffer.count > 1_048_576 { close(fd); return }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer.prefix(upTo: newline))
                    buffer.removeSubrange(...newline)
                    guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { close(fd); return }
                    activityLock.lock(); lastRequestAt = Date(); activityLock.unlock()
                    Task {
                        let id = request["id"] ?? NSNull()
                        do {
                            let cmd = request["cmd"] as? String ?? ""
                            let args = request["args"] as? [String: Any] ?? [:]
                            switch cmd {
                            case "ping":
                                reply(fd, ["id": id, "ok": true, "data": ["ok": true] as [String: Any]] as [String: Any])
                            case "shot_display":
                                reply(fd, ["id": id, "ok": true, "data": try await screenshot(args)])
                            case "grant":
                                // 必须由守护进程自己发起：系统弹窗授的是「调用进程」——
                                // 从 Electron 宿主发起就会把辅助功能授给宿主，而真正需要它的是
                                // 这个独立签名的 helper（Alma 的 grant 同样落在 helper 上）。
                                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                                let granted = AXIsProcessTrustedWithOptions(options)
                                reply(fd, ["id": id, "ok": true, "data": ["accessibility": granted ? "granted" : "denied", "prompted": !granted] as [String: Any]])
                            case "launch_app":
                                // 后台拉起：绝不 activate，不抢用户焦点（Alma 的 launch_app 同样保证这点）。
                                guard let bundle = args["bundle"] as? String else {
                                    throw NSError(domain: "app", code: 64, userInfo: [NSLocalizedDescriptionKey: "launch_app requires a bundle id"])
                                }
                                let wantsActivation = args["activates"] as? Bool ?? false
                                if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
                                    // 已经在跑也要尊重 --activates：调用方的意图是"它要在前面"，
                                    // 这个意图跟它是刚启动还是早就开着无关。（只是启动的话用 raise 更直接。）
                                    if wantsActivation { _ = activateViaAppleEvents(bundle) }
                                    reply(fd, ["id": id, "ok": true, "data": ["pid": Int(running.processIdentifier), "alreadyRunning": true, "activated": wantsActivation] as [String: Any]])
                                    return
                                }
                                let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)
                                guard let appURL = url else {
                                    throw NSError(domain: "app", code: 1, userInfo: [NSLocalizedDescriptionKey: "app_not_installed: \(bundle)"])
                                }
                                let config = NSWorkspace.OpenConfiguration()
                                // 默认**不**激活：绝不因为启动一个应用就把用户的前台窗口顶掉。
                                // 只有调用方明确给了 activates 才动焦点（Alma 的 --activates 同理）。
                                config.activates = args["activates"] as? Bool ?? false
                                let launched: NSRunningApplication? = await withCheckedContinuation { continuation in
                                    NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, _ in
                                        continuation.resume(returning: app)
                                    }
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["pid": Int(launched?.processIdentifier ?? 0), "alreadyRunning": false, "activated": config.activates] as [String: Any]])
                            case "doctor":
                                reply(fd, ["id": id, "ok": true, "data": [
                                    "accessibility": axTrusted() ? "granted" : "denied",
                                    "screenRecording": screenTrusted() ? "granted" : "denied",
                                    "version": driverVersion,
                                    "uptime": Int(Date().timeIntervalSince(startedAt)),
                                    // 守卫要靠读前台应用并把它切回来，没有辅助功能权限就武装不起来。
                                    "focusGuard": axTrusted() ? "armed" : "unavailable",
                                ] as [String: Any]])
                            case "list_apps":
                                var apps: [[String: Any]] = []
                                for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
                                    var entry: [String: Any] = [
                                        "pid": Int(app.processIdentifier),
                                        "name": app.localizedName ?? "",
                                        "running": true,
                                    ]
                                    // 没有 bundle id 的应用不要发空串：调用方按 min(1) 校验，
                                    // 一个空值会让整份列表解析失败，而不是只缺一个标识。
                                    if let bundle = app.bundleIdentifier, !bundle.isEmpty { entry["bundleId"] = bundle }
                                    apps.append(entry)
                                }
                                // 给了 pid 就是问「这个应用有哪些窗口」：ComputerObserve 要一个确切的
                                // window_id，此前没有任何命令能产出它，模型只能编一个。
                                if let onlyPid = args["pid"] as? Int {
                                    apps = apps.filter { ($0["pid"] as? Int) == onlyPid }
                                    for index in apps.indices {
                                        apps[index]["windows"] = windowsForApp(onlyPid)
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["apps": apps] as [String: Any]])
                                    return
                                }
                                // 再补上近 N 天用过但没在运行的 —— 模型靠它知道有什么可以 launch。
                                // 同一 bundleId 只出现一次：正在运行的那条优先（它带 pid，能直接操作）。
                                let seen = Set(apps.compactMap { $0["bundleId"] as? String })
                                let days = args["recent_days"] as? Int ?? 30
                                apps.append(contentsOf: recentlyUsedApplications(withinDays: days).filter {
                                    guard let bundle = $0["bundleId"] as? String else { return false }
                                    return !seen.contains(bundle)
                                })
                                reply(fd, ["id": id, "ok": true, "data": ["apps": apps] as [String: Any]])
                            case "raise":
                                // **显式**动词。硬规则是别的动作都不许把应用提到前台 ——
                                // 只有调用方明确要求「把它拿到前面来」时才动焦点。
                                let pid = try resolvePid(args)
                                let requested = args["window_id"] as? Int
                                var raised: [String: Any] = ["raised": Int(pid)]
                                // Apple Events 优先；拿不到 bundle id 或它失败时才退回本地激活。
                                let runningApp = NSRunningApplication(processIdentifier: pid)
                                let bundleId = args["bundle"] as? String ?? runningApp?.bundleIdentifier ?? ""
                                if let scriptError = activateViaAppleEvents(bundleId) {
                                    // 本地激活对后台进程无效（实测），所以如实说明为什么没提上来，
                                    // 并指出下一步 —— 别让调用方以为窗口已经到前面了。
                                    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
                                    raised["via"] = "local-activate"
                                    raised["warning"] = "apple_events_unavailable: 通过 Apple Events 请求激活失败（-\(scriptError)）。请在 系统设置 → 隐私与安全性 → 自动化 里允许 Biny Computer Use 控制该应用；本地激活对后台进程无效，窗口可能没被提到前面。"
                                } else {
                                    raised["via"] = "apple-events"
                                }
                                if let requested, let window = axWindow(pid: pid, matching: requested) {
                                    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                                    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                                    raised["window_id"] = requested
                                } else if let requested {
                                    raised["warning"] = "window_not_found: 没有编号为 \(requested) 的窗口，已只把应用提到前面。"
                                }
                                reply(fd, ["id": id, "ok": true, "data": raised] as [String: Any])
                            case "lens":
                                // 动作指示器的开关。不传 mode 就是 toggle（参照实现的 CLI 同样先读再翻）。
                                switch args["mode"] as? String ?? args["enabled"] as? String {
                                case "on", "true", "1": lensEnabled = true
                                case "off", "false", "0": lensEnabled = false
                                default: lensEnabled.toggle()
                                }
                                if !lensEnabled { DispatchQueue.main.async { lensOverlay.hide() } }
                                reply(fd, ["id": id, "ok": true, "data": ["enabled": lensEnabled] as [String: Any]])
                            case "status":
                                // 「helper 包 + 守护进程状态」：调用方最想先知道的两件事是
                                // 「包在不在」和「守护进程跑了多久、还剩多久自退」。
                                // 从可执行文件往上爬三级拿真包路径：
                                // .../computer-use.app/Contents/MacOS/computer-use
                                // Bundle.main.bundleURL 在经软链启动时会解析成目录，不能用。
                                let executable = ((Bundle.main.executableURL?.path ?? CommandLine.arguments.first ?? "") as NSString).resolvingSymlinksInPath
                                var helper = executable
                                for _ in 0..<3 { helper = (helper as NSString).deletingLastPathComponent }
                                // 不在 .app 里（裸二进制直跑）就用可执行文件自己，别报一个不存在的路径。
                                if !helper.hasSuffix(".app") { helper = executable }
                                reply(fd, ["id": id, "ok": true, "data": [
                                    "helper": helper,
                                    "helperPresent": FileManager.default.fileExists(atPath: helper),
                                    "version": driverVersion,
                                    "uptimeSeconds": Int(Date().timeIntervalSince(startedAt)),
                                    "idleSeconds": Int(idleSeconds),
                                    "socket": socketPath,
                                    "accessibility": axTrusted(),
                                    "screenRecording": CGPreflightScreenCaptureAccess(),
                                ] as [String: Any]])
                            case "shutdown":
                                reply(fd, ["id": id, "ok": true, "data": ["stopping": true] as [String: Any]])
                                // 回执要先出去再退，否则调用方只看到连接被断开，分不清是
                                // 「按我说的停了」还是「它自己崩了」。
                                DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
                                    unlink(socketPath)
                                    exit(0)
                                }
                            case "capture_screen":
                                // 纯截图，不碰 AX：PiP 面板的帧源走这条，避免被卡住的
                                // 无障碍调用牵连（目标窗口也可能根本不能被单独捕获）。
                                var shotArgs: [String: Any] = ["out": args["out"] ?? "/tmp/biny-cu-screen-\(Int(Date().timeIntervalSince1970 * 1000)).jpg"]
                                if let maxWidth = args["max_width"] { shotArgs["max_width"] = maxWidth }
                                let shot = await withDeadline(5.0, fallback: [:]) { (try? await screenshot(shotArgs)) ?? [:] }
                                reply(fd, ["id": id, "ok": true, "data": shot])
                            case "get_app_state":
                                guard axTrusted() else { throw NSError(domain: "ax", code: 1, userInfo: [NSLocalizedDescriptionKey: "ax_not_granted"]) }
                                let pid = try resolvePid(args)
                                let maxDepth = args["max_depth"] as? Int ?? 20
                                let limit = args["max_elements"] as? Int ?? 300
                                // AX 是跨进程 IPC，卡住的调用无法取消：放到自己的工作线程，
                                // 4 秒内没结果就放弃 AX（截图仍然返回，观察降级而不是挂死）。
                                let collected: ([[String: Any]], [String: AXUIElement]) = await withCheckedContinuation { continuation in
                                    DispatchQueue.global(qos: .userInitiated).async {
                                        continuation.resume(returning: collectAccessibility(pid: pid, maxDepth: maxDepth, limit: limit, timeout: 4.0))
                                    }
                                }
                                let elements = collected.0
                                let table = collected.1
                                // no_shot：只读无障碍树。截图要过一次 ScreenCaptureKit，
                                // 纯读结构时那是白付的等待（Alma 的 --no-shot 同样为此）。
                                let skipShot = args["no_shot"] as? Bool ?? false
                                var shotArgs: [String: Any] = ["out": args["out"] ?? "/tmp/biny-cu-state-\(Int(Date().timeIntervalSince1970 * 1000)).jpg", "pid": Int(pid)]
                                if let maxWidth = args["max_width"] { shotArgs["max_width"] = maxWidth }
                                // window_id 必须转下去 —— 之前在这里被吞掉，于是调用方指定的窗口
                                // 从来没影响过截图，模型挑的窗口是装饰品。
                                if let windowId = args["window_id"] { shotArgs["window_id"] = windowId }
                                // 截图同样可能挂在无响应的窗口上：限时 3 秒，超时就返回不带图的观察。
                                // 同理：TaskGroup 的 cancel 不会中断已在跑的 capture，
                                // group.next() 仍会等它返回。放进独立线程 + 轮询才有真上限。
                                let shot = skipShot ? [:] : await withDeadline(3.0, fallback: [:]) { (try? await screenshot(shotArgs)) ?? [:] }
                                refTables[pid] = table
                                // 记下截图坐标 → 屏幕坐标的映射，后续像素点击据此换算。
                                if let f = shot["screenFrame"] as? [String: Double],
                                   let sw = shot["width"] as? Int, let sh = shot["height"] as? Int, sw > 0, sh > 0 {
                                    coordMaps[pid] = (Double(sw) / max(1, f["w"] ?? 1), f["x"] ?? 0, f["y"] ?? 0, Double(sw), Double(sh))
                                }
                                var data: [String: Any] = ["pid": Int(pid), "elements": elements]
                                if let path = shot["path"] { data["screenshot"] = path }
                                data["screenshotWidth"] = shot["width"] ?? 0
                                data["screenshotHeight"] = shot["height"] ?? 0
                                // 上报**真实**窗口号：以前这里是 Int(pid)，于是 windowId 一路都是假的。
                                data["windowId"] = (shot["windowId"] as? Int) ?? windowNumberForApp(Int(pid)) ?? Int(pid)
                                if let frame = shot["frame"] { data["windowFrame"] = frame }
                                if let screenFrame = shot["screenFrame"] { data["screenFrame"] = screenFrame }
                                reply(fd, ["id": id, "ok": true, "data": data as [String: Any]])
                            case "click":
                                guard axTrusted() else { throw NSError(domain: "ax", code: 1, userInfo: [NSLocalizedDescriptionKey: "ax_not_granted"]) }
                                if let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let element = refTables[pid_t(pid)]?[ref] {
                                    // 两条路由是两种机制，不是同一件事的两种写法：
                                    // AX 让控件执行它自己的动作（不碰坐标，最可靠）；
                                    // 物理点击合成鼠标事件（能表达双击和右键，但依赖坐标与前台）。
                                    // strategy 让调用方指定用哪条 —— auto 仍按可用性挑。
                                    let strategy = args["strategy"] as? String ?? "auto"
                                    let refButton = mouseButton(args["button"] as? String)
                                    let refClicks = max(1, min(3, args["clicks"] as? Int ?? 1))
                                    let axCannotExpress = refClicks > 1 || refButton != .left

                                    func physicalAtElement() async -> Bool {
                                        guard let frame = axFrame(element) else { return false }
                                        let point = CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2)
                                        noteActionPoint(args, point, symbol: nil)
                                        await withFocusGuard(pid_t(pid)) {
                                            postClick(pid_t(pid), point, button: refButton, clicks: refClicks)
                                        }
                                        return true
                                    }

                                    if strategy == "ax" && axCannotExpress {
                                        throw NSError(domain: "click", code: 65, userInfo: [NSLocalizedDescriptionKey: "ax_cannot_express_this_click: AX 只有单次左键动作，双击或其它按键请用 strategy=physical"])
                                    }
                                    if strategy == "physical" || (strategy == "auto" && axCannotExpress) {
                                        guard await physicalAtElement() else {
                                            throw NSError(domain: "click", code: 66, userInfo: [NSLocalizedDescriptionKey: "element_has_no_frame: 元素没有坐标，做不了物理点击"])
                                        }
                                        reply(fd, ["id": id, "ok": true, "data": ["clicked": ref, "route": "physical", "clicks": refClicks] as [String: Any]] as [String: Any])
                                    } else if strategy == "ax" {
                                        let attempts: [String] = [kAXPressAction as String, kAXPickAction as String, kAXConfirmAction as String]
                                        let status: AXError = attempts.reduce(.failure) { acc, action in
                                            acc == .success ? acc : AXUIElementPerformAction(element, action as CFString)
                                        }
                                        if let frame = axFrame(element) {
                                            noteActionPoint(args, CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2), symbol: nil)
                                        }
                                        guard status == .success else {
                                            throw NSError(domain: "click", code: 67, userInfo: [NSLocalizedDescriptionKey: "element_action_unsupported: 这个控件不响应任何 AX 点击动作，改用 strategy=physical 或 auto"])
                                        }
                                        reply(fd, ["id": id, "ok": true, "data": ["clicked": ref, "route": "ax"] as [String: Any]] as [String: Any])
                                    } else {
                                        // auto：先 AX，控件不认才退物理；回执要说清**实际走了哪条**。
                                        let attempts: [String] = [kAXPressAction as String, kAXPickAction as String, kAXConfirmAction as String]
                                        let status: AXError = attempts.reduce(.failure) { acc, action in
                                            acc == .success ? acc : AXUIElementPerformAction(element, action as CFString)
                                        }
                                        let route = status == .success ? "ax" : (await physicalAtElement() ? "physical" : "none")
                                        reply(fd, ["id": id, "ok": true, "data": ["clicked": ref, "route": route] as [String: Any]] as [String: Any])
                                    }
                                } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
                                    // 给了坐标就只能是物理点击：AX 是按元素动作的，坐标对它没有意义。
                                    // 早点说清楚，别让调用方以为指定了 strategy=ax 就会走 AX。
                                    if (args["strategy"] as? String) == "ax" {
                                        throw NSError(domain: "click", code: 65, userInfo: [NSLocalizedDescriptionKey: "strategy_ax_needs_ref: 传了坐标就只能合成鼠标事件；要 AX 点击请用 ref"])
                                    }
                                    let pid = try resolvePid(args)
                                    // 像素坐标为截图坐标：按最近一次快照的映射换算回屏幕点。
                                    let point = screenPoint(pid, x, y, screenSpace: args["coord_space"] as? String == "screen")
                                    let pixelButton = mouseButton(args["button"] as? String)
                                    let pixelClicks = max(1, min(3, args["clicks"] as? Int ?? 1))
                                    noteActionPoint(args, point, symbol: nil)
                                    await withFocusGuard(pid) {
                                        postClick(pid, point, button: pixelButton, clicks: pixelClicks)
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["clicked": "@\(Int(x)),\(Int(y))", "clicks": pixelClicks] as [String: Any]] as [String: Any])
                                } else { throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey: "ref_stale"]) }
                            case "drag":
                                // AX 没有拖这个动作，只能合成鼠标序列。
                                guard let x1 = args["x1"] as? Double, let y1 = args["y1"] as? Double,
                                      let x2 = args["x2"] as? Double, let y2 = args["y2"] as? Double else {
                                    throw NSError(domain: "drag", code: 64, userInfo: [NSLocalizedDescriptionKey: "drag requires x1,y1,x2,y2"])
                                }
                                let pid = try resolvePid(args)
                                let screenSpace = args["coord_space"] as? String == "screen"
                                let from = screenPoint(pid, x1, y1, screenSpace: screenSpace)
                                let to = screenPoint(pid, x2, y2, screenSpace: screenSpace)
                                await withFocusGuard(pid) { postDrag(pid, from: from, to: to) }
                                reply(fd, ["id": id, "ok": true, "data": ["dragged": "@\(Int(x1)),\(Int(y1))→@\(Int(x2)),\(Int(y2))"] as [String: Any]] as [String: Any])
                            case "perform_secondary_action":
                                // 右键 / 打开上下文菜单：优先走 AX 的 ShowMenu，退化成合成右键。
                                let pid = try resolvePid(args)
                                if let ref = args["ref"] as? String, let element = refTables[pid]?[ref] {
                                    let status = AXUIElementPerformAction(element, kAXShowMenuAction as CFString)
                                    if status != .success, let frame = axFrame(element) {
                                        let point = CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2)
                                        await withFocusGuard(pid) {
                                            postMouse(pid, .rightMouseDown, point, .right, global: true); postMouse(pid, .rightMouseUp, point, .right, global: true)
                                        }
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["menu": ref] as [String: Any]] as [String: Any])
                                } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
                                    let point = screenPoint(pid, x, y, screenSpace: args["coord_space"] as? String == "screen")
                                    await withFocusGuard(pid) {
                                        postMouse(pid, .rightMouseDown, point, .right, global: true); postMouse(pid, .rightMouseUp, point, .right, global: true)
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["menu": "@\(Int(x)),\(Int(y))"] as [String: Any]] as [String: Any])
                                } else { throw NSError(domain: "menu", code: 64, userInfo: [NSLocalizedDescriptionKey: "ref_stale"]) }
                            case "type":
                                // 元素级文本写入：直接改控件的 AXValue。
                                //
                                // 这是**唯一**一条不需要键盘焦点的输入路径 —— 自绘输入框
                                // （网易云那类）收不到合成按键，但控件自己的 AXValue 是可写的。
                                // 注意它走的是「替换/追加」语义，不是「在光标处插入」。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let text = args["text"] as? String else {
                                    // 四条合并成一句「requires ref and value」会让调用方无从下手：
                                    // 是没传、还是 ref 属于上一次观察、还是这个控件不可写？
                                    // 分开报，才不至于让人对着同一句话猜。
                                    throw NSError(domain: "type", code: 64, userInfo: [NSLocalizedDescriptionKey: "type_missing_argument: 需要 ref、pid 和 text"])
                                }
                                guard let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "type", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                }
                                let append = args["append"] as? Bool ?? false
                                let current = axCopy(element, kAXValueAttribute as String) as? String ?? ""
                                let next = append ? current + text : text
                                let typeStatus = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, next as CFTypeRef)
                                guard typeStatus == .success else {
                                    throw NSError(domain: "type", code: 65, userInfo: [NSLocalizedDescriptionKey: "element_value_not_writable: 这个控件不接受直接写入，改用 type_text 并先让它取得焦点"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["typed": next.count, "appended": append, "route": "ax"] as [String: Any]])
                            case "press":
                                // 在元素上触发 AX 动作 —— 同样不需要焦点。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let key = args["key"] as? String else {
                                    // 四条合并成一句「requires ref and value」会让调用方无从下手：
                                    // 是没传、还是 ref 属于上一次观察、还是这个控件不可写？
                                    // 分开报，才不至于让人对着同一句话猜。
                                    throw NSError(domain: "press", code: 64, userInfo: [NSLocalizedDescriptionKey: "press_missing_argument: 需要 ref、pid 和 key"])
                                }
                                guard let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "press", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                }
                                let actions: [String: String] = [
                                    "Enter": kAXConfirmAction as String,
                                    "Escape": kAXCancelAction as String,
                                    "Space": kAXPressAction as String,
                                    "Increment": kAXIncrementAction as String,
                                    "Decrement": kAXDecrementAction as String,
                                    "ShowMenu": kAXShowMenuAction as String,
                                ]
                                guard let action = actions[key] else {
                                    throw NSError(domain: "press", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown_press_key: 只支持 \(actions.keys.sorted().joined(separator: "/"))"])
                                }
                                let pressStatus = AXUIElementPerformAction(element, action as CFString)
                                guard pressStatus == .success else {
                                    throw NSError(domain: "press", code: 66, userInfo: [NSLocalizedDescriptionKey: "element_action_unsupported: 这个控件不接受 \(key)"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["pressed": key, "action": action, "route": "ax"] as [String: Any]])
                            case "set_value":
                                // 直接写 AXValue：滑杆、步进器、输入框都能一步到位，不用模拟按键。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int,
                                      let element = refTables[pid_t(pid)]?[ref], let value = args["value"] else {
                                    throw NSError(domain: "value", code: 64, userInfo: [NSLocalizedDescriptionKey: "set_value requires ref and value"])
                                }
                                let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
                                guard status == .success else {
                                    throw NSError(domain: "value", code: 1, userInfo: [NSLocalizedDescriptionKey: "set_value_failed"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["ref": ref, "value": "\(value)"] as [String: Any]] as [String: Any])
                            case "select_text":
                                // 选中一段文字，或在没有 text 时把光标放到 range 起点。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int,
                                      let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: "ref_stale"])
                                }
                                if let text = args["text"] as? String {
                                    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
                                    guard status == .success else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "select_text_failed"])
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["selected": text] as [String: Any]] as [String: Any])
                                } else if let location = args["location"] as? Int {
                                    let length = args["length"] as? Int ?? 0
                                    var range = CFRange(location: location, length: length)
                                    guard let axRange = AXValueCreate(.cfRange, &range) else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "select_range_failed"])
                                    }
                                    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
                                    guard status == .success else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "select_range_failed"])
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["cursor": location] as [String: Any]] as [String: Any])
                                } else {
                                    throw NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: "select_text requires text or location"])
                                }
                            case "type_text":
                                let pid = try resolvePid(args)
                                let text = args["text"] as? String ?? ""
                                await withFocusGuard(pid) { postUnicode(pid, text) }
                                noteActionPoint(args, nil, symbol: "keyboard")
                                var typed: [String: Any] = ["typed": text.count]
                                if let warning = keyDeliveryWarning(pid) { typed["warning"] = warning }
                                if let guardWarning = focusGuardWarning() { typed["focusGuardWarning"] = guardWarning }
                                reply(fd, ["id": id, "ok": true, "data": typed])
                            case "press_key":
                                let pid = try resolvePid(args)
                                let combo = args["key"] as? String ?? ""
                                guard let (keyCode, flags) = parseKeyCombo(combo) else { throw NSError(domain: "key", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown_key"]) }
                                await withFocusGuard(pid) { postKey(pid, keyCode: keyCode, flags: flags) }
                                var pressed: [String: Any] = ["pressed": combo]
                                if let warning = keyDeliveryWarning(pid) { pressed["warning"] = warning }
                                reply(fd, ["id": id, "ok": true, "data": pressed])
                            case "scroll":
                                let pid = try resolvePid(args)
                                let direction = args["direction"] as? String ?? "down"
                                let amount = args["amount"] as? Int ?? 3
                                let route = args["route"] as? String ?? "auto"
                                // 滚轮要的是自然滚动转换后的方向；AX 写滚动条位置，用语义方向。
                                let wheelDirection = args["wheel_direction"] as? String ?? direction
                                // 先试 AX —— 原生滚动区只有这一条路能走通；不行再退回滚轮，
                                // 那才是网页内容（不暴露 AXScrollBar）唯一可用的路由。
                                // pages 是语义单位（参照实现用 --pages），amount 是滚轮的行数。
                                // 显式取两种数值类型：JSON 里的 1 既可能是 Int 也可能是 Double。
                                let pagesArg = (args["pages"] as? Double) ?? (args["pages"] as? Int).map(Double.init)
                                var data = route == "wheel" ? nil : await withFocusGuard(pid) { axScroll(pid, direction: direction, notches: amount, pages: pagesArg) }
                                if data == nil && route != "ax" {
                                    await withFocusGuard(pid) {
                                        // 滚轮只认行数。给了 pages 就换算 —— 但**网页内容量不出页有多大**
                                        // （内容高度不暴露），所以这是估算，回执里如实标出来。
                                        let notches = pagesArg.map { max(1, Int(($0 * linesPerPage).rounded())) } ?? amount
                                        let (wheelAxis, wheelSign): (CGScrollEventUnit, Int32) = {
                                            switch wheelDirection {
                                            case "up": return (.line, Int32(notches))
                                            case "down": return (.line, Int32(-notches))
                                            case "left": return (.line, Int32(notches))
                                            default: return (.line, Int32(-notches))
                                            }
                                        }()
                                        if let event = CGEvent(scrollWheelEvent2Source: nil, units: CGScrollEventUnit(rawValue: wheelAxis.rawValue)!, wheelCount: 1, wheel1: (wheelDirection == "up" || wheelDirection == "down") ? wheelSign : 0, wheel2: (wheelDirection == "left" || wheelDirection == "right") ? wheelSign : 0, wheel3: 0) {
                                            event.postToPid(pid)
                                        }
                                    }
                                    data = ["scrolled": direction, "route": "wheel", "unit": pagesArg == nil ? "notches" : "pages(estimated as \(max(1, Int(((pagesArg ?? 1) * linesPerPage).rounded()))) notches)"]
                                }
                                if var result = data {
                                    // 滚动没有单一落点：用目标窗口的中心，用户能看出"它在滚哪儿"。
                                    if let frame = windowScreenBounds(pid: Int(pid)) {
                                        noteActionPoint(args, CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2), symbol: "arrow.up.arrow.down")
                                    }
                                    if let guardWarning = focusGuardWarning() { result["guardWarning"] = guardWarning }
                                    reply(fd, ["id": id, "ok": true, "data": result] as [String: Any])
                                } else {
                                    reply(fd, ["id": id, "ok": false, "error": ["code": "scroll_route_unavailable", "message": "这个滚动区既不暴露 AXScrollBar，也不接受滚轮事件。"] as [String: Any]] as [String: Any])
                                }
                            default:
                                throw NSError(domain: "method", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown_cmd"])
                            }
                        } catch let error as NSError {
                            reply(fd, ["id": id, "ok": false, "error": ["code": error.userInfo[NSLocalizedDescriptionKey] as? String ?? "action_failed", "message": error.localizedDescription]])
                        }
                    }
                }
            }
        }
    }
}
// 让 AppKit 就位：daemon 是 LSUIElement 的 .app，平时只跑 runloop 不碰 UI。
// 但 lens 指示器要开窗口，没初始化过 NSApplication 的话窗口排不到前面。
// setActivationPolicy(.accessory) 保证它不进 Dock、也不抢别的前台。
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
NSApp.finishLaunching()
RunLoop.main.run()
