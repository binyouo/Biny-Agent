import Foundation

/// 将一次遍历的临时引用映射到同一调用方和窗口内的元素身份。
final class StableElementRefs<Element> {
    private struct Key: Hashable { let owner: String; let pid: Int32; let windowID: Int }
    private struct State {
        var entries: [String: Element]
        var namespace: String
        var next: Int
        var updatedAt: TimeInterval
    }
    private let lock = NSLock()
    private var states: [Key: State] = [:]
    private let limit: Int
    private let now: () -> TimeInterval
    init(limit: Int = 64, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.limit = limit; self.now = now
    }

    func assign(owner: String, pid: Int32, windowID: Int, elements: [String: Element], hash: (Element) -> Int, equals: (Element, Element) -> Bool) -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        let time = now()
        states = states.filter { time - $0.value.updatedAt < 60 }
        let key = Key(owner: owner, pid: pid, windowID: windowID)
        let previous = states[key]
        if previous == nil, states.count >= limit, let oldest = states.min(by: { $0.value.updatedAt < $1.value.updatedAt }) { states.removeValue(forKey: oldest.key) }
        var oldBuckets: [Int: [(String, Element)]] = [:]
        for (ref, element) in previous?.entries ?? [:] { oldBuckets[hash(element), default: []].append((ref, element)) }
        var newBuckets: [Int: [Element]] = [:]
        for element in elements.values { newBuckets[hash(element), default: []].append(element) }
        var next = previous?.next ?? 0
        let namespace = previous?.namespace ?? String(UUID().uuidString.prefix(8))
        var assigned: [String: String] = [:]
        var stable: [String: Element] = [:]
        let keys = elements.keys.sorted {
            let lhs = Int($0.dropFirst()) ?? Int.max, rhs = Int($1.dropFirst()) ?? Int.max
            return lhs == rhs ? $0 < $1 : lhs < rhs
        }
        for ref in keys {
            guard let element = elements[ref] else { continue }
            let keyHash = hash(element)
            let oldMatches = (oldBuckets[keyHash] ?? []).filter { equals($0.1, element) }
            let newMatches = (newBuckets[keyHash] ?? []).filter { equals($0, element) }
            let result: String
            if oldMatches.count == 1 && newMatches.count == 1 {
                result = oldMatches[0].0
            } else {
                result = "e\(namespace)-\(next)"; next += 1
            }
            assigned[ref] = result
            stable[result] = element
        }
        states[key] = State(entries: stable, namespace: namespace, next: next, updatedAt: time)
        return assigned
    }
}
