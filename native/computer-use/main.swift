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
// MARK: - Appshot：全局热键抓当前应用

/// 参照的 appshot 是一条**面向用户**的通路：设置里有 `appshots.hotkey`，
/// 按下就把**当前前台应用**（排除自己）抓下来，还带快门声（`[appshot-sound]`）。
/// daemon 侧的动词是 `appshot_monitor_start/stop` · `appshot_frontmost` · `appshot_capture`。
///
/// 它需要的是**会话级**事件 tap —— 这个在本构建里实测**可用**
/// （`doctor` 的 `focusTap: session-only`：会话级能建，按 pid 的不能）。
///
/// 热键写法：修饰键用 `+` 连接，例如 `Ctrl+Alt+C`、`Ctrl+Shift+Space`；
/// 也接受单按修饰键两次（`double-cmd` / `double-alt`），对应参照的 `BareModifierMonitor`
/// 与 `doubleTapWindow`。**参照的确切格式没完全还原出来**，这里是一套合理的子集。
let hotkeyKeyCodes: [String: CGKeyCode] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
    "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
    "RETURN": 36, "SPACE": 49, "TAB": 48, "ESCAPE": 53,
    "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
]

struct HotkeySpec {
    let flags: CGEventFlags
    let keyCode: CGKeyCode?              // nil = 单按修饰键两次
    let bareModifier: CGEventFlags?      // double-cmd 之类
}

func parseHotkey(_ raw: String) -> HotkeySpec? {
    let text = raw.trimmingCharacters(in: .whitespaces)
    if text.lowercased().hasPrefix("double-") {
        let name = String(text.dropFirst(7)).lowercased()
        let map: [String: CGEventFlags] = ["cmd": .maskCommand, "command": .maskCommand,
                                           "alt": .maskAlternate, "option": .maskAlternate,
                                           "ctrl": .maskControl, "control": .maskControl,
                                           "shift": .maskShift]
        guard let flag = map[name] else { return nil }
        return HotkeySpec(flags: [], keyCode: nil, bareModifier: flag)
    }
    var flags: CGEventFlags = []
    var key: String?
    for raw in text.split(separator: "+") {
        let part = raw.trimmingCharacters(in: .whitespaces).uppercased()
        switch part {
        case "CMD", "COMMAND": flags.insert(.maskCommand)
        case "CTRL", "CONTROL": flags.insert(.maskControl)
        case "ALT", "OPTION": flags.insert(.maskAlternate)
        case "SHIFT": flags.insert(.maskShift)
        default: key = part
        }
    }
    guard let key, let code = hotkeyKeyCodes[key] else { return nil }
    return HotkeySpec(flags: flags, keyCode: code, bareModifier: nil)
}

@MainActor final class AppshotMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private(set) var hotkey: String = ""
    private(set) var lastCapturePath: String?
    private var modifierTaps = ModifierDoubleTap()
    /// 诊断：tap 有没有真的在收事件、有没有被系统掐掉。
    /// 「装了热键但按了没反应」有两种完全不同的原因 —— tap 没收到，还是收到了没匹配上。
    private(set) var eventsSeen = 0
    private(set) var disableCount = 0
    private(set) var recoveredCount = 0
    private(set) var captureError: String?
    private var capturing = false
    var subscriber: Int32?
    var captureOptions: [String: Any] = [:]
    private var monitorEpoch = 0
    let outputDir: String

    init() {
        let base = NSTemporaryDirectory() + "biny-appshots"
        try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
        chmod(base, 0o700)
        outputDir = base
    }

    var isArmed: Bool { tap != nil }
    /// tap 建好≠在工作：可能没 enable，也可能 source 没真挂上 runloop。
    var isLive: Bool {
        guard let tap, let source else { return false }
        return CGEvent.tapIsEnabled(tap: tap) && CFRunLoopContainsSource(CFRunLoopGetMain(), source, .commonModes)
    }

    func arm(_ spec: HotkeySpec, raw: String) -> Bool {
        disarm()
        hotkey = raw
        // 只关心按键按下与修饰键变化：热键不需要看别的，mask 越小 tap 越不容易被系统掐。
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
                 | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
        // 监听全局键盘事件，不吞掉用户输入；失败由设置页显示权限反馈。
        guard let tap = CGEvent.tapCreate(
            tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<AppshotMonitor>.fromOpaque(refcon).takeUnretainedValue()
                monitor.handle(type: type, event: event)
                return Unmanaged.passUnretained(event)   // 只监听，不改写用户的输入
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    func disarm() {
        monitorEpoch += 1; subscriber = nil; captureOptions = [:]
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil; source = nil; modifierTaps = ModifierDoubleTap()
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        eventsSeen += 1
        // 系统会因为回调太慢把 tap 掐掉；参照同样会记这条。重新武装，别静默失效。
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            disableCount += 1
            if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
                if CGEvent.tapIsEnabled(tap: tap) { recoveredCount += 1 }
            }
            return
        }
        guard let spec = parseHotkey(hotkey) else { return }
        if let bare = spec.bareModifier {
            let modifiers: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
            let flags = event.flags.intersection(modifiers)
            if modifierTaps.update(pressed: flags == bare, interrupted: type == .keyDown || !flags.isSubset(of: bare), now: Date().timeIntervalSince1970) { fire() }
            return
        }
        guard type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == Int64(spec.keyCode ?? 0) else { return }
        // 修饰键要**恰好**匹配：少了不触发，多了也不触发（否则 Cmd+C 会误触 Cmd+Shift+C）。
        let relevant: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
        guard event.flags.intersection(relevant) == spec.flags else { return }
        fire()
    }

    /// 触发一次抓取。回调里不能做慢活（tap 会被系统掐），所以派到别的队列。
    private func fire() {
        let id = UUID().uuidString, epoch = monitorEpoch, destination = subscriber, options = captureOptions
        if let destination { reply(destination, ["event": "appshot", "data": ["type": "starting", "id": id]]) }
        Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await self.captureFrontmost(options)
                if epoch != self.monitorEpoch { if let file = data["path"] as? String { try? FileManager.default.removeItem(atPath: file) }; return }
                if let destination { reply(destination, ["event": "appshot", "data": ["type": "captured", "id": id, "data": data]]) }
            } catch {
                self.captureError = error.localizedDescription
                if epoch == self.monitorEpoch, let destination { reply(destination, ["event": "appshot", "data": ["type": "failed", "id": id, "error": error.localizedDescription]]) }
            }
        }
    }

    func captureFrontmost(_ args: [String: Any]) async throws -> [String: Any] {
        guard !capturing else { throw NSError(domain: "appshot", code: 69, userInfo: [NSLocalizedDescriptionKey: "appshot_capture_busy"]) }
        capturing = true; defer { capturing = false }
        if args["wait_frontmost"] as? Bool == true {
            let deadline = Date().addingTimeInterval(1.2), excluded = args["exclude_bundles"] as? [String] ?? []
            while excluded.contains(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "") && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        }
        // 抓「当前前台应用」，但排除自己 —— 参照的 appshot_frontmost 就是带 exclude_bundle_id 的。
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != getpid(), let bundle = front.bundleIdentifier else {
            throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_frontmost_unavailable"])
        }
        if let expected = args["expected_bundle"] as? String, expected != bundle {
            throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_frontmost_changed"])
        }
        if (args["exclude_bundles"] as? [String] ?? []).contains(bundle) {
            throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_application_excluded"])
        }
        let pid = front.processIdentifier
        guard let window = windowNumberForApp(Int(pid)) else {
            throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_no_window"])
        }
        let out = outputDir + "/appshot-\(UUID().uuidString).jpg"
        var result = await captureObservation(timeout: 3, describeError: { $0.localizedDescription }) {
            try await screenshot(["out": out, "pid": Int(pid), "window_id": window, "max_width": args["max_width"] ?? 1280])
        }
        guard result["path"] != nil else { throw NSError(domain: "appshot", code: 70, userInfo: [NSLocalizedDescriptionKey: result["screenshot_error"] as? String ?? "appshot_capture_failed"]) }
        result["windowId"] = window
        result["appName"] = front.localizedName ?? bundle
        if args["include_ax"] as? Bool == true {
            if axTrusted() {
                let tree = await withCheckedContinuation { continuation in
                    DispatchQueue.global(qos: .userInitiated).async {
                        continuation.resume(returning: collectAccessibility(pid: pid, maxDepth: 6, limit: 200, timeout: 3, interactiveOnly: false, windowId: window).0)
                    }
                }
                let text = String(data: (try? JSONSerialization.data(withJSONObject: tree)) ?? Data(), encoding: .utf8) ?? ""
                result["axText"] = String(text.prefix(24000))
            } else { result["axError"] = "accessibility_not_granted" }
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, windowNumberForApp(Int(pid)) == window else {
            try? FileManager.default.removeItem(atPath: out)
            throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_frontmost_changed"])
        }
        chmod(out, 0o600)
        if let previous = lastCapturePath, previous != out { try? FileManager.default.removeItem(atPath: previous) }
        lastCapturePath = out; captureError = nil
        return result.merging(["bundleId": bundle, "pid": Int(pid)]) { _, new in new }
    }
}

let appshotMonitor = MainActor.assumeIsolated { AppshotMonitor() }

// MARK: - 原生意图（Layer 1 app-command dispatch）

/// 对认识的应用**不驱动 UI**，直接把已知意图派给应用。
///
/// 参照管这叫 "Layer 1 app-command dispatch"，走的是 URL scheme + `NSWorkspace.open`，
/// 因此**不模拟点击、不动前台**（"Open NetEase Music without changing frontmost app"）。
/// URL 模板直接取自它的 helper 二进制：
///
///   " this is the raw `orpheus://route/<name>` bridge."
///   orpheus://song/?id=  ·  orpheus://playlist/?id=
///   orpheus://route/dailyRecommend  ·  orpheus://route/historyRecommend
///
/// 对自绘控件的应用（网易云就是）这条比模拟输入更可靠 —— 它的搜索框收不到合成按键，
/// 但 orpheus:// 路由它认。所以能派意图就别去点界面。
let nativeIntents: [String: (bundle: String, url: (String?) -> String?)] = [
    "play_song":                  ("com.netease.163music", { id in id.map { "orpheus://song/?id=\($0)" } }),
    "play_playlist":              ("com.netease.163music", { id in id.map { "orpheus://playlist/?id=\($0)" } }),
    // 具名路由只是壳，参照底下还有一条**通用派发**（"the raw `orpheus://route/<name>` bridge"）；
    // 具名那两个就是它的特例。留出这条路，新路由不必等我们发版。
    "netease_route":              ("com.netease.163music", { name in name.map { "orpheus://route/\($0)" } }),
    "play_daily_recommendation":  ("com.netease.163music", { _ in "orpheus://route/dailyRecommend" }),
    "open_history_recommend":     ("com.netease.163music", { _ in "orpheus://route/historyRecommend" }),
    // Apple Music / Spotify：参照同样是 URL scheme，不是驱动 UI。
    "open_music_url":             ("com.apple.Music", { url in url }),
    "play_spotify_uri":           ("com.spotify.client", { uri in uri }),
    // 邮件：参照的描述是"All params optional: to, subject, body, cc, bcc" → 走 mailto:（RFC 6068）。
    "compose_mail":               ("com.apple.mail", { mailto in mailto }),
]

/// 参照在错误里把可用的网易云路由列全了（`dailyRecommend` … `login`）—— 照抄这份表。
let knownNeteaseRoutes = ["dailyRecommend", "historyRecommend", "historyPlaylist", "styleRecommend",
                          "similarArtist", "ranking", "playlist", "album", "artist", "albumlist",
                          "musicDesktop", "localMusic", "login"]

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
/// 上一次动作用的是哪种指示器结局：shown / suppressed / disabled / none。
var lastIndicatorOutcome = "none"
/// 上一次观察的元素树指纹（按 pid:window 存），用于 `elements_are_diff`。
///
/// 参照在观察回执里报两个字段：`elements_are_diff`（与上次相比变没变）和
/// `unchanged_element_count`（没变的元素数）。这对调用方是**语义信息**——
/// "什么都没变"意味着不必重读一整棵树，也不必把上次的 ref 当过期。
var lastElementFingerprints: [String: [String]] = [:]

/// 参照的观察回执里有 `observed_activations`：护栏**察觉到多少次"被激活"**。
/// 只有把这件事记下来，"绝不抢焦点"才是可核查的 —— 否则它只是一个意图。
var observedActivations = 0
/// 最近一次护栏做了什么（供回执说明）。
var focusGuardNote: String?

/// 目标应用**聚焦元素**的指纹（pid → 描述）。
///
/// 参照护栏的判据从这里能读出来（它自己的三句话）：
/// ```
/// the app reported no focused element to compare
/// the focused element exposes no readable text
/// the focused element stopped exposing readable text
/// ```
/// —— 它比对的是**聚焦元素**，不是前台应用。这个差别是实的：
/// **同一个应用内换了 key window / 换了焦点元素，只看前台应用是看不见的。**
func focusedElementFingerprint(_ app: AXUIElement) -> String? {
    guard let focusedRef = axCopy(app, kAXFocusedUIElementAttribute as String) else { return nil }
    let focused = unsafeBitCast(focusedRef, to: AXUIElement.self)
    let role = axString(focused, kAXRoleAttribute as String) ?? "?"
    let title = axString(focused, kAXTitleAttribute as String) ?? ""
    let value = (axCopy(focused, kAXValueAttribute as String) as? String).map { String($0.prefix(40)) } ?? ""
    return "\(role)|\(title)|\(value)"
}

/// 元素的一条规范化描述：参与"变没变"的比较。
/// 只收**会影响调用方判断**的字段（角色/标题/值/几何），不收 ref ——
/// ref 每次都重新编，收进去会让"没变"永远判成"变了"。
func elementFingerprint(_ element: [String: Any]) -> String {
    let role = element["role"] as? String ?? ""
    let title = element["title"] as? String ?? ""
    let value = String(describing: element["value"] ?? "")
    var frame = ""
    if let f = element["frame"] as? [String: Double] {
        frame = "\(Int(f["x"] ?? 0)),\(Int(f["y"] ?? 0)),\(Int(f["w"] ?? 0)),\(Int(f["h"] ?? 0))"
    }
    return "\(role)|\(title)|\(value)|\(frame)"
}

/// 最近一次观察过的 pid：只给 ref、不给 pid 的调用靠它定目标。
var lastObservedPid: pid_t?
var lastActionPoint: CGPoint?

/// 记一次动作落点。
///
/// 命令处理跑在全局队列线程上，而 AppKit 只能主线程碰 —— 必须派过去。
/// `show_cursor=false` 表示这一次不要指示器（`--no-cursor`）。
func noteActionPoint(_ args: [String: Any], _ point: CGPoint?, symbol: String?) {
    // 让"这一次显示了没有"变成**可读的量**：否则 `--no-cursor` 只能靠肉眼验，
    // 而肉眼验不了 —— 指示器是全屏透明的，看不见不等于没显示。
    lastIndicatorOutcome = !lensEnabled ? "disabled" : ((args["show_cursor"] as? Bool ?? true) ? "shown" : "suppressed")
    guard lensEnabled, args["show_cursor"] as? Bool ?? true else { return }
    // 打字这类动作没有坐标：沿用上一次落点，用户仍能看到「它正在这里输入」。
    let target = point ?? lastActionPoint
    guard let target else { return }
    lastActionPoint = target
    DispatchQueue.main.async { lensOverlay.show(at: target, symbol: symbol) }
}

/// 这一次动作的落点：给了像素就用像素，给了元素就用元素框中心，都没有就返回 nil
/// （nil 表示"沿用上一次落点" —— 打字这类动作本来就没有自己的坐标）。
func actionPoint(_ args: [String: Any], element: AXUIElement?) -> CGPoint? {
    if let x = args["x"] as? Double, let y = args["y"] as? Double { return CGPoint(x: x, y: y) }
    if let element, let frame = axFrame(element) {
        return CGPoint(x: frame["x"]! + frame["w"]! / 2, y: frame["y"]! + frame["h"]! / 2)
    }
    return nil
}

/// 能不能为某个 pid 建立事件 tap。
///
/// 参照的第一层（`FocusStealPreventer`）建在这上面，失败姿态是 FATAL。本实现没有那一层，
/// 但**至少要知道这个 API 在真实权限下是否可用** —— 否则「机制不明」里会混着
/// 「其实根本建不起来」，那是两个完全不同的结论。
///
/// 用**自身 pid** 试，不碰任何目标应用；建起来立刻失效掉，不留下常驻 tap。
/// 探三次：**这个探针本身会飘** —— 同一台机器上前后两次可以一次 per-pid、一次 session-only。
/// 只报一次结果是误导：调用方会以为那是稳定属性。所以报**模式**而不是单次值。
func canArmEventTap() -> String {
    var perPidHits = 0, sessionHits = 0
    for _ in 0..<3 {
        let r = tryArmEventTapOnce()
        if r == "per-pid" { perPidHits += 1 }
        if r != "none" { sessionHits += 1 }
    }
    if perPidHits == 3 { return "per-pid" }
    if perPidHits == 0 && sessionHits == 3 { return "session-only" }
    if sessionHits == 0 { return "none" }
    return "intermittent(per-pid \(perPidHits)/3)"
}

private func tryArmEventTapOnce() -> String {
    let mask = CGEventMask(1) << CGEventType.leftMouseDown.rawValue
    let callback: CGEventTapCallBack = { _, _, event, _ in Unmanaged.passUnretained(event) }
    // 按 pid 的 tap：参照第一层用的就是它
    let perPid = CGEvent.tapCreateForPid(
        pid: getpid(), place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: mask, callback: callback, userInfo: nil
    )
    // 全会话的 tap：同样需要辅助功能权限，但不带 pid 限定。
    // 两者分开报 —— 「按 pid 不行」和「tap 整个不行」指向完全不同的原因。
    let session = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: mask, callback: callback, userInfo: nil
    )
    for tap in [perPid, session].compactMap({ $0 }) {
        CGEvent.tapEnable(tap: tap, enable: false)
        CFMachPortInvalidate(tap)
    }
    if perPid != nil { return "per-pid" }
    if session != nil { return "session-only" }
    return "none"
}

func axTrusted() -> Bool { return AXIsProcessTrusted() }
/// 权限缺失时的文案：**要说清去哪儿开**，不能只回一个错误码。
///
/// 这两项授权 macOS **每次新构建都会重置**，所以用户会反复看到这条消息；
/// 只回 `ax_not_granted` 等于让他自己猜。参照的 helper 就是明说的：
/// "Accessibility permission not granted to Alma Computer Use. Open System Settings →
///  Privacy & Security → Accessibility and enable \"Alma Computer Use\"."
func axNotGranted() -> NSError {
    NSError(domain: "ax", code: 1, userInfo: [NSLocalizedDescriptionKey:
        "ax_not_granted: 辅助功能权限没有授予「Biny Computer Use」。"
        + "请打开 系统设置 → 隐私与安全性 → 辅助功能，启用「Biny Computer Use」后重试。"
        + "（macOS 每次新构建都会重置这项授权，重装或改代码后需要重新勾选。）"])
}
func screenRecordingMissing() -> NSError {
    NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey:
        "screen_recording_not_granted: 屏幕录制权限没有授予「Biny Computer Use」。"
        + "请打开 系统设置 → 隐私与安全性 → 屏幕录制与系统录音，启用「Biny Computer Use」后重试。"])
}


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
/// 按 pid 或 bundle 解析目标进程。
///
/// **bundle 没在跑就后台拉起**：参照的 `get_app_state` 就是这个语义
/// （"auto-launches the target app in the background if it is not running"），
/// 调用方不必先 launch 再 observe，冷启动也不会打断用户。
///
/// 关键是 `activates: false`。参照 SKILL 里那条
/// "Opening apps — DO NOT use `open -b`" 就是讲这件事：`open -b` 默认会激活应用、
/// 抢走用户当前的焦点。这里走 `NSWorkspace.openApplication` 并把激活关掉。
/// `fallbackPid` 用于「只给了 ref、没给 pid」的调用（参照的 `cu scroll <ref> <dir>` 就是这种）：
/// ref 已经能唯一定位到一个 pid 时，不必再要求调用方多说一遍。
func resolvePid(_ parameters: [String: Any], fallbackPid: pid_t? = nil) throws -> pid_t {
    if let pid = parameters["pid"] as? Int { return pid_t(pid) }
    if let fallbackPid { return fallbackPid }
    // 只给 ref 时（`cu click e12`、`cu set_value e3 x`）从元素表反查 pid：
    // 参照的调用方**从来不带 pid**（它的元素存储是全局的），本实现按 pid 分表，
    // 于是"只给 ref"这条调用在参照里成立、在这里不成立。`pidForRef` 就是为这个写的
    // （scroll 那条路已经在用，这里是把它挪到所有动词共用的入口上）。
    // 反查不到就照旧往下走，由各自的报错路径说清楚，别在这里改变失败姿态。
    if let ref = parameters["ref"] as? String, let pid = pidForRef(ref) { return pid }
    if let bundle = parameters["bundle"] as? String {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app.processIdentifier }
        // 参照的 MCP 契约里有 `auto_launch`（"Auto-launch the app in the background if not
        // running. **Default true.** Pass `auto_launch: false` to disable."）。
        // 本实现一直就是后台自启的，只是没有这个开关 —— 又一次"能力在、路不通"。
        // 关掉它的人要的是"别动我的机器"，所以这里必须**说出来**，不能静默照旧启动。
        if parameters["auto_launch"] as? Bool == false {
            throw NSError(domain: "app", code: 3, userInfo: [NSLocalizedDescriptionKey:
                "app_not_running: \(bundle) 没在运行，而这次显式要求 auto_launch=false。先自己起一个，或去掉这个参数让它后台自启。"])
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else {
            throw NSError(domain: "app", code: 1, userInfo: [NSLocalizedDescriptionKey: "app_not_installed: \(bundle)"])
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        let ready = DispatchSemaphore(value: 0)
        var launched: NSRunningApplication?
        NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, _ in
            launched = app
            ready.signal()
        }
        // 冷启动要给它一点时间，但不无限等 —— 起不来就如实报，别让调用方卡在这儿。
        _ = ready.wait(timeout: .now() + 5)
        if let launched { return launched.processIdentifier }
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app.processIdentifier }
        throw NSError(domain: "app", code: 1, userInfo: [NSLocalizedDescriptionKey: "app_launch_failed: \(bundle) 没能在 5 秒内起来"])
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
/// `CGEventSetWindowLocation` 是 **SPI**：头文件里没有，只能 dlsym 拿。
///
/// 参照的 helper 也这么做（它的日志里写着拿不到就 "window-local pipeline disabled"）。
/// 实测这台机器上符号存在 —— 所以那条"窗口局部管线"是可用的，只是我从没接上。
private let setWindowLocationFn: (@convention(c) (CGEvent, CGPoint) -> Void)? = {
    guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
          let symbol = dlsym(handle, "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: (@convention(c) (CGEvent, CGPoint) -> Void).self)
}()

/// 这个事件能不能用「窗口局部管线」送。
var windowLocalPipelineAvailable: Bool { setWindowLocationFn != nil }

/// 发一个鼠标事件。
///
/// 三条路，**优先那条不抢焦点的**：
/// 1. **窗口局部管线**（`CGEventSetWindowLocation` + `postToPid`）——
///    事件以"落在这个窗口里"的身份送到目标进程，**不经过窗口服务器的激活路径**，
///    所以用户的前台不会被顶掉。这是参照所谓 focus-steal prevention 的核心。
/// 2. **全局投递**（`.cghidEventTap`）—— 能送达，但**全局点击本身就会激活落点窗口**，
///    只能靠事后还回去（压小，压不到零）。
/// 3. 裸 `postToPid`（不带窗口位置）—— 实测**鼠标事件根本不投递**，等于什么都不做。
func postMouse(_ pid: pid_t, _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, clickState: Int64 = 1, global: Bool = false, windowLocal: Bool = true) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    if !global, windowLocal, let setLocation = setWindowLocationFn, let origin = windowScreenBounds(pid: Int(pid)) {
        // 窗口局部坐标 = 屏幕坐标 − 窗口原点
        setLocation(event, CGPoint(x: point.x - (origin["x"] ?? 0), y: point.y - (origin["y"] ?? 0)))
        event.postToPid(pid)
        return
    }
    if global { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
}
/// 发一个组合键。
///
/// 默认投给目标进程（后台应用也能收，且不动前台）。`global` 走全局 HID 流，
/// 落到**当前焦点**上 —— 有些键（系统级快捷键、必须经过窗口服务器的那类）
/// 投给进程是表达不出来的。代价是它会被前台应用收到，所以要显式选择。
func postKey(_ pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags, global: Bool = false, windowID: Int? = nil) throws {
    if let windowID { try validateActiveInputTarget(pid, windowID) }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { return }
    down.flags = flags; up.flags = flags
    if global { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
    else { down.postToPid(pid); up.postToPid(pid) }
}
func postUnicode(_ pid: pid_t, _ text: String, windowID: Int? = nil) throws {
    for scalar in text.unicodeScalars {
        if let windowID { try validateActiveInputTarget(pid, windowID) }
        let units = Array(String(scalar).utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        if windowID != nil { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
        else { down.postToPid(pid); up.postToPid(pid) }
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
    // AppleScript **没有超时 API**：目标应用不响应时 `executeAndReturnError` 会一直挂着
    // （Apple events 默认可以等上好几分钟）。而这是在请求处理路径上 ——
    // 挂住就等于整个请求等到客户端超时，症状会变成"daemon 没反应"。
    // 所以放独立线程 + 限时等待：等不到就如实说"还没回来"，而不是把自己搭进去。
    var result: String? = "timeout_waiting_for_app"
    let done = DispatchSemaphore(value: 0)
    let thread = Thread {
        let script = NSAppleScript(source: "tell application id \"\(bundleId)\" to activate")
        var error: NSDictionary?
        _ = script?.executeAndReturnError(&error)
        result = error.map { "\($0[NSAppleScript.errorNumber] ?? "?")" }
        done.signal()
    }
    thread.stackSize = 1 << 20
    thread.start()
    guard done.wait(timeout: .now() + 3) == .success else { return result }
    return result
}

func windowsForApp(_ pid: Int) -> [[String: Any]] {
    // 参照的 help 原文是 **"List AX windows of an app"** —— 来源是 **AX**，不是 CGWindowList。
    // 这个差别是可观察的：活动监视器与 Finder 的 AX 树里有 AXWindow（`snap` 看得到），
    // 而 CGWindowList 那一侧它们被 layer/尺寸过滤掉 → 旧实现返回空，
    // 调用方看到的是"这个应用没有窗口"。（Chrome 两边都有，所以一直没暴露。）
    var axEntries: [[String: Any]] = []
    if let windows = axCopy(axApp(pid_t(pid)), kAXWindowsAttribute as String) as? [AXUIElement] {
        for (index, window) in windows.enumerated() {
            var entry: [String: Any] = [
                "window_id": 0,                              // 能用 CG 号就填，填不了给 0（不编）
                "title": axString(window, kAXTitleAttribute as String) ?? "",
                "index": index,
            ]
            if let frame = axFrame(window) {
                entry["frame"] = ["x": frame["x"]!, "y": frame["y"]!, "w": frame["w"]!, "h": frame["h"]!] as [String: Double]
            }
            axEntries.append(entry)
        }
    }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return axEntries }
    var out: [[String: Any]] = []
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let number = window[kCGWindowNumber as String] as? Int,
              // ⚠️ CGWindowList 给的是 CFDictionary：`kCGWindowBounds` 桥过来是 [String: Any]
              // （值是 CFNumber），**转不成 [String: CGFloat]** —— 写成那个类型时这个 guard
              // 对**每一个窗口**都失败，函数安静地返回 []，而调用方看到的是"这个应用没有窗口"。
              // （实测：活动监视器 snap 看得到 AXWindow，而 cu windows 回"没有在屏窗口"。）
              let boundsRaw = window[kCGWindowBounds as String] as? [String: Any] else { continue }
        let boundsW = (boundsRaw["Width"] as? NSNumber)?.doubleValue ?? 0
        let boundsH = (boundsRaw["Height"] as? NSNumber)?.doubleValue ?? 0
        let width = boundsW, height = boundsH
        // 阴影和辅助小窗不是可观察目标，混进来只会让模型挑错。
        if width < 40 || height < 40 { continue }
        var entry: [String: Any] = [
            "window_id": number,
            "title": window[kCGWindowName as String] as? String ?? "",
            "frame": [
                "x": (boundsRaw["X"] as? NSNumber)?.doubleValue ?? 0,
                "y": (boundsRaw["Y"] as? NSNumber)?.doubleValue ?? 0,
                "w": width, "h": height
            ] as [String: Double],
        ]
        if window[kCGWindowIsOnscreen as String] as? Bool == true { entry["onscreen"] = true }
        out.append(entry)
    }
    // CG 一条都没有 ≠ 这个应用没有窗口 —— 两个来源取并集：CG 有就补它的窗口号，
    // 没有就用 AX 的（并把 window_id 留着 0，让调用方知道这个号不可用）。
    if out.isEmpty { return axEntries }
    if !axEntries.isEmpty {
        for index in out.indices where index < axEntries.count {
            if let axTitle = axEntries[index]["title"] as? String, !axTitle.isEmpty,
               (out[index]["title"] as? String ?? "").isEmpty {
                out[index]["title"] = axTitle
            }
        }
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
/// 返回这次点击走的哪条路 —— 调用方能据此判断"会不会抢焦点"。
/// `window-local` = 不激活落点窗口；`global` = 能送达但会激活它。
@discardableResult
func postClick(_ pid: pid_t, _ point: CGPoint, button: CGMouseButton, clicks: Int, preferWindowLocal: Bool = false) -> String {
    let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
    let saved = CGEvent(source: nil)?.location
    // ⚠️ 默认**不用**窗口局部管线，尽管它才是"不抢焦点"的正解。
    // 理由：**它的投递还没被验证过**（我试了三种观测量都测不出它有没有送到），
    // 而它替换掉的全局路是**已验证可用**的。未经证实就换掉能用的那条，
    // 等于用一个"可能更正确"的说法去赌"现在还能不能点"。
    // → 想试的人显式要它（`pipeline: "window-local"`），回执里会写明走的哪条。
    // ⚠️ 曾经把这里改成"默认走窗口局部管线"做实验（想验证它能否替代会拽光标的全局路），
    // **实验没有信号**：我用的观测（插入点有没有动）在**两条管线上都报"没送达"** ——
    // 包括我已知能送达的全局路，所以是仪器的问题，不是管线的结论。
    // 三次尝试（活动监视器选中行 / Calculator 按钮 / TextEdit 插入点）全部无效。
    // → 回到已验证的默认；管线仍然可选（`pipeline: "window-local"`）且回执里写明走的哪条。
    let useWindowLocal = preferWindowLocal && windowLocalPipelineAvailable
    // 全局合成点击**必然把光标瞬移到落点**（事件本身就带坐标，这是机制不是 bug）。
    // 位置我们保存并还原，但那一瞬看得见 —— 用户会觉得"鼠标被抢走了"。
    // 既然这一下动不了，就**在动的时候把它藏起来**：藏着的这段时间看不到瞬移。
    // ⚠️ 隐藏只是不画出来，位置真的变了 —— 所以下面的还原照样要执行。
    // 走窗口局部管线时不需要（它不碰光标）。
    var cursorHidden = false
    if !useWindowLocal { cursorHidden = CGDisplayHideCursor(CGMainDisplayID()) == .success }
    defer { if cursorHidden { _ = CGDisplayShowCursor(CGMainDisplayID()) } }
    let total = max(1, clicks)
    for index in 1...total {
        // **先试窗口局部管线**：它不激活落点窗口，所以用户的前台不会被顶掉。
        // 全局投递是回落 —— 它确实能送达，代价是必然激活。
        postMouse(pid, down, point, button, clickState: Int64(index), global: !useWindowLocal, windowLocal: useWindowLocal)
        postMouse(pid, up, point, button, clickState: Int64(index), global: !useWindowLocal, windowLocal: useWindowLocal)
        // 太快会被系统合并成一下，太慢会被当成两次独立点击。
        if index < total { usleep(60_000) }
    }
    // 光标是我们挪的，用完放回去 —— 用户不该因为一次自动化发现鼠标换了位置。
    if let saved { CGWarpMouseCursorPosition(saved) }
    return useWindowLocal ? "window-local" : "global"
}


/// 截图同样可能挂在无响应的窗口上：独立线程采集，主线程轮询到点就放弃。
/// 焦点守卫：很多 Cocoa/Electron 应用会在自己的点击处理里调
/// `activateIgnoringOtherApps:` —— 那是我们控制不了的代码，会把用户的前台窗口抢走。
/// 动作前记下当时的前台应用，动作后如果前台变成了目标应用，就切回去。
/// 后台输入使用此安全网；显式前台投递保留新控件焦点。
func withFocusGuard<T>(_ pid: pid_t, preserveElementFocus: Bool = true, _ body: () async throws -> T) async rethrows -> T {
    let before = NSWorkspace.shared.frontmostApplication
    let restore = (before?.processIdentifier == pid) ? nil : before
    // 应用级之外再记一层**元素级**：同一个应用内换 key window 时，前台应用没变，
    // 但用户的焦点其实已经被挪走了。参照判的就是这一层。
    let app = axApp(pid)
    let focusedBefore = focusedElementFingerprint(app)
    let focusedElementBefore: AXUIElement? = axCopy(app, kAXFocusedUIElementAttribute as String)
        .map { unsafeBitCast($0, to: AXUIElement.self) }
    let value = try await body()

    // 元素级：焦点在**应用内部**被挪走了吗？挪走了就还回去，并计一次数。
    if preserveElementFocus, let focusedBefore, let elementBefore = focusedElementBefore,
       focusedElementFingerprint(app) != focusedBefore {
        _ = AXUIElementSetAttributeValue(elementBefore, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        observedActivations += 1
        focusGuardNote = "focus_returned_to_element: 动作把焦点挪到了本应用的另一个元素上，已经还回原来的那个。"
    }
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

func collectAccessibility(pid: pid_t, maxDepth: Int, limit: Int, timeout: Double, interactiveOnly: Bool = true, windowId: Int? = nil) -> ([[String: Any]], [String: AXUIElement], Int, Int) {
    let box = AXCollectBox()
    let thread = Thread {
        let app = axApp(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        // AXEnhancedUserInterface 要当**有作用域的断言**用，不是永久打开。
        // 参照的 AXEnablementAssertion 里有个 prevEnhanced —— 它记原值，用完恢复。
        // 留着的后果是具体的：Electron 应用会一直渲染完整无障碍树，可能持续变慢 ——
        // 那是留在**用户正在用的应用**上的副作用，不该由我们留下。
        let prevEnhanced = axCopy(app, "AXEnhancedUserInterface" as String)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        func walkOnce() -> ([[String: Any]], [String: AXUIElement]) {
            var elements: [[String: Any]] = []
            var table: [String: AXUIElement] = [:]
            var counter = 0
            let selected = windowId.flatMap { axWindow(pid: pid, matching: $0) }
                ?? (windowId == nil ? (axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement])?.first : nil)
            if let main = selected {
                if let frame = axFrame(main) { elements.append(["ref": "e0", "role": "AXWindow", "frame": frame]) }
                table["e0"] = main
                axWalk(main, depth: 0, maxDepth: maxDepth, limit: limit, counter: &counter, table: &table, out: &elements, deadline: Date().addingTimeInterval(2))
            }
            return (elements, table)
        }

        // 唤醒：AX 树读回来是**空的**时候重试几次。
        //
        // 参照有这套（`wakeupAttempts` / `wakeupDurationMs` / `no_wakeup_budget` /
        // `empty_after_wakeup`）—— 有些应用在 app nap 或懒加载时第一遍就是空的，
        // 重打一次标志再读就有了。预算刻意收紧（只在「只有窗口、没有元素」时才重试），
        // 免得把正常的观察拖慢。
        let wakeupBudget = 2
        var wakeupAttempts = 0
        let wakeupStart = Date()
        var result = walkOnce()
        while result.0.count <= 1 && wakeupAttempts < wakeupBudget {
            wakeupAttempts += 1
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            usleep(150_000)
            result = walkOnce()
        }
        let wakeupDurationMs = Int(Date().timeIntervalSince(wakeupStart) * 1000)
        let elements = result.0
        let table = result.1
        // 遍历一结束就撤销断言。原值有就放回，本来没有就置回 false ——
        // 别把「增强模式」留在用户的应用上。
        if let prevEnhanced {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, prevEnhanced)
        } else {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }
        box.store(elements, table, wakeupAttempts: wakeupAttempts, wakeupDurationMs: wakeupDurationMs, interactiveOnly: interactiveOnly)
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
    private var attempts = 0
    private var durationMs = 0
    var done: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    func store(_ nextElements: [[String: Any]], _ nextTable: [String: AXUIElement], wakeupAttempts: Int = 0, wakeupDurationMs: Int = 0, interactiveOnly: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        if finished { return }
        // 过滤的只是**给调用方看的列表**，`table` 保持完整 —— ref 仍能解析到被过滤掉的元素，
        // 于是「看见的变少了」不会连带把已给的 ref 弄失效。
        // 窗口本身留着（它没有"可交互"一说，但它是树的根）。
        elements = interactiveOnly
            ? nextElements.filter { ($0["role"] as? String).map { $0 == "AXWindow" || interactiveRoles.contains($0) } ?? false }
            : nextElements
        table = nextTable; finished = true
        attempts = wakeupAttempts; durationMs = wakeupDurationMs
    }
    func take() -> ([[String: Any]], [String: AXUIElement], Int, Int) {
        lock.lock(); defer { lock.unlock() }
        return (elements, table, attempts, durationMs)
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
/// 顺序：**先试整页滚动动作**（`AXScrollDownByPage` 等，参照用的就是它），不认再写 AXValue。
///
/// ⚠️ 这里原先写着「macOS 没有『整页滚动』这个 AX 动作常量」——**那句是错的**。
/// 动作存在，只是以字符串寻址；头文件没有对应常量 **不等于** 平台没有这个动作
/// （AX 动作本来就是字符串）。正确的做法是去试，不是据"没有常量"下结论。
/// 实测这些目标（活动监视器的滚动条/滚动区/内容）都不认这个动作，于是回落；
/// scrollbar 的 kAXValueAttribute 可写是头文件明说的，写进去立刻回读得到。
///
/// 两条路由是**互补**的，不是备选：网页内容（Chrome）不暴露 AXScrollBar
/// （浏览器自绘），只有原生滚动区才暴露。所以按目标**暴露了什么**来选，
/// 而不是按调用方的猜测。
func installedApplications(bundleIds: [String]) -> [[String: Any]] {
    var applications: [[String: Any]] = []
    var seen = Set<String>()
    func append(_ url: URL) {
        guard let bundle = Bundle(url: url), let identifier = bundle.bundleIdentifier,
              !identifier.isEmpty, seen.insert(identifier).inserted else { return }
        let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? url.deletingPathExtension().lastPathComponent
        applications.append(["bundleId": identifier, "name": name, "path": url.path, "running": false])
    }
    // 已保存的排除项可能安装在自定义目录；优先解析，避免目录扫描遗漏它们。
    for identifier in bundleIds.prefix(256) {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) { append(url) }
    }
    let roots = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: "/System/Applications"),
                 FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]
    var inspected = 0
    for root in roots {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles], errorHandler: { _, _ in true }) else { continue }
        while let url = enumerator.nextObject() as? URL {
            inspected += 1
            if inspected > 10_000 || applications.count >= 2048 { break }
            if url.pathExtension.lowercased() == "app" {
                enumerator.skipDescendants()
                append(url)
            }
        }
    }
    return applications
}

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

/// 只凭 ref 找回 pid。
///
/// 参照的 CLI 是 `cu scroll <ref> <up|down|…>` —— **不带 pid**，说明它的元素存储是全局的
/// （helper 类名表里那个 `ElementStore`）。本实现的 refTables 是按 pid 分表的，
/// 于是"只给 ref"这条调用在参照里成立、在这里不成立。
/// 这里跨表找一次：**唯一命中才算**，多个 pid 都有同名 ref 时宁可报歧义，也不猜。
func pidForRef(_ ref: String) -> pid_t? {
    // 参照的元素存储是**全局**的，所以它的 ref 天然不冲突；本实现按 pid 分表，
    // 而 daemon 活得很久（900s 空闲才退），于是同一个 ref 名会在多个应用的表里同时存在。
    // 规则：**最近一次观察的那个 pid 优先**（ref 本来就是"最近一次观察"里的引用，
    // 跨轮次即失效）；不中再退回"唯一命中"，仍不唯一就返回 nil，让调用方报清楚，不猜。
    if let recent = lastObservedPid, refTables[recent]?[ref] != nil { return recent }
    let hits = refTables.compactMap { (key, table) -> pid_t? in table[ref] != nil ? key : nil }
    return hits.count == 1 ? hits[0] : nil
}

/// 能点/能输入的角色 —— 参照 `interactive_only` 用的就是这一组。
///
/// 来源：helper 二进制里的独立角色串（`strings | grep -E "^AX[A-Za-z]+$"`），
/// 去掉动作（AXPress/AXPick/AXScrollXByPage…）、属性（AXValue/AXSelectedTextRange…）、
/// 内部符号（AXBridge/AXEnablementAssertion/EnhancedUserInterface/Observer…）之后剩下的。
/// **不是我编的**：照抄错了要么藏住该给的，要么多给一堆。
let interactiveRoles: Set<String> = [
    "AXButton", "AXCell", "AXCheckBox", "AXComboBox", "AXDisclosureTriangle", "AXIncrementor",
    "AXLink", "AXMenuButton", "AXMenuItem", "AXPopUpButton", "AXRadioButton", "AXRow",
    "AXSlider", "AXTab", "AXTextArea", "AXTextField"
]

/// 从一个具体元素往上找它所属的滚动区。
///
/// 参照在这条路上给调用方的提示是 "ref points at an unscrollable element
/// (snap the parent ScrollArea)" —— 也就是**让调用方自己往上找**。
/// 我们已经能走这条链，就替调用方走完，省掉一次来回观察。
func scrollAreaAncestor(of element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<8 {                                  // 有界，避免病态树
        guard let node = current else { return nil }
        if axString(node, kAXRoleAttribute as String) == "AXScrollArea" { return node }
        guard let parentRef = axCopy(node, kAXParentAttribute as String) else { return nil }
        current = unsafeBitCast(parentRef, to: AXUIElement.self)
    }
    return nil
}

func axScroll(_ pid: pid_t, direction: String, notches: Int, pages: Double? = nil, refArea: AXUIElement? = nil) -> [String: Any]? {
    let wantsVertical = direction == "up" || direction == "down"
    let forward = direction == "down" || direction == "right"
    guard let windowRef = axCopy(axApp(pid), kAXFocusedWindowAttribute as String) else { return nil }
    let window = unsafeBitCast(windowRef, to: AXUIElement.self)
    let area: AXUIElement
    if let refArea {
        // ref 常常指向内容元素（表格/大纲/文本），往上找到它所属的滚动区；
        // 实在找不到就把 ref 本身当滚动区试 —— 不静默放弃。
        area = scrollAreaAncestor(of: refArea) ?? refArea
    } else {
        guard let found = findScrollArea(window) else { return nil }
        area = found
    }
    for bar in axChildren(area) where axString(bar, kAXRoleAttribute as String) == "AXScrollBar" {
        guard (axString(bar, kAXOrientationAttribute as String) == "AXVerticalOrientation") == wantsVertical else { continue }
        // 先试**整页滚动动作** —— 参照用的就是它（`AXScrollDownByPage` 等）。
        // 我早先说"macOS 没有这个动作"是错的：AX 动作本来就以字符串寻址，
        // 头文件里没有常量不代表平台没有。头文件没给，就自己去试。
        let pageAction: String? = {
            switch direction {
            case "down": return "AXScrollDownByPage"
            case "up": return "AXScrollUpByPage"
            case "left": return "AXScrollLeftByPage"
            default: return "AXScrollRightByPage"
            }
        }()
        if let pageAction {
            // 动作要打在**支持它的那个元素**上：滚动区本身不一定认，内容元素（表格/大纲）才认。
            // 参照给调用方的提示也是这个意思（"snap the parent ScrollArea"）。
            // 候选有限，逐个试一下比让调用方自己猜便宜。
            // 顺序：滚动条（"整页"本来就是滚动条的概念，它最可能认）→ 滚动区 → 内容元素。
            var candidates: [AXUIElement] = []
            candidates.append(contentsOf: axChildren(area).filter {
                axString($0, kAXRoleAttribute as String) == "AXScrollBar"
            })
            candidates.append(area)
            candidates.append(contentsOf: axChildren(area).filter {
                axString($0, kAXRoleAttribute as String) != "AXScrollBar"
            })
            for candidate in candidates where AXUIElementPerformAction(candidate, pageAction as CFString) == .success {
                return ["scrolled": direction, "route": "ax-page", "unit": "pages"]
            }
        }
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
    // 参照在同一个位置给的是：说清发生了什么 + **点明那个显而易见的错误修法** + 给替代做法。
    // 「别把应用调到前台」这条铁律单说不够 —— agent 最可能做的就是那件事，所以要顺手告诉它改走哪条路。
    // （参照原文："Do NOT bring the app forward to make typing land — Alma never takes the user's foreground."）
    return "keystrokes_may_be_dropped: 目标应用不在前台，且没有任何聚焦的 UI 元素，这些按键很可能已被系统丢弃。"
        + "先重新观察确认目标状态，别把它当成写进去了。"
        + "要真的写进那个控件，用 set_value（带 ref 直接写值）或 type_text 的 input_method=ax（同样按元素走）。"
        + "不要自动重放或切前台。仅在用户开启前台许可且本次明确选择 foreground 后使用前台输入。"
}

func validateActiveInputTarget(_ pid: pid_t, _ windowID: Int) throws {
    var focusedID: CGWindowID = 0
    let focusedWindow = axCopy(axApp(pid), kAXFocusedWindowAttribute as String)
        .map { unsafeBitCast($0, to: AXUIElement.self) }
    let identified = focusedWindow.map { axWindowIdFn?($0, &focusedID) == .success } ?? false
    try validateForegroundTarget(pid: Int(pid), windowID: windowID,
        frontmostPID: NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) },
        focusedWindowID: identified ? Int(focusedID) : nil)
}

@MainActor func prepareForegroundInput(_ args: [String: Any]) async throws {
    guard let targetPID = args["pid"] as? Int, targetPID > 0, targetPID <= Int(Int32.max),
          let targetWindowID = args["window_id"] as? Int, targetWindowID > 0, targetWindowID <= Int(UInt32.max),
          let application = NSRunningApplication(processIdentifier: pid_t(targetPID)),
          windowScreenBounds(pid: targetPID, windowID: targetWindowID) != nil,
          let window = axWindow(pid: pid_t(targetPID), matching: targetWindowID) else {
        throw NSError(domain: "input", code: 65, userInfo: [NSLocalizedDescriptionKey: "foreground_target_unavailable: input was not sent; observe the exact target again"])
    }
    if !application.isActive {
        guard let appURL = application.bundleURL else {
            throw NSError(domain: "input", code: 65, userInfo: [NSLocalizedDescriptionKey: "foreground_target_unavailable: application location is unknown; input was not sent"])
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = false
        configuration.allowsRunningApplicationSubstitution = false
        configuration.promptsUserIfNeeded = false
        let activation = await withDeadline(0.75, fallback: ["error": "foreground_activation_timeout: input was not sent; observe before deciding what remains"]) {
            await withCheckedContinuation { continuation in
                NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { activated, error in
                    if let error { continuation.resume(returning: ["error": "foreground_activation_failed: \(error.localizedDescription)"]) }
                    else { continuation.resume(returning: ["pid": Int(activated?.processIdentifier ?? 0)]) }
                }
            }
        }
        guard activation["pid"] as? Int == targetPID else {
            throw NSError(domain: "input", code: 65, userInfo: [NSLocalizedDescriptionKey:
                activation["error"] as? String ?? "foreground_target_identity_changed: input was not sent; observe the target again"])
        }
    }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    let deadline = Date().addingTimeInterval(0.75)
    while Date() < deadline {
        if (try? validateActiveInputTarget(pid_t(targetPID), targetWindowID)) != nil { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    try validateActiveInputTarget(pid_t(targetPID), targetWindowID)
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

/// 把截图失败的原因说成调用方能据以行动的一句话。
///
/// `screenshot()` 抛错时原来被 `try?` 吞掉，于是回执里只有 0 和空缺 ——
/// **"没有截图"** 和 **"为什么没有截图"** 是两件事，参照分开报（`screenshot_error`）。
/// 权限那一条尤其要说清：它是**每次新构建都会重置**的授权，用户一定会遇到。
func describeCaptureFailure(_ error: Error) -> String {
    let described = (error as NSError)
    if described.domain == "capture" && described.code == 64 {
        return "capture_missing_output: 内部调用没给输出路径（不该发生，报出来）。"
    }
    if described.localizedDescription.contains("屏幕录制") || described.localizedDescription.contains("screen") {
        return "screen_recording_not_granted: \(described.localizedDescription)"
    }
    return "capture_failed: \(described.localizedDescription)（domain=\(described.domain) code=\(described.code)）。"
        + "若反复出现，先在「系统设置 → 隐私与安全性 → 屏幕录制」里确认「Biny Computer Use」是开着的 —— 权限每次新构建都会重置。"
}

func screenshot(_ parameters: [String: Any]) async throws -> [String: Any] {
    guard let output = parameters["out"] as? String else { throw NSError(domain: "capture", code: 64) }
    // 先自己查一遍屏幕录制权限。不查的话，缺权限会在下面那行以
    // ScreenCaptureKit 的原始错误冒出来 —— 对用户毫无指引，而这是个
    // **每次新构建都会重置**的授权，所以他一定会遇到。
    guard screenTrusted() else { throw screenRecordingMissing() }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    try validateCaptureTarget(pid: parameters["pid"] as? Int, windowID: parameters["window_id"] as? Int,
        applications: Set(content.applications.map { Int($0.processID) }),
        windows: Dictionary(content.windows.compactMap { window in
            window.owningApplication.map { (Int(window.windowID), Int($0.processID)) }
        }, uniquingKeysWith: { first, _ in first }))
    let config = SCStreamConfiguration()
    config.showsCursor = false
    // 指定目标在枚举后校验；目标消失时拒绝，不能扩大到别的窗口或整屏。
    if let pid = parameters["pid"] as? Int,
       content.applications.contains(where: { Int($0.processID) == pid }),
       let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first {
        // 真实屏幕位置：AX 报的 frame 是 UI 坐标，跟 CGEvent 用的屏幕点不一致，必须用 CGWindowList。
        let screenBounds = windowScreenBounds(pid: pid, windowID: parameters["window_id"] as? Int)
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
    // 原生镜像可能属于另一个 daemon；按 bundle 排除，避免活动记录二次采集镜像中的私有画面。
    let mirrors = content.applications.filter { $0.bundleIdentifier == "com.biny.computer-use" || $0.processID == getpid() }
    let filter = SCContentFilter(display: display, excludingApplications: mirrors, exceptingWindows: [])
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
    if elapsed >= max(1, idleSeconds) && MainActor.assumeIsolated({ windowMirrors.isEmpty }) { exit(0) }
}
/// 子命令与帮助。
///
/// 参照的 helper 有正经的 usage（`daemon [--socket PATH] [--idle-seconds N]` / `version`，
/// 并注明"The daemon is normally launched automatically by the app. Users do not need to run it
/// directly."）。本实现原先**完全忽略子命令**、缺 `--socket` 就静默 `exit(64)` ——
/// 于是"用户可以手动跑"这条路径是断的：跑一下什么都不说。
let usage = """
biny-computer-use \(driverVersion) — macOS 桌面自动化 helper（AX + ScreenCaptureKit）

用法:
  computer-use daemon [--socket PATH] [--idle-seconds N]
      启动常驻进程，开一个 Unix domain socket，按 NDJSON 收发。
      N 秒无活动后自退（默认 \(Int(idleSeconds))）。
  computer-use version
      打印版本后退出。

守护进程正常情况下由 Biny 自动拉起，用户不需要手动运行。
"""

let subcommand = CommandLine.arguments.dropFirst().first { !$0.hasPrefix("--") } ?? "daemon"
switch subcommand {
case "version":
    print(driverVersion); exit(0)
case "daemon":
    break
default:
    FileHandle.standardError.write("unknown subcommand: \(subcommand)\n\n".data(using: .utf8)!)
    print(usage); exit(64)
}

let socketIndex = CommandLine.arguments.firstIndex(of: "--socket")
// 有默认值：参照的默认是机器级路径（它的安装器建的），这里用**用户级** ——
// `/Library/...` 普通用户写不进去，照抄会让手动跑必然失败。
let defaultSocket = (NSHomeDirectory() as NSString)
    .appendingPathComponent("Library/Application Support/alma/biny-computer-use-manual.sock")
let socketPath = socketIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? defaultSocket
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
            defer { close(fd); Task { @MainActor in if appshotMonitor.subscriber == fd { appshotMonitor.disarm() } } }
            var buffer = Data(); var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = Darwin.read(fd, &chunk, chunk.count)
                if count <= 0 { return }
                buffer.append(contentsOf: chunk.prefix(count))
                if buffer.count > 1_048_576 { return }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer.prefix(upTo: newline))
                    buffer.removeSubrange(...newline)
                    guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
                    activityLock.lock(); lastRequestAt = Date(); activityLock.unlock()
                    Task {
                        let id = request["id"] ?? NSNull()
                        do {
                            let cmd = request["cmd"] as? String ?? ""
                            let args = request["args"] as? [String: Any] ?? [:]
                            let foregroundInput = args["delivery"] as? String == "foreground"
                            if foregroundInput {
                                guard ["click", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "set_value", "select_text"].contains(cmd) else {
                                    throw NSError(domain: "input", code: 64, userInfo: [NSLocalizedDescriptionKey: "foreground_action_unsupported"])
                                }
                                try await prepareForegroundInput(args)
                            }
                            switch cmd {
                            case "ping":
                                reply(fd, ["id": id, "ok": true, "data": ["ok": true] as [String: Any]] as [String: Any])
                            case "pip_open":
                                reply(fd, ["id": id, "ok": true, "data": try await windowMirrors.open(args)])
                            case "pip_frame":
                                reply(fd, ["id": id, "ok": true, "data": try await windowMirrors.frame(args)])
                            case "pip_list":
                                reply(fd, ["id": id, "ok": true, "data": await windowMirrors.list()])
                            case "pip_close":
                                guard args["all"] as? Bool == true || (args["window_id"] as? Int).map({ $0 > 0 && $0 <= Int(UInt32.max) }) == true else {
                                    throw NSError(domain: "pip", code: 64, userInfo: [NSLocalizedDescriptionKey: "pip_close_requires_target: window_id or all=true"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": await windowMirrors.close(args)])
                            case "shot_display":
                                let shot = await captureObservation(timeout: 3, describeError: describeCaptureFailure) {
                                    try await screenshot(args)
                                }
                                if let error = shot["screenshot_error"] as? String {
                                    throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
                                }
                                reply(fd, ["id": id, "ok": true, "data": shot])
                            case "grant":
                                // 必须由守护进程自己发起：系统弹窗授的是「调用进程」——
                                // 从 Electron 宿主发起就会把辅助功能授给宿主，而真正需要它的是
                                // 这个独立签名的 helper（Alma 的 grant 同样落在 helper 上）。
                                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                                let granted = AXIsProcessTrustedWithOptions(options)
                                reply(fd, ["id": id, "ok": true, "data": ["accessibility": granted ? "granted" : "denied", "prompted": !granted] as [String: Any]])
                            case "app_identity":
                                guard let bundleId = args["bundle"] as? String,
                                      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId),
                                      let bundle = Bundle(url: url), bundle.bundleIdentifier == bundleId else {
                                    throw NSError(domain: "identity", code: 66, userInfo: [NSLocalizedDescriptionKey: "computer_app_identity_unavailable"])
                                }
                                let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
                                let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                                    ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? url.deletingPathExtension().lastPathComponent
                                reply(fd, ["id": id, "ok": true, "data": ["bundleId": bundleId, "name": name, "running": running != nil] as [String: Any]])
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
                                    // 第一层（事前拦截）需要的 API 到底能不能用 —— 见 canArmEventTap 注释。
                                    "focusTap": canArmEventTap(),
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
                                        "name": app.localizedName ?? app.bundleIdentifier ?? "Application",
                                        "running": true,
                                    ]
                                    // 没有 bundle id 的应用不要发空串：调用方按 min(1) 校验，
                                    // 一个空值会让整份列表解析失败，而不是只缺一个标识。
                                    if let bundle = app.bundleIdentifier, !bundle.isEmpty { entry["bundleId"] = bundle }
                                    if let url = app.bundleURL { entry["path"] = url.path }
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
                                // 默认 14 天：参照的 list_apps 描述写的是 "used in the last N days (default 14)"。
                                let days = args["recent_days"] as? Int ?? 14
                                let candidates = args["include_installed"] as? Bool == true
                                    ? installedApplications(bundleIds: args["bundle_ids"] as? [String] ?? [])
                                    : recentlyUsedApplications(withinDays: days)
                                apps.append(contentsOf: candidates.filter {
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
                            case "appshot_monitor_start":
                                // 「没给它」和「给了但解析不了」是两种坏法：前者补一个参数，后者改写法。
// 并成一句"invalid_hotkey"时，没给参数的人会去改一个他根本没传的字符串。
                                guard let raw = args["hotkey"] as? String else {
                                    throw NSError(domain: "appshot", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "hotkey_missing: 需要 hotkey 参数，写法如 Ctrl+Alt+C、Ctrl+Shift+Space，或 double-cmd"])
                                }
                                guard let spec = parseHotkey(raw) else {
                                    throw NSError(domain: "appshot", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "invalid_hotkey: 写法如 Ctrl+Alt+C、Ctrl+Shift+Space，或 double-cmd"])
                                }
                                let armed = try await MainActor.run { () throws -> Bool in
                                    if let owner = appshotMonitor.subscriber, owner != fd { throw NSError(domain: "appshot", code: 69, userInfo: [NSLocalizedDescriptionKey: "appshot_monitor_owned"]) }
                                    let armed = appshotMonitor.arm(spec, raw: raw)
                                    if armed && args["emit_events"] as? Bool == true { appshotMonitor.subscriber = fd; appshotMonitor.captureOptions = args }
                                    return armed
                                }
                                guard armed else {
                                    throw NSError(domain: "appshot", code: 65, userInfo: [NSLocalizedDescriptionKey:
                                        "appshot_tap_unavailable: 会话级事件 tap 建不起来（需要辅助功能权限）"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["hotkey": raw, "armed": true] as [String: Any]])
                            case "appshot_monitor_stop":
                                await MainActor.run { if appshotMonitor.subscriber == nil || appshotMonitor.subscriber == fd { appshotMonitor.disarm() } }
                                reply(fd, ["id": id, "ok": true, "data": ["armed": false] as [String: Any]])
                            case "appshot_status":
                                let status: [String: Any] = await MainActor.run { [
                                    "armed": appshotMonitor.isArmed,
                                    "hotkey": appshotMonitor.hotkey,
                                    "lastCapture": appshotMonitor.lastCapturePath ?? "",
                                    "live": appshotMonitor.isLive,
                                    "eventsSeen": appshotMonitor.eventsSeen,
                                    "tapDisables": appshotMonitor.disableCount,
                                    "tapDisablesRecovered": appshotMonitor.recoveredCount,
                                    "captureError": appshotMonitor.captureError as Any? ?? NSNull(),
                                ] }
                                reply(fd, ["id": id, "ok": true, "data": status])
                            case "appshot_frontmost":
                                // 「取不到前台」和「前台就是我自己（没得拍）」是两件事：
                                // 前者是查询失败，后者是此刻没什么可拍的。并成一句，
                                // 读的人分不清该重试还是该切到别的窗口。
                                guard let front = NSWorkspace.shared.frontmostApplication else {
                                    throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey:
                                        "appshot_frontmost_unavailable: 取不到前台应用（系统查询失败）。稍后再试。"])
                                }
                                guard front.processIdentifier != getpid() else {
                                    throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey:
                                        "appshot_frontmost_is_self: 前台是守护进程自己，没有可拍的应用。先让用户切到目标窗口。"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": [
                                    "pid": Int(front.processIdentifier),
                                    "bundleId": front.bundleIdentifier ?? "",
                                    "name": front.localizedName ?? "",
                                ] as [String: Any]])
                            case "appshot_capture":
                                reply(fd, ["id": id, "ok": true, "data": try await appshotMonitor.captureFrontmost(args)])
                            case "intent":
                                // 派发一个注册过的原生意图。`open_url` 是通用那条：
                                // 任何 URL scheme 或文档 URL 都能交给处理它的应用。
                                let name = args["intent"] as? String ?? "open_url"
                                // ⚠️ 别叫 `id`：那会遮蔽请求 id，于是 reply 回的是意图参数的 id，
                                // 客户端对不上号、把回执丢掉、一路等到超时（daemon 其实是回了的）。
                                // 默认取 args.id；但像 open_music_url / play_spotify_uri 这种，调用方
                                // 直觉上会写 args.url —— 两个都认，省得为参数名猜一次。
                                let intentArgs = args["args"] as? [String: Any]
                                let intentArgId = (intentArgs?["id"] ?? intentArgs?["url"]).map { "\($0)" }
                                var targetBundle = args["bundle"] as? String
                                var urlString: String?
                                if name == "compose_mail" {
                                    // ⚠️ 这一支必须在**最前面**：它和 open_url / nativeIntents 是并列的，
                                    // 塞进 `if name == "open_url"` 里面的话外层条件根本不成立，永远走不到。
                                    let params = args["args"] as? [String: Any] ?? [:]
                                    var parts: [String] = []
                                    for key in ["cc", "bcc", "subject", "body"] where params[key] != nil {
                                        let raw = String(describing: params[key]!)
                                        let encoded = raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? raw
                                        parts.append("\(key)=\(encoded)")
                                    }
                                    urlString = "mailto:\((params["to"] as? String) ?? "")" + (parts.isEmpty ? "" : "?\(parts.joined(separator: "&"))")
                                } else if name == "open_url" {
                                    urlString = args["url"] as? String ?? intentArgId
                                } else if let spec = nativeIntents[name] {
                                    targetBundle = targetBundle ?? spec.bundle
                                    urlString = spec.url(intentArgId)
                                }
                                // ⚠️「名字不认识」和「名字对但没给 url」是两种坏法，下一步也不同
                                // （查名字 vs 补参数）—— 我上轮刚立下这条不变量，这里又并成了一句。
                                let isKnown = name == "open_url" || nativeIntents[name] != nil
                                guard isKnown else {
                                    let known = (["open_url"] + nativeIntents.keys.sorted()).joined(separator: "/")
                                    throw NSError(domain: "intent", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "unknown_intent: \" \(name) \" 不是已注册的意图。可用：\(known)；netease_route 的 route 取其一：\(knownNeteaseRoutes.joined(separator: "/"))"])
                                }
                                guard let urlString else {
                                    throw NSError(domain: "intent", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "intent_missing_url: 意图 \(name) 需要 URL，把它放在 args.id 或 args.url 里"])
                                }
                                guard let url = URL(string: urlString) else {
                                    throw NSError(domain: "intent", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "intent_bad_url: \" \(urlString) \" 不是合法 URL"])
                                }
                                let config = NSWorkspace.OpenConfiguration()
                                // 关键：不激活。意图就是要"派完就走"，别把应用顶到前台。
                                config.activates = false
                                // 先解析处理者，**别等 completion**：那个回调不保证会来，
                                // 等它会把请求线程堵死到超时（第一版就是这么挂的）。
                                // 能派就立刻回执；派不出去在解析这一步就能知道。
                                var handler: URL?
                                if let targetBundle {
                                    handler = NSWorkspace.shared.urlForApplication(withBundleIdentifier: targetBundle)
                                    guard handler != nil else {
                                        throw NSError(domain: "intent", code: 66, userInfo: [NSLocalizedDescriptionKey:
                                            "intent_handler_not_installed: 没有处理 \(targetBundle) 的应用"])
                                    }
                                } else {
                                    handler = NSWorkspace.shared.urlForApplication(toOpen: url)
                                    guard handler != nil else {
                                        throw NSError(domain: "intent", code: 67, userInfo: [NSLocalizedDescriptionKey:
                                            "intent_no_handler: 系统里没有处理 \(url.scheme ?? "该 URL") 的应用"])
                                    }
                                }
                                if let handler {
                                    NSWorkspace.shared.open([url], withApplicationAt: handler, configuration: config, completionHandler: nil)
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["intent": name, "url": urlString, "activates": false, "handler": handler?.lastPathComponent ?? "?"] as [String: Any]])
                            case "lens":
                                // 动作指示器的开关。不传 mode 就是 toggle（参照实现的 CLI 同样先读再翻）。
                                switch args["mode"] as? String ?? args["enabled"] as? String {
                                // ⚠️ 只读的这几个值要**先接住**：否则它们会落进 `default` 把指示器**翻转**掉。
                                // （我用 `mode: "status"` 查状态，每查一次翻一次，读到的 `false` 是自己造成的。）
                                case "status", "report", "get":
                                    reply(fd, ["id": id, "ok": true, "data": ["enabled": lensEnabled, "lastIndicator": lastIndicatorOutcome] as [String: Any]])
                                    return
                                case "on", "true", "1": lensEnabled = true
                                case "off", "false", "0": lensEnabled = false
                                default: lensEnabled.toggle()
                                }
                                if !lensEnabled { DispatchQueue.main.async { lensOverlay.hide() } }
                                reply(fd, ["id": id, "ok": true, "data": ["enabled": lensEnabled, "lastIndicator": lastIndicatorOutcome] as [String: Any]])
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
                                guard axTrusted() else { throw axNotGranted() }
                                let pid = try resolvePid(args)
                                let maxDepth = args["max_depth"] as? Int ?? 20
                                let limit = args["max_elements"] as? Int ?? 300
                                // 在这里定（**闭包外面**）：回执也要用它说明"这个空是过滤出来的、还是本来就没有"。
                                // 参照的默认是 **interactive_only = true**（`--all` 关掉它）——
                                // 默认值也是契约的一部分：调用方不写，就该拿到参照的那个默认。
                                let interactiveOnly = args["interactive_only"] as? Bool ?? true
                                // AX 是跨进程 IPC，卡住的调用无法取消：放到自己的工作线程，
                                // 4 秒内没结果就放弃 AX（截图仍然返回，观察降级而不是挂死）。
                                let collected: ([[String: Any]], [String: AXUIElement], Int, Int) = await withCheckedContinuation { continuation in
                                    DispatchQueue.global(qos: .userInitiated).async {
                                        continuation.resume(returning: collectAccessibility(
                                            pid: pid, maxDepth: maxDepth, limit: limit, timeout: 4.0,
                                            // 参照的默认是 **interactive_only = true**（`--all` 关掉它）。
                                            // 默认值也是契约的一部分：调用方不写就要拿到参照的那个默认。
                                            interactiveOnly: interactiveOnly, windowId: args["window_id"] as? Int))
                                    }
                                }
                                let elements = collected.0
                                let table = collected.1
                                let wakeupAttempts = collected.2
                                let wakeupDurationMs = collected.3
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
                                // ⚠️ 原来这里是 `(try? await screenshot(shotArgs)) ?? [:]` —— **把原因吞掉了**。
                                // 截图失败时调用方只看到 width=0 和一个空字段，**不知道为什么**：
                                // 是没权限？窗口不在了？还是 SCK 自己出错？三种的下一步完全不同。
                                // 参照在同一个位置报 `screenshot_error` + `screen_recording` 两个字段 —— 就是这个道理。
                                let shot = skipShot ? [:] : await captureObservation(timeout: 3, describeError: describeCaptureFailure) {
                                    try await screenshot(shotArgs)
                                }
                                let screenshotError = shot["screenshot_error"] as? String
                                refTables[pid] = table
                                lastObservedPid = pid
                                // 记下截图坐标 → 屏幕坐标的映射，后续像素点击据此换算。
                                if let f = shot["screenFrame"] as? [String: Double],
                                   let sw = shot["width"] as? Int, let sh = shot["height"] as? Int, sw > 0, sh > 0 {
                                    coordMaps[pid] = (Double(sw) / max(1, f["w"] ?? 1), f["x"] ?? 0, f["y"] ?? 0, Double(sw), Double(sh))
                                }
                                var data: [String: Any] = ["pid": Int(pid), "elements": elements]
                                data["bundleId"] = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
                                if let path = shot["path"] { data["screenshot"] = path }
                                // 「为什么没有截图」要说出来，并且**始终**报权限状态 ——
                                // 参照同样在这一个回执里给这两个字段。
                                if let screenshotError { data["screenshot_error"] = screenshotError }
                                data["screen_recording"] = screenTrusted() ? "granted" : "not_granted"
                                // 护栏的账目（参照在这一组里同样上报）：察觉到多少次"被激活"。
                                // 只有记下来，"绝不抢焦点"才是可核查的 —— 否则它只是一个意图。
                                data["observed_activations"] = observedActivations
                                data["tap_disables_recovered"] = await MainActor.run { appshotMonitor.recoveredCount }
                                data["screenshotWidth"] = shot["width"] ?? 0
                                data["screenshotHeight"] = shot["height"] ?? 0
                                // 上报**真实**窗口号：以前这里是 Int(pid)，于是 windowId 一路都是假的。
                                data["windowId"] = (shot["windowId"] as? Int) ?? (args["window_id"] as? Int) ?? windowNumberForApp(Int(pid)) ?? 0
                                // 唤醒的账目：试了几次、花了多久。参照同样上报（wakeupAttempts /
                                // wakeupDurationMs），并在用尽预算仍为空时报 empty_after_wakeup ——
                                // 让调用方能区分"这应用就是没有 AX 树"和"我该再试一次"。
                                if wakeupAttempts > 0 {
                                    data["wakeupAttempts"] = wakeupAttempts
                                    data["wakeupDurationMs"] = wakeupDurationMs
                                    let meaningful = elements.filter { ($0["role"] as? String) != "AXWindow" }
                                    if meaningful.isEmpty {
                                        data["warning"] = "empty_after_wakeup: 重试 \(wakeupAttempts) 次后仍没有可引用的元素（有些应用不提供 AX 树）。用截图里的坐标操作，不要用 ref。"
                                    }
                                }
                                // 过滤开着的时候，「列表为空」不再等于「这应用没有 AX 树」：
                                // 完全可能是有树、只是没有可交互元素。这两件事调用方要做得不一样
                                // （前者放弃用 ref，后者加 `--all` 再看一次），必须分开说。
                                // 与上一次观察比：变没变、变了多少。参照同样上报这两个字段。
                                // 比对用**规范化指纹**（角色/标题/值/几何），不含 ref ——
                                // ref 每次重编，收进去会让"没变"永远判成"变了"。
                                let fingerprintKey = "\(Int(pid)):\(data["windowId"] as? Int ?? 0)"
                                let fresh = elements.map(elementFingerprint)
                                if let previous = lastElementFingerprints[fingerprintKey] {
                                    // 逐位置比对，不是"从头连续相同的长度" ——
                                    // 后者顶部一变就归零，而下面几十条其实没动，那个数会误导。
                                    // （参照这一步的算法读不出来；这里选了**更可解释**的那个：
                                    //   "同一序号上没变的元素有几个"，任何一个调用方都能自己复算。）
                                    let unchanged = zip(previous, fresh).filter { $0 == $1 }.count
                                    // ⚠️ 两个字段必须**同源**：先前 "变没变" 按集合比、
                                    // "几个没变" 按位置比 —— 集合相等但元素换了位置时，
                                    // 会报出 diff=false 而 未变<N 的**自相矛盾**组合
                                    //（这让新加的测试逮到了）。现在都用位置判据，永远自洽。
                                    data["unchanged_element_count"] = unchanged
                                    data["elements_are_diff"] = unchanged < fresh.count
                                } else {
                                    data["elements_are_diff"] = true          // 第一次观察：无从比较，如实说"有差异"
                                    data["unchanged_element_count"] = 0
                                }
                                lastElementFingerprints[fingerprintKey] = fresh
                                data["interactiveOnly"] = interactiveOnly
                                if interactiveOnly, elements.count <= 1, data["warning"] == nil {
                                    data["warning"] = "no_interactive_elements: 这棵树里没有可交互元素（并不代表没有树）。要看完整树就传 interactive_only=false（CLI：--all）。"
                                }
                                if let frame = shot["frame"] { data["windowFrame"] = frame }
                                if let screenFrame = shot["screenFrame"] { data["screenFrame"] = screenFrame }
                                reply(fd, ["id": id, "ok": true, "data": data as [String: Any]])
                            case "click":
                                guard axTrusted() else { throw axNotGranted() }
                                // 参照在这条路上点明了**为什么**要 pid：
                                // "click by pixel requires either `pid` or `bundle` of a running app
                                //  — without a target we'd have to post globally and move the real cursor."
                                // 只说"缺参数"，调用方分不清这是它的调用错、还是我们的策略 —— 把代价说出来。
                                // 顺序有讲究：**先查调用本身完整不完整，再查策略**。
                                // "只给了 x"连点都点不了，是比"没有目标"更前面的事；
                                // 两条都成立时报后一条会让人先去找目标，补完才发现坐标还是缺的。
                                if args["ref"] == nil, args["x"] != nil, args["y"] == nil {
                                    throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "click_pixel_needs_both_xy: 像素点击要同时给 x 和 y（现在只给了 x）"])
                                }
                                if args["ref"] == nil, args["x"] == nil, args["y"] != nil {
                                    throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "click_pixel_needs_both_xy: 像素点击要同时给 x 和 y（现在只给了 y）"])
                                }
                                if args["ref"] == nil, args["x"] != nil, args["pid"] == nil, args["bundle"] == nil {
                                    throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "click_pixel_needs_target: 像素点击需要一个正在运行的目标（pid 或 bundle）。没有目标就只能全局投递，那会**移动用户的真实光标** —— 所以这里不做。"])
                                }
                                // 传了 pid 就用它；没传（`cu click e12`）才反查 ——
                                // 反查的规则是"最近一次观察的 pid 优先"，别让它盖掉调用方明确的指定。
                                let refPid = (args["pid"] as? Int).map { pid_t($0) }
                                if let ref = args["ref"] as? String, let pid = refPid ?? pidForRef(ref) {
                                    // ⚠️ ref 的查找**不能和上面那两个条件并在一起**：
                                    // 并在一起时，"传了 ref 但它过期了"会掉到下面的像素分支，
                                    // 最终报成"需要 ref 或坐标"—— 而调用方明明给了 ref。
                                    // 这违反「一个 guard 只检查一件事」：没传和过期了必须分开报。
                                    guard let element = refTables[pid_t(pid)]?[ref] else {
                                        throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                    }
                                    // 两条路由是两种机制，不是同一件事的两种写法：
                                    // AX 让控件执行它自己的动作（不碰坐标，最可靠）；
                                    // 物理点击合成鼠标事件（能表达双击和右键，但依赖坐标与前台）。
                                    // strategy 让调用方指定用哪条 —— auto 仍按可用性挑。
                                    let strategy = args["strategy"] as? String ?? "auto"
                                    let refButton = mouseButton(args["button"] as? String)
                                    let refClicks = max(1, min(3, args["clicks"] as? Int ?? 1))
                                    let axCannotExpress = refClicks > 1 || refButton != .left

                                    // 投递管线：默认 global（已验证可用）；显式要 window-local 才用它。
                                    // 参照的取向是"不抢焦点优先"，我这边**先要求能送达** ——
                                    // 管线的送达还没测出来，而点击送达是底线。
                                    let wantWindowLocal = (args["pipeline"] as? String) == "window-local"
                                    var clickPipeline = "global"
                                    func physicalAtElement() async -> Bool {
                                        guard let frame = axFrame(element) else { return false }
                                        let point = CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2)
                                        noteActionPoint(args, point, symbol: nil)
                                        await withFocusGuard(pid_t(pid), preserveElementFocus: !foregroundInput) {
                                            clickPipeline = postClick(pid_t(pid), point, button: refButton, clicks: refClicks, preferWindowLocal: wantWindowLocal)
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
                                        reply(fd, ["id": id, "ok": true, "data": ["clicked": ref, "route": "physical", "clicks": refClicks, "clickPipeline": clickPipeline] as [String: Any]] as [String: Any])
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
                                    _ = await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                        postClick(pid, point, button: pixelButton, clicks: pixelClicks)
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["clicked": "@\(Int(x)),\(Int(y))", "clicks": pixelClicks] as [String: Any]] as [String: Any])
                                } else {
                                    // ⚠️ 「一个坐标都没给」和「只给了一半」是两种坏法，下一步也不同
                                    // （补坐标 vs 补**另一个**坐标）。参照在这条路上有两句独立的话：
                                    // `click by pixel requires either pid or bundle…` 与
                                    // `click --pixel requires both x and y`。
                                    // 这条不变量我今天已经写过两次，这是第三次栽在同一处 ——
                                    // 写 guard 时数一下它背后有几种原因。
                                    let hasX = args["x"] != nil, hasY = args["y"] != nil
                                    if hasX || hasY {
                                        throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "click_pixel_needs_both_xy: 像素点击要同时给 x 和 y（现在只有 \(hasX ? "x" : "y")）"])
                                    }
                                    // 给了 ref 却走到这儿 = 它定位不到（过期了、或跨了多个应用）。
                                    // 这和"什么都没给"是两种坏法，下一步也不同 —— 分开报。
                                    if let ref = args["ref"] as? String {
                                        throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "element_ref_not_located: ref \(ref) 不在最近一次观察里（或跨了多个应用，无法唯一定位）—— 先 snap 那个应用再点"])
                                    }
                                    throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "click_needs_ref_or_pixel: 要么给一个来自最近一次观察的 ref，要么给 x/y 坐标"])
                                }
                            case "drag":
                                // AX 没有拖这个动作，只能合成鼠标序列。
                                // 四个坐标并成一句 "requires x1,y1,x2,y2" 时，缺一个的人得自己逐个对 ——
                                // 直接说缺哪个，一次到位。
                                let missingCoords = ["x1", "y1", "x2", "y2"].filter { args[$0] as? Double == nil }
                                guard missingCoords.isEmpty,
                                      let x1 = args["x1"] as? Double, let y1 = args["y1"] as? Double,
                                      let x2 = args["x2"] as? Double, let y2 = args["y2"] as? Double else {
                                    throw NSError(domain: "drag", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "drag_missing_coordinate: 缺 \(missingCoords.joined(separator: "、"))（拖拽需要 x1、y1、x2、y2 四个坐标）"])
                                }
                                let pid = try resolvePid(args)
                                let screenSpace = args["coord_space"] as? String == "screen"
                                let from = screenPoint(pid, x1, y1, screenSpace: screenSpace)
                                let to = screenPoint(pid, x2, y2, screenSpace: screenSpace)
                                await withFocusGuard(pid, preserveElementFocus: !foregroundInput) { postDrag(pid, from: from, to: to) }
                                reply(fd, ["id": id, "ok": true, "data": ["dragged": "@\(Int(x1)),\(Int(y1))→@\(Int(x2)),\(Int(y2))"] as [String: Any]] as [String: Any])
                            case "perform_secondary_action":
                                // 右键 / 打开上下文菜单：优先走 AX 的 ShowMenu，退化成合成右键。
                                let pid = try resolvePid(args)
                                if let ref = args["ref"] as? String {
                                    // 同上：ref 查找要和"有没有给 ref"分开，否则"过期"会报成"没给"。
                                    guard let element = refTables[pid]?[ref] else {
                                        throw NSError(domain: "menu", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "element_ref_not_observed: ref \(ref) 不在 pid \(Int(pid)) 的最近一次观察里，先 snap 一次"])
                                    }
                                    let status = AXUIElementPerformAction(element, kAXShowMenuAction as CFString)
                                    // 两条路都不通时要**说出来**：早先这里没有 else，
                                    // 于是"AX 不认这个菜单、元素又没有坐标"就变成了静默什么都不做。
                                    if status != .success && axFrame(element) == nil {
                                        throw NSError(domain: "menu", code: 65, userInfo: [NSLocalizedDescriptionKey:
                                            "element_has_no_context_menu: 这个元素既不响应 AXShowMenu，也没有可点击的坐标（可能是个容器）。改用它的子元素，或先 snap 看清结构"])
                                    }
                                    if status != .success, let frame = axFrame(element) {
                                        let point = CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2)
                                        await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                            postMouse(pid, .rightMouseDown, point, .right, global: true); postMouse(pid, .rightMouseUp, point, .right, global: true)
                                        }
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["menu": ref] as [String: Any]] as [String: Any])
                                } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
                                    let point = screenPoint(pid, x, y, screenSpace: args["coord_space"] as? String == "screen")
                                    await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                        postMouse(pid, .rightMouseDown, point, .right, global: true); postMouse(pid, .rightMouseUp, point, .right, global: true)
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["menu": "@\(Int(x)),\(Int(y))"] as [String: Any]] as [String: Any])
                                } else { throw NSError(domain: "menu", code: 64, userInfo: [NSLocalizedDescriptionKey: "menu_needs_ref_or_pixel: 要么给一个来自最近一次观察的 ref，要么给 x/y 坐标"]) }
                            case "type":
                                // 元素级文本写入：直接改控件的 AXValue。
                                //
                                // 这是**唯一**一条不需要键盘焦点的输入路径 —— 自绘输入框
                                // （网易云那类）收不到合成按键，但控件自己的 AXValue 是可写的。
                                // 三种模式，对应参照的三条路径（"appending to AXValue" /
                                // "inserting at selection" / 直接写值）：
                                //   replace（默认）· append · insert（在选区处插入，空选区即光标处）
                                // insert 走 kAXSelectedTextAttribute —— 它替换的是**选区**，
                                // 而空选区就是一个光标位置，于是等价于在光标处插入。
                                // 这也正是 `type_text` 三级降级里够不到的"第一级 AX 插入"。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let text = args["text"] as? String else {
                                    // 四条合并成一句「requires ref and value」会让调用方无从下手：
                                    // 是没传、还是 ref 属于上一次观察、还是这个控件不可写？
                                    // 分开报，才不至于让人对着同一句话猜。
                                    throw NSError(domain: "type", code: 64, userInfo: [NSLocalizedDescriptionKey: "type_missing_argument: 需要 ref、pid 和 text"])
                                }
                                guard let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "type", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                }
                                let mode = args["mode"] as? String ?? ((args["append"] as? Bool ?? false) ? "append" : "replace")
                                if mode == "insert" {
                                    let insertStatus = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
                                    guard insertStatus == .success else {
                                        throw NSError(domain: "type", code: 68, userInfo: [NSLocalizedDescriptionKey:
                                            "element_selection_not_writable: 这个控件不接受在选区处插入。先用 select_text 把光标放到位置，或改用 mode=replace/append"])
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["inserted": text.count, "mode": "insert", "route": "ax"] as [String: Any]])
                                    return
                                }
                                let append = mode == "append"
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
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let value = args["value"] else {
                                    throw NSError(domain: "value", code: 64, userInfo: [NSLocalizedDescriptionKey: "set_value_missing_argument: 需要 ref、pid 和 value"])
                                }
                                guard let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "value", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                }
                                let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
                                guard status == .success else {
                                    throw NSError(domain: "value", code: 1, userInfo: [NSLocalizedDescriptionKey: "element_value_not_settable: 这个控件的 AXValue 不可写（滑杆/步进器/输入框通常可以）。ref 可能指向容器，改用它的子元素"])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["ref": ref, "value": "\(value)"] as [String: Any]] as [String: Any])
                            case "select_text":
                                // 选中一段文字，或在没有 text 时把光标放到 range 起点。
                                guard let ref = args["ref"] as? String, let pid = args["pid"] as? Int else {
                                    throw NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: "select_text_missing_argument: 需要 ref 和 pid"])
                                }
                                guard let element = refTables[pid_t(pid)]?[ref] else {
                                    throw NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: ref \(ref) 不在 pid \(pid) 的最近一次观察里，先 snap 一次"])
                                }
                                if let text = args["text"] as? String {
                                    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
                                    guard status == .success else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "element_selection_not_settable: 这个控件不接受设置选区/选中文本（可能不是文本控件）"])
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["selected": text] as [String: Any]] as [String: Any])
                                } else if let location = args["location"] as? Int {
                                    let length = args["length"] as? Int ?? 0
                                    var range = CFRange(location: location, length: length)
                                    guard let axRange = AXValueCreate(.cfRange, &range) else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "element_range_not_settable: 读不到也写不进这个控件的选区范围（AXSelectedTextRange）"])
                                    }
                                    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
                                    guard status == .success else {
                                        throw NSError(domain: "select", code: 1, userInfo: [NSLocalizedDescriptionKey: "element_range_not_settable: 读不到也写不进这个控件的选区范围（AXSelectedTextRange）"])
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["cursor": location] as [String: Any]] as [String: Any])
                                } else {
                                    throw NSError(domain: "select", code: 64, userInfo: [NSLocalizedDescriptionKey: "select_text requires text or location"])
                                }
                            case "type_text":
                                let pid = try resolvePid(args)
                                let text = args["text"] as? String ?? ""
                                // 参照把三条输入路径**暴露成参数**：`input_method must be
                                // auto|physical|unicode|ax`，而且 `input_method=ax requires ref`
                                // —— 也就是"AX 那条要带元素引用"，正是 `type` 动词在做的事。
                                // 本实现原先只有 unicode 一条，选择权在调用方手里才叫能力。
                                var method = args["input_method"] as? String ?? "auto"
                                var plannedStrokes: [PhysicalStroke]?
                                if method == "auto" {
                                    var writable = DarwinBoolean(false)
                                    if let ref = args["ref"] as? String {
                                        guard let element = refTables[pid]?[ref] else {
                                            throw NSError(domain: "type_text", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: observe again before typing"])
                                        }
                                        _ = AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &writable)
                                    }
                                    if !writable.boolValue { plannedStrokes = try? await MainActor.run { try PhysicalInput.currentLayoutPlan(text) } }
                                    method = PhysicalInput.autoRoute(axWritable: writable.boolValue, physicalAvailable: plannedStrokes != nil)
                                }
                                switch method {
                                case "unicode":
                                    try await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                        try postUnicode(pid, text, windowID: foregroundInput ? args["window_id"] as? Int : nil)
                                    }
                                case "ax":
                                    // AX 那条不需要键盘焦点，但需要 ref —— 没有就明说。
                                    guard let ref = args["ref"] as? String else {
                                        throw NSError(domain: "type_text", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "input_method_requires_ref: input_method=ax 需要 ref（AX 写入是按元素走的，不是按焦点）。要按焦点输入就用 auto 或 unicode。"])
                                    }
                                    guard let element = refTables[pid]?[ref] else {
                                        throw NSError(domain: "type_text", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                            "element_ref_not_observed: ref \(ref) 不在 pid \(Int(pid)) 的最近一次观察里，先 snap 一次"])
                                    }
                                    let writeStatus = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
                                    guard writeStatus == .success else {
                                        throw NSError(domain: "type_text", code: 68, userInfo: [NSLocalizedDescriptionKey:
                                            "element_selection_not_writable: 这个控件不接受 AX 写入。改用 input_method=unicode。"])
                                    }
                                case "physical":
                                    let strokes: [PhysicalStroke]
                                    if let plannedStrokes { strokes = plannedStrokes }
                                    else { strokes = try await MainActor.run { try PhysicalInput.currentLayoutPlan(text) } }
                                    try await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                        for stroke in strokes {
                                            try postKey(pid, keyCode: stroke.keyCode, flags: stroke.flags, global: foregroundInput, windowID: foregroundInput ? args["window_id"] as? Int : nil)
                                        }
                                    }
                                default:
                                    throw NSError(domain: "type_text", code: 64, userInfo: [NSLocalizedDescriptionKey:
                                        "unknown_input_method: \"\(method)\"。可用：auto | physical | unicode | ax"])
                                }
                                noteActionPoint(args, nil, symbol: "keyboard")
                                var typed: [String: Any] = ["typed": text.count, "inputMethod": method]
                                if method != "ax", let warning = keyDeliveryWarning(pid) {
                                    typed["warning"] = warning
                                    // 参照在这里还单独给一个 `verification_note`：
                                    // "sent, but could not confirm it landed"。
                                    // 它比 warning 准 —— warning 读起来像"出错了"，
                                    // 而这种情况是"**不知道**有没有落地"，agent 该据此去核实，
                                    // 而不是据此认定失败。
                                    typed["verification_note"] = "sent, but could not confirm it landed"
                                }
                                if let guardWarning = focusGuardWarning() { typed["focusGuardWarning"] = guardWarning }
                                reply(fd, ["id": id, "ok": true, "data": typed])
                            case "press_key":
                                let pid = try resolvePid(args)
                                let combo = args["key"] as? String ?? ""
                                guard let (keyCode, flags) = parseKeyCombo(combo) else { throw NSError(domain: "key", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown_key"]) }
                                let global = foregroundInput || (args["global"] as? Bool ?? false)
                                try await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
                                    try postKey(pid, keyCode: keyCode, flags: flags, global: global, windowID: foregroundInput ? args["window_id"] as? Int : nil)
                                }
                                var pressed: [String: Any] = ["pressed": combo, "global": global]
                                if let warning = keyDeliveryWarning(pid) { pressed["warning"] = warning }
                                reply(fd, ["id": id, "ok": true, "data": pressed])
                            case "scroll":
                                // 参照的 scroll 可以**只给 ref**（`cu scroll <ref> <dir>`，不带 pid），
                                // 所以先看 ref 能不能唯一定出一个 pid。
                                // ⚠️ 这两行最早被我挂到了 `raise` 上：锚点 `let pid = try resolvePid(args)`
                                // 在文件里出现多次，`replace(..., 1)` 静默打中了第一个，**而且编译通过、
                                // 看着也合理** —— 所以改完必须回读落点。
                                let scrollRefOnlyPid: pid_t? = (args["ref"] as? String).flatMap { pidForRef($0) }
                                let pid = try resolvePid(args, fallbackPid: scrollRefOnlyPid)
                                let direction = args["direction"] as? String ?? "down"
                                let amount = args["amount"] as? Int ?? 3
                                let route = args["route"] as? String ?? "auto"
                                // 滚轮要的是自然滚动转换后的方向；AX 写滚动条位置，用语义方向。
                                let wheelDirection = args["wheel_direction"] as? String ?? direction
                                // 先试 AX —— 原生滚动区只有这一条路能走通；不行再退回滚轮，
                                // 那才是网页内容（不暴露 AXScrollBar）唯一可用的路由。
                                // pages 是语义单位（参照实现用 --pages），amount 是滚轮的行数。
                                // 显式取两种数值类型：JSON 里的 1 既可能是 Int 也可能是 Double。
                                // 滚动同样要有指示器：参照在这条路上有专门的 `alma.lens.scrollBadge`
                                // 角标（"这一次滚了什么"）。原先 scroll 一个落点都不记 —— 于是它
                                // 既不亮指示器，也吃不到 `--no-cursor`。落点取**窗口中心**：
                                // 滚动是窗口级的动作，没有单点，取中心最能说明"它正在动这个窗口"。
                                let scrollPoint: CGPoint? = windowScreenBounds(pid: Int(pid)).map {
                                    CGPoint(x: $0["x"]! + $0["w"]! / 2, y: $0["y"]! + $0["h"]! / 2)
                                }
                                noteActionPoint(args, scrollPoint, symbol: "scroll")
                                let pagesArg = (args["pages"] as? Double) ?? (args["pages"] as? Int).map(Double.init)
                                // 参照的 scroll 是 `scroll <ref> <up|down|…>` —— 目标由 **ref** 指定，
                                // 而不是只给 pid、让守护进程自己猜哪个滚动区。给了 ref 就按 ref 走。
                                let refArea: AXUIElement? = (args["ref"] as? String).flatMap { refTables[pid]?[$0] }
                                var data = route == "wheel" ? nil : await withFocusGuard(pid, preserveElementFocus: !foregroundInput) { axScroll(pid, direction: direction, notches: amount, pages: pagesArg, refArea: refArea) }
                                if data == nil && route != "ax" {
                                    await withFocusGuard(pid, preserveElementFocus: !foregroundInput) {
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
// 镜像窗需要 AppKit 分发窗口事件，普通 RunLoop 不负责处理拖动与关闭。
NSApp.run()
