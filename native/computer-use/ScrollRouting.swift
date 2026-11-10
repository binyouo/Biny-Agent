import Foundation
import CoreGraphics
import AppKit

func scrollReference<Element>(_ ref: String?, lookup: (String) -> Element?) throws -> Element? {
    guard let ref else { return nil }
    guard let element = lookup(ref) else {
        throw NSError(domain: "scroll", code: 64, userInfo: [NSLocalizedDescriptionKey: "element_ref_not_observed: observe the target before scrolling"])
    }
    return element
}

func scrollAreaForTarget<Element>(reference: Element?, focusedWindow: () -> Element?, ancestor: (Element) -> Element?, findArea: (Element) -> Element?) -> Element? {
    if let reference { return ancestor(reference) ?? reference }
    guard let window = focusedWindow() else { return nil }
    return findArea(window)
}

func scrollPageCandidates<Element>(reference: Element?, area: Element, children: [Element], includeChild: (Element) -> Bool, same: (Element, Element) -> Bool) -> [Element] {
    var candidates: [Element] = []
    func append(_ item: Element) { if !candidates.contains(where: { same($0, item) }) { candidates.append(item) } }
    if let reference { append(reference) }
    append(area)
    for child in children where includeChild(child) { append(child) }
    return candidates
}

func scrollWheelEvent(pid: pid_t, windowID: Int?, point: CGPoint?, vertical: Int32, horizontal: Int32,
    naturalScrolling: Bool = UserDefaults.standard.object(forKey: "com.apple.swipescrolldirection") as? Bool ?? true,
    create: (Int32, Int32) -> CGEvent? = { CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: $0, wheel2: $1, wheel3: 0) }) throws -> CGEvent {
    guard let point, point.x.isFinite, point.y.isFinite else {
        throw NSError(domain: "scroll", code: 64, userInfo: [NSLocalizedDescriptionKey: "scroll_target_unavailable: scroll location is unavailable; observe again"])
    }
    guard let windowID, windowID > 0, windowID <= Int(UInt32.max) else {
        throw NSError(domain: "scroll", code: 64, userInfo: [NSLocalizedDescriptionKey: "scroll_target_unavailable: scroll requires an exact window identifier; observe again"])
    }
    // WindowServer 对行滚轮应用自然滚动反转；先抵消，保持参数表示内容滚动方向。
    let event = try requireInputEvent(create(naturalScrolling ? -vertical : vertical, naturalScrolling ? -horizontal : horizontal), errorCode: "scroll_event_creation_failed")
    event.location = point
    // AppKit 从事件自身的窗口号路由滚轮；鼠标下方提示字段不会保存在滚轮事件中。
    let windowNumberField = CGEventField(rawValue: 51)!
    event.setIntegerValueField(windowNumberField, value: Int64(windowID))
    guard NSEvent(cgEvent: event)?.windowNumber == windowID else {
        throw NSError(domain: "scroll", code: 64, userInfo: [NSLocalizedDescriptionKey: "scroll_target_unavailable: scroll event could not retain its exact window"])
    }
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
    return event
}
