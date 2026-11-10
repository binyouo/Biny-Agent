import Foundation
import Darwin

final class NativeConnection {
    private let stateLock = NSLock()
    private let ioLock = NSLock()
    private let fd: Int32
    private var closed = false
    private var inputs: [String: NativeInputDispatch] = [:]

    init(_ fd: Int32) { self.fd = fd }

    func registerInput(requestID: String, state: NativeInputDispatch) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed, inputs[requestID] == nil else { state.cancel(); return false }
        inputs[requestID] = state
        return true
    }

    func cancelInput(requestID: String) {
        stateLock.lock(); let state = inputs[requestID]; stateLock.unlock()
        state?.cancel()
    }

    func completeInput(requestID: String, state: NativeInputDispatch) {
        stateLock.lock(); defer { stateLock.unlock() }
        if inputs[requestID] === state { inputs.removeValue(forKey: requestID) }
    }

    func withOpen<T>(_ body: () throws -> T) rethrows -> T? {
        ioLock.lock(); defer { ioLock.unlock() }
        stateLock.lock(); let open = !closed; stateLock.unlock()
        guard open else { return nil }
        return try body()
    }

    func send(_ data: Data) -> Bool {
        withOpen {
            data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if count <= 0 { return false }
                    offset += count
                }
                return true
            }
        } ?? false
    }

    func disconnect() {
        stateLock.lock()
        guard !closed else { stateLock.unlock(); return }
        closed = true
        for state in inputs.values { state.cancel() }
        inputs.removeAll()
        stateLock.unlock()
        // 先停止输入并唤醒阻塞写入，再等待写入退出；关闭期间不释放或复用描述符。
        Darwin.shutdown(fd, SHUT_RDWR)
        ioLock.lock(); defer { ioLock.unlock() }
        Darwin.close(fd)
    }
}

@discardableResult func reply(_ connection: NativeConnection, _ value: [String: Any]) -> Bool {
    var response = value
    if value["ok"] as? Bool == false, let dispatch = NativeInputDispatch.current, var error = value["error"] as? [String: Any] {
        error["inputNotDispatched"] = dispatch.inputNotDispatched
        response["error"] = error
    }
    guard var data = try? JSONSerialization.data(withJSONObject: response) else { return false }
    data.append(10)
    let sent = connection.send(data)
    if !sent, let body = value["data"] as? [String: Any], let screenshot = body["screenshot"] as? String {
        try? FileManager.default.removeItem(atPath: screenshot)
    }
    return sent
}
