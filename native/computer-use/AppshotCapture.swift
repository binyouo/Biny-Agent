import Foundation

@MainActor func captureAppshotSnapshot(
    screenshot: () async -> [String: Any],
    validateTarget: () -> Bool,
    collectContext: () async -> [String: Any],
    discard: () -> Void
) async throws -> [String: Any] {
    var result = await screenshot()
    guard let path = result["path"] as? String, !path.isEmpty else {
        throw NSError(domain: "appshot", code: 70, userInfo: [NSLocalizedDescriptionKey: result["screenshot_error"] as? String ?? "appshot_capture_failed"])
    }
    guard validateTarget() else {
        discard()
        throw NSError(domain: "appshot", code: 66, userInfo: [NSLocalizedDescriptionKey: "appshot_frontmost_changed"])
    }
    result.merge(await collectContext()) { _, new in new }
    return result
}
