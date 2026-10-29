import Foundation
import ApplicationServices
import CoreGraphics

func observationFrame(position: CFTypeRef?, size: CFTypeRef?) -> [String: Double]? {
    guard let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { return nil }
    return ["x": Double(point.x), "y": Double(point.y), "w": Double(dimensions.width), "h": Double(dimensions.height)]
}

func observationElementVisible(role: String, actions: [String]?, interactiveOnly: Bool, interactiveRoles: Set<String>) -> Bool {
    !interactiveOnly || role == "AXWindow" || interactiveRoles.contains(role) || !(actions?.isEmpty ?? true)
}

enum AXChildrenRead<Element> {
    case available([Element])
    case unsupported
    case failed
}

func axElementValue(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func axElementArray(_ raw: CFTypeRef?) -> [AXUIElement]? {
    guard let raw, CFGetTypeID(raw) == CFArrayGetTypeID() else { return nil }
    let array = unsafeBitCast(raw, to: CFArray.self)
    var elements: [AXUIElement] = []
    for index in 0..<CFArrayGetCount(array) {
        guard let pointer = CFArrayGetValueAtIndex(array, index),
              let element = axElementValue(unsafeBitCast(pointer, to: CFTypeRef.self)) else { return nil }
        elements.append(element)
    }
    return elements
}

func classifyAXChildren<Element>(status: AXError, values: [Element]?) -> AXChildrenRead<Element> {
    switch status {
    case .success: return values.map { .available($0) } ?? .failed
    case .noValue: return .available([])
    case .attributeUnsupported, .notImplemented: return .unsupported
    default: return .failed
    }
}

struct AXTraversalIssues {
    var failedChildren = 0
    var deadlineReached = false
    var limitReached = false
    var windowUnavailable = false
    mutating func permitsVisit(count: Int, limit: Int, now: Date, deadline: Date) -> Bool {
        if count >= limit { limitReached = true }
        if now >= deadline { deadlineReached = true }
        return !limitReached && !deadlineReached
    }
}

final class AXCollectBox: @unchecked Sendable {
    private let lock = NSLock()
    private let interactiveRoles: Set<String>
    private var finished = false
    private var elements: [[String: Any]] = []
    private var table: [String: AXUIElement] = [:]
    private var attempts = 0
    private var durationMs = 0
    private var issues = AXTraversalIssues()
    init(interactiveRoles: Set<String>) { self.interactiveRoles = interactiveRoles }
    var done: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    func store(_ nextElements: [[String: Any]], _ nextTable: [String: AXUIElement], wakeupAttempts: Int = 0, wakeupDurationMs: Int = 0, issues: AXTraversalIssues = AXTraversalIssues(), interactiveOnly: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        if finished { return }
        elements = nextElements.filter {
            observationElementVisible(role: $0["role"] as? String ?? "", actions: $0["actions"] as? [String], interactiveOnly: interactiveOnly, interactiveRoles: interactiveRoles)
        }
        table = nextTable; finished = true
        attempts = wakeupAttempts; durationMs = wakeupDurationMs
        self.issues = issues
    }
    func take() -> ([[String: Any]], [String: AXUIElement], Int, Int, Bool, AXTraversalIssues) {
        lock.lock(); defer { lock.unlock() }
        return (elements, table, attempts, durationMs, finished, issues)
    }
}

func accessibilityObservationWarning(finished: Bool, maxDepth: Int, interactiveOnly: Bool, visibleCount: Int, rawCount: Int, wakeupAttempts: Int, issues: AXTraversalIssues = AXTraversalIssues()) -> String? {
    if maxDepth == 0 { return nil }
    if !finished { return "accessibility_timeout: 无障碍树读取超时；可使用截图坐标操作，或重新观察。" }
    if issues.windowUnavailable { return "accessibility_window_unavailable: 无法读取目标窗口的无障碍树；可使用截图坐标操作。" }
    var incomplete: [String] = []
    if issues.failedChildren > 0 { incomplete.append("\(issues.failedChildren) 个分支读取失败") }
    if issues.deadlineReached { incomplete.append("遍历时间用尽") }
    if issues.limitReached { incomplete.append("元素数量达到上限") }
    if !incomplete.isEmpty { return "accessibility_tree_incomplete: \(incomplete.joined(separator: "，"))；请结合截图或调整观察条件。" }
    if wakeupAttempts > 0 && rawCount <= 1 { return "empty_after_wakeup: 重试 \(wakeupAttempts) 次后仍没有可引用的元素；可使用截图坐标操作。" }
    if interactiveOnly && visibleCount <= 1 { return "no_interactive_elements: 没有可交互元素；可传 interactive_only=false 查看完整树。" }
    return nil
}

func observationTitleElementValue(_ raw: Any, read: (AXUIElement) -> Any?) -> Any? {
    guard let element = axElementValue(raw as CFTypeRef) else { return nil }
    return read(element)
}

/// 只发布可序列化的 AX 属性；未知属性保持缺省，数值以字符串供模型读取。
func observationElement(ref: String, role: String, read: (String) -> Any?,
    readTitleElementValue: (Any) -> Any? = { _ in nil },
    actions: () -> [String]?, childrenCount: Int?, frame: () -> [String: Double]?) -> [String: Any] {
    var element: [String: Any] = ["ref": ref, "role": role]
    if let title = read("AXTitle") as? String, !title.isEmpty {
        element["title"] = title
    } else if let linked = read("AXTitleUIElement"), let title = readTitleElementValue(linked) as? String, !title.isEmpty {
        element["title"] = title
    } else if let title = read("AXLabelValue") as? String, !title.isEmpty {
        element["title"] = title
    }
    for (attribute, key) in [("AXDescription", "description"),
                             ("AXRoleDescription", "role_description"), ("AXSubrole", "subrole")] {
        if let text = read(attribute) as? String, !text.isEmpty { element[key] = text }
    }
    if let value = read("AXValue") {
        if let text = value as? String, !text.isEmpty { element["value"] = text }
        else if let number = value as? NSNumber { element["value"] = number.stringValue }
    }
    for (attribute, key) in [("AXFocused", "focused"), ("AXEnabled", "enabled"), ("AXSelected", "selected")] {
        if let value = read(attribute) as? Bool { element[key] = value }
    }
    if let actions = actions() { element["actions"] = actions }
    if let childrenCount { element["children_count"] = childrenCount }
    if let frame = frame() { element["frame"] = frame }
    return element
}
