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
func postMouse(_ pid: pid_t, _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.postToPid(pid)
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


/// 在独立线程采集 AX 树，硬超时后放弃（卡住的 AX 调用无法取消，但也不会拖住调用方）。
func collectAccessibility(pid: pid_t, maxDepth: Int, limit: Int, timeout: Double) async -> ([[String: Any]], [String: AXUIElement]) {
    await withCheckedContinuation { continuation in
        let state = NSLock()
        var finished = false
        var result: ([[String: Any]], [String: AXUIElement]) = ([], [:])
        func finish(_ value: ([[String: Any]], [String: AXUIElement])) {
            state.lock(); defer { state.unlock() }
            if finished { return }
            finished = true
            continuation.resume(returning: value)
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let app = axApp(pid)
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            var local: [[String: Any]] = []
            var localTable: [String: AXUIElement] = [:]
            var counter = 0
            if let windows = axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement], let main = windows.first {
                if let frame = axFrame(main) { local.append(["ref": "e0", "role": "AXWindow", "frame": frame]) }
                localTable["e0"] = main
                axWalk(main, depth: 0, maxDepth: maxDepth, limit: limit, counter: &counter, table: &localTable, out: &local, deadline: Date().addingTimeInterval(2))
            }
            finish((local, localTable))
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(([], [:])) }
        _ = result
        _ = state
    }
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
        // 只保留目标 app 的窗口：除它之外的应用全部排除。
        let others = content.applications.filter { Int($0.processID) != pid }
        let filter = SCContentFilter(display: display, excludingApplications: others, exceptingWindows: [])
        let rect = filter.contentRect
        // 截图尺寸必须与窗口内容区一致，否则像素坐标无法换算回屏幕点。
        let width = min(Int(rect.width), max(1, parameters["max_width"] as? Int ?? 2560))
        config.width = width
        config.height = max(1, Int((rect.height * CGFloat(width) / max(1, rect.width)).rounded()))
        // 窗口在屏幕上的真实位置（CGWindowList 的坐标就是 CGEvent 用的屏幕点）。
        let contentFrame: [String: Double] = screenBounds ?? ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "w": Double(rect.width), "h": Double(rect.height)]
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: parameters["quality"] as? Double ?? 0.55]) else { throw NSError(domain: "capture", code: 2) }
        try data.write(to: URL(fileURLWithPath: output), options: .atomic)
        return ["path": output, "width": config.width, "height": config.height,
                "screenFrame": contentFrame, "frame": contentFrame]
    }
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw NSError(domain: "capture", code: 1) }
    let width = min(display.width, max(1, parameters["max_width"] as? Int ?? 2560))
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
                            case "doctor":
                                reply(fd, ["id": id, "ok": true, "data": [
                                    "accessibility": axTrusted() ? "granted" : "denied",
                                    "screenRecording": screenTrusted() ? "granted" : "denied",
                                    "version": "native-1",
                                    "uptime": Int(Date().timeIntervalSince(startedAt)),
                                ] as [String: Any]])
                            case "list_apps":
                                var apps: [[String: Any]] = []
                                for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
                                    apps.append([
                                        "pid": Int(app.processIdentifier),
                                        "bundleId": app.bundleIdentifier ?? "",
                                        "name": app.localizedName ?? "",
                                        "running": true,
                                    ])
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["apps": apps] as [String: Any]])
                            case "get_app_state":
                                guard axTrusted() else { throw NSError(domain: "ax", code: 1, userInfo: [NSLocalizedDescriptionKey: "ax_not_granted"]) }
                                let pid = try resolvePid(args)
                                let maxDepth = args["max_depth"] as? Int ?? 20
                                let limit = args["max_elements"] as? Int ?? 300
                                // AX 是跨进程 IPC，卡住的调用无法从 Swift 并发里取消：
                                // 用独立队列 + 信号量做真正的硬超时，超时就放弃 AX（截图仍返回）。
                                let collected = await collectAccessibility(pid: pid, maxDepth: maxDepth, limit: limit, timeout: 4.0)
                                let elements = collected.0
                                let table = collected.1
                                var shotArgs: [String: Any] = ["out": args["out"] ?? "/tmp/biny-cu-state-\(Int(Date().timeIntervalSince1970 * 1000)).jpg", "pid": Int(pid)]
                                if let maxWidth = args["max_width"] { shotArgs["max_width"] = maxWidth }
                                // 截图同样可能挂在无响应的窗口上：限时 3 秒，超时就返回不带图的观察。
                                let shot: [String: Any] = await withTaskGroup(of: [String: Any]?.self) { group in
                                    group.addTask { try? await screenshot(shotArgs) }
                                    group.addTask { try? await Task.sleep(nanoseconds: 3_000_000_000); return nil }
                                    let first = await group.next() ?? nil
                                    group.cancelAll()
                                    return first ?? [:]
                                }
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
                                data["windowId"] = Int(pid)
                                if let frame = shot["frame"] { data["windowFrame"] = frame }
                                if let screenFrame = shot["screenFrame"] { data["screenFrame"] = screenFrame }
                                reply(fd, ["id": id, "ok": true, "data": data as [String: Any]])
                            case "click":
                                guard axTrusted() else { throw NSError(domain: "ax", code: 1, userInfo: [NSLocalizedDescriptionKey: "ax_not_granted"]) }
                                if let ref = args["ref"] as? String, let pid = args["pid"] as? Int, let element = refTables[pid_t(pid)]?[ref] {
                                    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
                                    if status != .success {
                                        if let frame = axFrame(element) {
                                            let point = CGPoint(x: frame["x"]! + frame["w"]!/2, y: frame["y"]! + frame["h"]!/2)
                                            postMouse(pid_t(pid), .leftMouseDown, point); postMouse(pid_t(pid), .leftMouseUp, point)
                                        }
                                    }
                                    reply(fd, ["id": id, "ok": true, "data": ["clicked": ref] as [String: Any]] as [String: Any])
                                } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
                                    let pid = try resolvePid(args)
                                    // 像素坐标为截图坐标：按最近一次快照的映射换算回屏幕点。
                                    var sx = x, sy = y
                                    if args["coord_space"] as? String != "screen", let m = coordMaps[pid] {
                                        sx = m.ox + x / m.scale
                                        sy = m.oy + y / m.scale
                                    }
                                    let point = CGPoint(x: sx, y: sy)
                                    postMouse(pid, .leftMouseDown, point); postMouse(pid, .leftMouseUp, point)
                                    reply(fd, ["id": id, "ok": true, "data": ["clicked": "@\(Int(x)),\(Int(y))"] as [String: Any]] as [String: Any])
                                } else { throw NSError(domain: "click", code: 64, userInfo: [NSLocalizedDescriptionKey: "ref_stale"]) }
                            case "type_text":
                                let pid = try resolvePid(args)
                                let text = args["text"] as? String ?? ""
                                postUnicode(pid, text)
                                reply(fd, ["id": id, "ok": true, "data": ["typed": text.count] as [String: Any]] as [String: Any])
                            case "press_key":
                                let pid = try resolvePid(args)
                                let combo = args["key"] as? String ?? ""
                                guard let (keyCode, flags) = parseKeyCombo(combo) else { throw NSError(domain: "key", code: 64, userInfo: [NSLocalizedDescriptionKey: "unknown_key"]) }
                                postKey(pid, keyCode: keyCode, flags: flags)
                                reply(fd, ["id": id, "ok": true, "data": ["pressed": combo] as [String: Any]] as [String: Any])
                            case "scroll":
                                let pid = try resolvePid(args)
                                let direction = args["direction"] as? String ?? "down"
                                let amount = args["amount"] as? Int ?? 3
                                let (axis, sign): (CGScrollEventUnit, Int32) = {
                                    switch direction {
                                    case "up": return (.line, Int32(amount))
                                    case "down": return (.line, Int32(-amount))
                                    case "left": return (.line, Int32(amount))
                                    default: return (.line, Int32(-amount))
                                    }
                                }()
                                if let event = CGEvent(scrollWheelEvent2Source: nil, units: CGScrollEventUnit(rawValue: axis.rawValue)!, wheelCount: 1, wheel1: (direction == "up" || direction == "down") ? sign : 0, wheel2: (direction == "left" || direction == "right") ? sign : 0, wheel3: 0) {
                                    event.postToPid(pid)
                                }
                                reply(fd, ["id": id, "ok": true, "data": ["scrolled": direction] as [String: Any]] as [String: Any])
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
RunLoop.main.run()
