import Foundation
import CoreGraphics

final class ActionCursor {
    private struct Entry {
        let pid: Int
        let windowID: Int
        let owner: String
        let point: CGPoint
        let updatedAt: TimeInterval
    }
    private let lock = NSLock()
    private var entry: Entry?
    private let now: () -> TimeInterval
    init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.now = now }

    func mark(pid: Int, windowID: Int, owner: String, point: CGPoint?) -> CGPoint? {
        lock.lock(); defer { lock.unlock() }
        let time = now()
        let previous = entry.flatMap { value in
            value.pid == pid && value.windowID == windowID && value.owner == owner && time - value.updatedAt <= 8 ? value.point : nil
        }
        guard let point = point ?? previous else { return nil }
        entry = Entry(pid: pid, windowID: windowID, owner: owner, point: point, updatedAt: time)
        return point
    }

    func normalized(pid: Int, windowID: Int, frame: CGRect) -> [String: Double]? {
        lock.lock(); defer { lock.unlock() }
        guard let value = entry, value.pid == pid, value.windowID == windowID else { return nil }
        let remaining = 8 - (now() - value.updatedAt)
        guard remaining >= 0, frame.width > 0, frame.height > 0,
              frame.contains(value.point) else { return nil }
        return ["x": (value.point.x - frame.minX) / frame.width, "y": (value.point.y - frame.minY) / frame.height, "remainingMs": remaining * 1000]
    }
}
