import ApplicationServices
import Foundation

enum AccessibilityActionResult: Equatable {
    case success
    case unsupported
    case unknown(Int32)
}

func accessibilityActionResult(_ status: AXError) -> AccessibilityActionResult {
    switch status {
    case .success: return .success
    case .actionUnsupported, .notImplemented: return .unsupported
    default: return .unknown(status.rawValue)
    }
}

func accessibilityAttributeResult(_ status: AXError) -> AccessibilityActionResult {
    switch status {
    case .success: return .success
    case .attributeUnsupported, .notImplemented: return .unsupported
    default: return .unknown(status.rawValue)
    }
}

func requireAccessibilityAttributeWrite(_ status: AXError, unsupported: String, unknown: String) throws {
    switch accessibilityAttributeResult(status) {
    case .success: return
    case .unsupported:
        throw NSError(domain: "ax", code: 65, userInfo: [NSLocalizedDescriptionKey: "\(unsupported): 目标不支持该属性写入"])
    case .unknown(let code):
        throw NSError(domain: "ax", code: 65, userInfo: [NSLocalizedDescriptionKey: "\(unknown): 属性写入结果未知 (\(code))，不要重试；先观察目标"])
    }
}

func automaticAccessibilityTextInsert<Element>(target: Element?, writable: (Element) -> Bool, write: (Element) -> AXError) throws -> Bool {
    guard let target, writable(target) else { return false }
    let status = write(target)
    switch accessibilityAttributeResult(status) {
    case .success: return true
    case .unsupported: return false
    case .unknown:
        try requireAccessibilityAttributeWrite(status, unsupported: "text_input_ax_unsupported", unknown: "text_input_outcome_unknown")
        return false
    }
}

func focusedElementBelongsToTarget<Element>(focused: Element?, target: Element, equals: (Element, Element) -> Bool, parent: (Element) -> Element?) -> Bool {
    var current = focused
    for _ in 0..<9 {
        guard let element = current else { return false }
        if equals(element, target) { return true }
        current = parent(element)
    }
    return false
}

func accessibilityTextValue(_ current: String?, text: String, append: Bool) throws -> String {
    if !append { return text }
    guard let current else { throw NSError(domain: "ax", code: 65, userInfo: [NSLocalizedDescriptionKey: "type_append_read_unavailable: 无法读取当前文字，未执行追加"]) }
    return current + text
}

func performAccessibilityActions(_ actions: [String], perform: (String) -> AXError) -> AccessibilityActionResult {
    for action in actions {
        switch accessibilityActionResult(perform(action)) {
        case .success: return .success
        case .unsupported: continue
        case .unknown(let code): return .unknown(code)
        }
    }
    return .unsupported
}

func performElementClick(strategy: String, requiresPhysical: Bool,
                         physical: () async throws -> Bool,
                         accessibility: () -> AccessibilityActionResult) async throws -> String {
    if strategy == "ax" && requiresPhysical {
        throw NSError(domain: "click", code: 65, userInfo: [NSLocalizedDescriptionKey: "ax_cannot_express_this_click: AX 只有单次左键动作，双击或其它按键请用 strategy=physical"])
    }
    if strategy == "physical" || strategy == "auto" {
        // false 仅表示没有可用位置且尚未派发；派发错误直接抛出，不转 AX 重放。
        if try await physical() { return "physical" }
        if strategy == "physical" || requiresPhysical {
            throw NSError(domain: "click", code: 66, userInfo: [NSLocalizedDescriptionKey: "element_has_no_frame: 元素没有坐标，做不了物理点击"])
        }
    }
    switch accessibility() {
    case .success: return "ax"
    case .unsupported:
        if strategy == "ax" {
            throw NSError(domain: "click", code: 67, userInfo: [NSLocalizedDescriptionKey: "click_action_unsupported: 这个控件不支持 AX 点击动作"])
        }
        throw NSError(domain: "click", code: 66, userInfo: [NSLocalizedDescriptionKey: "click_action_unavailable: 控件不支持 AX 点击且没有可点击位置"])
    case .unknown(let code):
        throw NSError(domain: "click", code: 65, userInfo: [NSLocalizedDescriptionKey: "click_action_outcome_unknown: AX 点击结果未知 (\(code))，不要重试；先观察目标"])
    }
}
