import Foundation

struct ComputerObservation<Element> {
    let id: String
    let owner: String
    let pid: Int32
    let windowID: Int
    let createdAt: TimeInterval
    let elements: [String: Element]
    let geometry: [String: Double]
}

/// 观察资料按调用方和窗口保存；输入取走一次性凭据，持有不可变副本。
final class ComputerObservations<Element> {
    private let lock = NSLock()
    private var entries: [String: ComputerObservation<Element>] = [:]
    private let now: () -> TimeInterval
    private let limit: Int
    init(limit: Int = 64, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.limit = limit; self.now = now
    }
    private func prune() { entries = entries.filter { now() - $0.value.createdAt < 60 } }
    func save(id: String, owner: String, pid: Int32, windowID: Int, elements: [String: Element], geometry: [String: Double]) {
        lock.lock(); defer { lock.unlock() }
        prune()
        entries = entries.filter { !($0.value.owner == owner && $0.value.pid == pid && $0.value.windowID == windowID) }
        if entries.count >= limit, let oldest = entries.min(by: { $0.value.createdAt < $1.value.createdAt }) { entries.removeValue(forKey: oldest.key) }
        entries[id] = ComputerObservation(id: id, owner: owner, pid: pid, windowID: windowID, createdAt: now(), elements: elements, geometry: geometry)
    }
    func take(id: String, owner: String, pid: Int32, windowID: Int) throws -> ComputerObservation<Element> {
        lock.lock(); defer { lock.unlock() }
        prune()
        guard let value = entries[id], value.owner == owner, value.pid == pid, value.windowID == windowID else {
            throw NSError(domain: "observation", code: 64, userInfo: [NSLocalizedDescriptionKey: "observation_invalid: 请重新观察目标窗口"])
        }
        entries.removeValue(forKey: id)
        return value
    }
    // 用户直接执行的命令行保持最近观察语义，与模型客户端的资料分开保存。
    func direct(pid: Int32?) -> ComputerObservation<Element>? {
        lock.lock(); defer { lock.unlock() }
        prune()
        return entries.values.filter { $0.owner == "direct-cli" && (pid == nil || $0.pid == pid) }.max { $0.createdAt < $1.createdAt }
    }
}
