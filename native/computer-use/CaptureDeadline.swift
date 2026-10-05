import Foundation

func withDeadline(_ timeout: Double, fallback: [String: Any], discard: @escaping ([String: Any]) -> Void = { _ in }, wait: @escaping (Double) async -> Void = { seconds in
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
}, work: @escaping () async -> [String: Any]) async -> [String: Any] {
    let lock = NSLock()
    var settled = false
    return await withCheckedContinuation { continuation in
        func finish(_ value: [String: Any]) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard !settled else { return false }
            settled = true; continuation.resume(returning: value); return true
        }
        Task { let result = await work(); if !finish(result) { discard(result) } }
        Task { await wait(timeout); _ = finish(fallback) }
    }
}

func captureObservation(timeout: Double, wait: @escaping (Double) async -> Void = { seconds in
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
}, describeError: @escaping (Error) -> String, capture: @escaping () async throws -> [String: Any]) async -> [String: Any] {
    await withDeadline(timeout, fallback: ["screenshot_error": "capture_timeout: screenshot did not complete before the deadline"], discard: { result in
        if let path = result["path"] as? String { try? FileManager.default.removeItem(atPath: path) }
    }, wait: wait) {
        do {
            let result = try await capture()
            guard result["path"] != nil else { return ["screenshot_error": "capture_empty: screenshot did not return an image"] }
            return result
        } catch { return ["screenshot_error": describeError(error)] }
    }
}
