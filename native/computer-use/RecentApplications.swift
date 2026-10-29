import Foundation
import CoreFoundation

func recentApplicationUseCount(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let count = number.doubleValue
    guard count.isFinite, count >= 0, count <= 9_007_199_254_740_991, count.rounded(.towardZero) == count else { return nil }
    return Int(count)
}

func mergeRecentApplications(running: [[String: Any]], recent: [[String: Any]]) -> [[String: Any]] {
    var byBundle: [String: [String: Any]] = [:]
    for entry in recent {
        if let bundle = entry["bundleId"] as? String, !bundle.isEmpty, byBundle[bundle] == nil { byBundle[bundle] = entry }
    }
    var seen = Set<String>()
    var result = running.map { app in
        var enriched = app
        if let bundle = app["bundleId"] as? String, !bundle.isEmpty {
            seen.insert(bundle)
            if let metadata = byBundle[bundle] {
                enriched["lastUsed"] = metadata["lastUsed"]
                enriched["useCount"] = metadata["useCount"]
            }
        }
        return enriched
    }
    for entry in recent {
        guard let bundle = entry["bundleId"] as? String, !bundle.isEmpty, seen.insert(bundle).inserted else { continue }
        result.append(entry)
    }
    return result
}
