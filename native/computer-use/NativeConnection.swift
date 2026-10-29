import Foundation
import Darwin

final class NativeConnection {
    private let lock = NSLock()
    private let fd: Int32
    private var closed = false

    init(_ fd: Int32) { self.fd = fd }

    func withOpen<T>(_ body: () throws -> T) rethrows -> T? {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return nil }
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
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.close(fd)
    }
}
