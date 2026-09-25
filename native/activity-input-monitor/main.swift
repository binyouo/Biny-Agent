// 独立输入监听进程，只输出输入、应用焦点、锁屏与权限事件，不执行截图或 OCR。
import Foundation
import AppKit
import ApplicationServices

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
}
if CommandLine.arguments.contains("--request-permission") {
    _ = CGRequestScreenCaptureAccess(); exit(0)
}
var settings: [String: Any] = [:]
var monitors: [Any] = []
var observers: [NSObjectProtocol] = []
var locked = false
var statusTimer: Timer?
func timestamp() -> String { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return format.string(from: Date()) }
func context() -> [String: Any] {
    let app = NSWorkspace.shared.frontmostApplication
    var result: [String: Any] = [:]
    if let name = app?.localizedName { result["application"] = name }
    if let bundle = app?.bundleIdentifier { result["bundleId"] = bundle }
    return result
}
func event(_ kind: String, _ values: [String: Any] = [:]) {
    var value = context()
    let sensitive = settings["sensitiveApplications"] as? [String] ?? []
    if let bundle = value["bundleId"] as? String, sensitive.contains(bundle) {
        value.removeValue(forKey: "windowTitle")
        value["fallbackReason"] = "sensitive_app"
    } else { value.merge(values) { _, new in new } }
    value["type"] = "event"; value["eventType"] = kind; value["occurredAt"] = timestamp()
    emit(value)
}
func status() {
    var value = context()
    value["currentApplication"] = value.removeValue(forKey: "application")
    value["type"] = "status"; value["status"] = "running"
    value["screenRecordingGranted"] = CGPreflightScreenCaptureAccess()
    value["accessibilityGranted"] = AXIsProcessTrusted()
    value["screenLocked"] = locked
    emit(value)
}
func start() {
    monitors.forEach { NSEvent.removeMonitor($0) }; monitors = []
    observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0); DistributedNotificationCenter.default().removeObserver($0) }; observers = []
    statusTimer?.invalidate()
    status()
    if settings["inputMonitoringEnabled"] as? Bool != false {
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { input in
            guard !locked else { return }
            if input.type == .keyDown { event("keypress", ["keyCode": Int(input.keyCode), "keyModifiers": input.modifierFlags.rawValue, "inputEventCount": 1]) }
            else { event("click", ["mouseX": input.locationInWindow.x, "mouseY": input.locationInWindow.y, "mouseButton": String(input.buttonNumber), "inputEventCount": 1]) }
        }) { monitors.append(monitor) }
    }
    observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in event("app_focus") })
    observers.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in locked = true; event("lock"); status() })
    observers.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in locked = false; event("unlock"); status() })
    statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in status() }
    event("app_focus")
}
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            switch command["type"] as? String {
            case "start": settings = command["settings"] as? [String: Any] ?? [:]; start()
            case "stop": exit(0)
            case "request_permission":
                if command["permission"] as? String == "screen-recording" { _ = CGRequestScreenCaptureAccess() }
                else { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
                status()
            default: break
            }
        }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
