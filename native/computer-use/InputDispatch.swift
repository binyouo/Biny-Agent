import Foundation
import ApplicationServices

final class NativeInputDispatch {
    @TaskLocal static var current: NativeInputDispatch?
    private let lock = NSLock()
    private var started = false
    private var cancelled = false

    var inputNotDispatched: Bool {
        lock.lock(); defer { lock.unlock() }
        return !started
    }

    static func markStarted() {
        guard let state = current else { return }
        state.lock.lock(); state.started = true; state.lock.unlock()
    }

    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
    }

    static func checkCancellation() throws {
        if let state = current {
            state.lock.lock(); let cancelled = state.cancelled; state.lock.unlock()
            if cancelled || Task.isCancelled { throw cancellation() }
        } else if Task.isCancelled { throw cancellation() }
    }

    static func beginInput() throws {
        guard let state = current else { try checkCancellation(); return }
        state.lock.lock(); defer { state.lock.unlock() }
        guard !state.cancelled, !Task.isCancelled else { throw cancellation() }
        state.started = true
    }

    private static func cancellation() -> NSError {
        NSError(domain: "input", code: 65, userInfo: [NSLocalizedDescriptionKey: "input_cancelled: 请求已取消，后续输入已停止"])
    }

    // AX 明确不支持表示没有执行；其他失败可能已经到达目标进程。
    static func action(_ perform: @autoclosure () -> AXError) throws -> AXError {
        try checkCancellation()
        let status = perform()
        if accessibilityActionResult(status) != .unsupported { markStarted() }
        return status
    }

    static func attribute(_ perform: @autoclosure () -> AXError) throws -> AXError {
        try checkCancellation()
        let status = perform()
        if accessibilityAttributeResult(status) != .unsupported { markStarted() }
        return status
    }
}
