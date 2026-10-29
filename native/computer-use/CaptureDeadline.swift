import Foundation
import Darwin

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

func captureRequestedScreenshot(_ parameters: [String: Any], timeout: Double,
    resolveTarget: ([String: Any]) throws -> Int,
    describeError: @escaping (Error) -> String,
    capture: @escaping ([String: Any]) async throws -> [String: Any]) async throws -> [String: Any] {
    for (key, maximum) in [("pid", Int(Int32.max)), ("window_id", Int(UInt32.max))] {
        if let raw = parameters[key] {
            guard let value = raw as? Int, value > 0, value <= maximum else {
                throw NSError(domain: "capture", code: 64, userInfo: [NSLocalizedDescriptionKey: "capture_target_invalid: \(key) must be a positive native identifier"])
            }
        }
    }
    var arguments = parameters
    if parameters["pid"] != nil || parameters["bundle"] != nil { arguments["pid"] = try resolveTarget(parameters) }
    guard let output = parameters["out"] as? String, !output.isEmpty else {
        throw NSError(domain: "capture", code: 64, userInfo: [NSLocalizedDescriptionKey: "capture_output_required"])
    }
    let staging = URL(fileURLWithPath: output).deletingLastPathComponent().appendingPathComponent(".biny-capture-\(UUID().uuidString).jpg")
    arguments["out"] = staging.path
    let target = arguments
    var result = await captureObservation(timeout: timeout, describeError: describeError) {
        do {
            let captured = try await capture(target)
            guard let path = captured["path"] as? String else { try? FileManager.default.removeItem(at: staging); return captured }
            guard path == staging.path else {
                throw NSError(domain: "capture", code: 65, userInfo: [NSLocalizedDescriptionKey: "capture_output_mismatch"])
            }
            return captured
        } catch { try? FileManager.default.removeItem(at: staging); throw error }
    }
    if let reason = result["screenshot_error"] as? String {
        throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
    }
    guard rename(staging.path, output) == 0 else {
        let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        try? FileManager.default.removeItem(at: staging)
        throw error
    }
    result["path"] = output
    return result
}
