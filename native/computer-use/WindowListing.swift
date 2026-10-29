import Foundation
import CoreGraphics
import ApplicationServices

func selectObservationWindow(_ requested: Any?, windows: () throws -> [[String: Any]]) throws -> Int {
    if let requested {
        guard let id = requested as? Int, id > 0, id <= Int(UInt32.max),
              (requested as? NSNumber).map({ CFGetTypeID($0) != CFBooleanGetTypeID() }) != false else {
            throw NSError(domain: "windows", code: 65, userInfo: [NSLocalizedDescriptionKey: "capture_target_invalid: window_id must be a positive native identifier"])
        }
        return id
    }
    let candidates = try windows().filter { entry in
        guard let id = entry["window_id"] as? Int else { return false }
        return id > 0 && id <= Int(UInt32.max)
    }
    let focused = candidates.filter { $0["focused"] as? Bool == true }
    if focused.count == 1, let id = focused[0]["window_id"] as? Int { return id }
    if candidates.count == 1, let id = candidates[0]["window_id"] as? Int { return id }
    throw NSError(domain: "windows", code: 65, userInfo: [NSLocalizedDescriptionKey: candidates.isEmpty
        ? "computer_window_not_ready: 目标应用还没有可观察窗口"
        : "computer_window_selection_required: 请列出并指定准确窗口"])
}

func windowListElements(_ status: AXError, elements: [AXUIElement]?) throws -> [AXUIElement]? {
    switch status {
    case .success:
        guard let elements else {
            throw NSError(domain: "windows", code: 65, userInfo: [NSLocalizedDescriptionKey: "window_list_invalid: AXWindows did not return an element array"])
        }
        return elements
    case .noValue: return []
    case .attributeUnsupported, .notImplemented: return nil
    case .apiDisabled:
        throw NSError(domain: "windows", code: Int(status.rawValue), userInfo: [NSLocalizedDescriptionKey: "ax_not_granted: 请在系统设置中为 Biny Computer Use 授予辅助功能权限后重试"])
    default:
        throw NSError(domain: "windows", code: Int(status.rawValue), userInfo: [NSLocalizedDescriptionKey: "window_list_read_failed: AXError \(status.rawValue)"])
    }
}

func mergeApplicationWindows(pid: Int, axEntries: [[String: Any]]?, screenWindows: [[String: Any]]?) throws -> [[String: Any]] {
    guard axEntries != nil || screenWindows != nil else {
        throw NSError(domain: "windows", code: 65, userInfo: [NSLocalizedDescriptionKey: "window_list_unavailable: neither accessibility nor system window information could be read"])
    }
    var screens: [[String: Any]] = []
    for window in screenWindows ?? [] {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let number = window[kCGWindowNumber as String] as? Int, number > 0,
              let boundsRaw = window[kCGWindowBounds as String] as? [String: Any] else { continue }
        let boundsW = (boundsRaw["Width"] as? NSNumber)?.doubleValue ?? 0
        let boundsH = (boundsRaw["Height"] as? NSNumber)?.doubleValue ?? 0
        let width = boundsW, height = boundsH
        // 阴影和辅助小窗不是可观察目标，混进来只会让模型挑错。
        if width < 40 || height < 40 { continue }
        var entry: [String: Any] = [
            "window_id": number,
            "title": window[kCGWindowName as String] as? String ?? "",
            "frame": [
                "x": (boundsRaw["X"] as? NSNumber)?.doubleValue ?? 0,
                "y": (boundsRaw["Y"] as? NSNumber)?.doubleValue ?? 0,
                "w": width, "h": height
            ] as [String: Double],
        ]
        if let onscreen = window[kCGWindowIsOnscreen as String] as? Bool { entry["onscreen"] = onscreen }
        screens.append(entry)
    }
    let byID = Dictionary(screens.compactMap { entry in
        (entry["window_id"] as? Int).map { ($0, entry) }
    }, uniquingKeysWith: { first, _ in first })
    var out: [[String: Any]] = [], represented = Set<Int>()
    // AX 与 CG 的顺序不同；只有真实窗口号相同才可补充字段。
    for var entry in axEntries ?? [] {
        if let id = entry["window_id"] as? Int, id > 0 {
            guard represented.insert(id).inserted else { continue }
            if let screen = byID[id] {
                if (entry["title"] as? String ?? "").isEmpty { entry["title"] = screen["title"] }
                entry["frame"] = screen["frame"]
                entry["onscreen"] = screen["onscreen"]
            }
        }
        out.append(entry)
    }
    for entry in screens {
        if let id = entry["window_id"] as? Int, represented.insert(id).inserted { out.append(entry) }
    }
    return out
}
