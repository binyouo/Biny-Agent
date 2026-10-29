import Foundation

private func observationFingerprint(_ element: [String: Any]) -> String {
    var fields = ["role", "subrole", "title", "description", "role_description", "value", "focused", "enabled", "selected", "actions", "children_count"].map {
        element[$0].map { String(describing: $0) } ?? ""
    }
    let frame = element["frame"] as? [String: Double]
    fields.append(contentsOf: ["x", "y", "w", "h"].map { frame?[$0].map { String($0) } ?? "" })
    return fields.map { "\($0.utf8.count):\($0)" }.joined()
}

final class ObservationDiffStore {
    private struct Key: Hashable { let owner: String; let pid: Int32; let windowID: Int }
    private struct State { let fingerprints: [String]; let at: TimeInterval }
    private let lock = NSLock()
    private var states: [Key: State] = [:]
    private let limit: Int
    private let now: () -> TimeInterval
    init(limit: Int = 64, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.limit = limit; self.now = now
    }
    func compare(owner: String, pid: Int32, windowID: Int, elements: [[String: Any]]) -> (changed: Bool, unchanged: Int) {
        let fresh = elements.map(observationFingerprint)
        lock.lock(); defer { lock.unlock() }
        let time = now()
        states = states.filter { time - $0.value.at < 60 }
        let key = Key(owner: owner, pid: pid, windowID: windowID)
        let previous = states[key]?.fingerprints
        if previous == nil, states.count >= limit, let oldest = states.min(by: { $0.value.at < $1.value.at }) { states.removeValue(forKey: oldest.key) }
        let unchanged = previous.map { zip($0, fresh).filter { $0 == $1 }.count } ?? 0
        let changed = previous.map { $0.count != fresh.count || unchanged != fresh.count } ?? true
        states[key] = State(fingerprints: fresh, at: time)
        return (changed, unchanged)
    }
}
