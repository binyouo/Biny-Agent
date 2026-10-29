import Foundation

final class AccessibilityEnablement {
    private final class Entry {
        let lock = NSLock()
        var holders = 0
        var active = 0
        var enhanced = false
        var manual = false
    }
    private let lock = NSLock()
    private var entries: [Int32: Entry] = [:]

    func withEnabled<T>(pid: Int32, read: (String) -> Bool?, write: (String, Bool) -> Void, body: () throws -> T) rethrows -> T {
        lock.lock()
        let entry = entries[pid] ?? Entry()
        entries[pid] = entry
        entry.holders += 1
        lock.unlock()

        entry.lock.lock()
        if entry.active == 0 {
            entry.enhanced = read("AXEnhancedUserInterface") ?? false
            entry.manual = read("AXManualAccessibility") ?? false
            write("AXEnhancedUserInterface", true)
            write("AXManualAccessibility", true)
        }
        entry.active += 1
        entry.lock.unlock()
        defer {
            entry.lock.lock()
            entry.active -= 1
            if entry.active == 0 {
                write("AXEnhancedUserInterface", entry.enhanced)
                write("AXManualAccessibility", entry.manual)
            }
            entry.lock.unlock()
            lock.lock()
            entry.holders -= 1
            if entry.holders == 0 { entries.removeValue(forKey: pid) }
            lock.unlock()
        }
        return try body()
    }
}
