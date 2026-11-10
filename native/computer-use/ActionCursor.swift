import Foundation
import CoreGraphics

final class ActionCursor {
    static let lifetime: TimeInterval = 8
    enum Action: String { case click, drag, type, scroll }
    struct Snapshot {
        let point: CGPoint
        let remainingMs: Double
        let eventID: Int
        let action: Action
        let symbol: String?
        var payload: [String: Any] {
            var value: [String: Any] = ["x": point.x, "y": point.y, "remainingMs": remainingMs, "eventId": eventID, "action": action.rawValue]
            if let symbol { value["symbol"] = symbol }
            return value
        }
    }
    private struct Entry {
        let pid: Int
        let windowID: Int
        let owner: String
        let point: CGPoint
        let updatedAt: TimeInterval
        let eventID: Int
        let action: Action
        let symbol: String?
    }
    private let lock = NSLock()
    private var entry: Entry?
    private var eventID = 0
    private let now: () -> TimeInterval
    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.now = now }

    func mark(pid: Int, windowID: Int, owner: String, point: CGPoint?, action: Action = .click, symbol: String? = nil) -> CGPoint? {
        lock.lock(); defer { lock.unlock() }
        let time = now()
        let previous = entry.flatMap { value in
            value.pid == pid && value.windowID == windowID && value.owner == owner && time - value.updatedAt <= Self.lifetime ? value.point : nil
        }
        guard let point = point ?? previous else { return nil }
        eventID += 1
        entry = Entry(pid: pid, windowID: windowID, owner: owner, point: point, updatedAt: time, eventID: eventID, action: action, symbol: symbol)
        return point
    }

    func normalized(pid: Int, windowID: Int, frame: CGRect) -> [String: Double]? {
        guard let value = snapshot(pid: pid, windowID: windowID, frame: frame) else { return nil }
        return ["x": value.point.x, "y": value.point.y, "remainingMs": value.remainingMs]
    }

    func clear(pid: Int? = nil, windowID: Int? = nil) {
        lock.lock(); defer { lock.unlock() }
        if let pid, entry?.pid != pid { return }
        if let windowID, entry?.windowID != windowID { return }
        entry = nil
    }

    func snapshot(pid: Int, windowID: Int, frame: CGRect) -> Snapshot? {
        lock.lock(); defer { lock.unlock() }
        guard let value = entry, value.pid == pid, value.windowID == windowID else { return nil }
        let remaining = Self.lifetime - (now() - value.updatedAt)
        guard remaining >= 0, frame.width > 0, frame.height > 0,
              frame.contains(value.point) else { return nil }
        return Snapshot(point: CGPoint(x: (value.point.x - frame.minX) / frame.width, y: (value.point.y - frame.minY) / frame.height),
                        remainingMs: remaining * 1000, eventID: value.eventID, action: value.action, symbol: value.symbol)
    }
}

enum ActionCursorGeometry {
    static func windowVisible(at point: CGPoint, pid: Int, windowID: Int, windows: [[String: Any]], ignoringPID: Int, dockPID: Int? = nil, displays: [CGRect] = []) -> Bool {
        for window in windows {
            guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner != ignoringPID,
                  (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0,
                  let values = window[kCGWindowBounds as String] as? [String: Any],
                  let x = values["X"] as? NSNumber, let y = values["Y"] as? NSNumber,
                  let width = values["Width"] as? NSNumber, let height = values["Height"] as? NSNumber else { continue }
            let frame = CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
            guard frame.contains(point) else { continue }
            // Dock 的整屏背景记录不表示整屏被遮挡；实际 Dock 栏和其它窗口仍参与判定。
            if owner == dockPID, window[kCGWindowLayer as String] as? Int == Int(CGWindowLevelForKey(.dockWindow)), displays.contains(frame) { continue }
            return owner == pid && (window[kCGWindowNumber as String] as? Int == windowID || (window[kCGWindowLayer as String] as? Int ?? 0) > 0)
        }
        return false
    }

    // CG 屏幕坐标以主显示器左上为原点，AppKit 的各屏幕 frame 以左下为原点。
    static func screenPoint(_ point: CGPoint, screen: CGRect, desktopTop: CGFloat) -> CGPoint? {
        let appKitPoint = CGPoint(x: point.x, y: desktopTop - point.y)
        guard screen.contains(appKitPoint) else { return nil }
        return CGPoint(x: point.x - screen.minX, y: screen.maxY - appKitPoint.y)
    }

    static func imagePoint(_ point: CGPoint, image: CGSize, bounds: CGRect) -> CGPoint? {
        guard image.width > 0, image.height > 0, bounds.width > 0, bounds.height > 0,
              point.x >= 0, point.x <= 1, point.y >= 0, point.y <= 1 else { return nil }
        let scale = min(bounds.width / image.width, bounds.height / image.height)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGPoint(x: bounds.minX + (bounds.width - size.width) / 2 + point.x * size.width,
                       y: bounds.minY + (bounds.height - size.height) / 2 + point.y * size.height)
    }
}
