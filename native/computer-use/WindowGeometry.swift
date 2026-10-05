import Foundation
import CoreGraphics

func validateCaptureTarget(pid: Int?, windowID: Int?, applications: Set<Int>, windows: [Int: Int]) throws {
    if let pid, !applications.contains(pid) {
        throw NSError(domain: "capture", code: 65, userInfo: [NSLocalizedDescriptionKey: "capture_application_not_found"])
    }
    if let windowID {
        guard let owner = windows[windowID] else {
            throw NSError(domain: "capture", code: 65, userInfo: [NSLocalizedDescriptionKey: "capture_window_not_found"])
        }
        guard let pid, owner == pid else {
            throw NSError(domain: "capture", code: 65, userInfo: [NSLocalizedDescriptionKey: "capture_window_identity_changed"])
        }
    }
}

func windowNumberForApp(_ pid: Int, windows: [[String: Any]]? = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) -> Int? {
    guard let list = windows else { return nil }
    for window in list {
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              ((bounds["Width"] as? NSNumber)?.doubleValue ?? 0) >= 40, ((bounds["Height"] as? NSNumber)?.doubleValue ?? 0) >= 40,
              let number = window[kCGWindowNumber as String] as? Int else { continue }
        return number
    }
    return nil
}

func windowScreenBounds(pid: Int, windowID: Int? = nil, windows: [[String: Any]]? = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) -> [String: Double]? {
    guard let list = windows else { return nil }
    for window in list {
        if let windowID, window[kCGWindowNumber as String] as? Int != windowID { continue }
        guard let owner = window[kCGWindowOwnerPID as String] as? Int, owner == pid,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              (window[kCGWindowLayer as String] as? Int ?? 0) == 0 else { continue }
        return ["x": (bounds["X"] as? NSNumber)?.doubleValue ?? 0, "y": (bounds["Y"] as? NSNumber)?.doubleValue ?? 0, "w": (bounds["Width"] as? NSNumber)?.doubleValue ?? 0, "h": (bounds["Height"] as? NSNumber)?.doubleValue ?? 0]
    }
    return nil
}
