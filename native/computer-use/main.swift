// 本机 Unix socket 截图 daemon。请求逐行 JSON，主进程负责调度和降级。
import Foundation
import AppKit
import ScreenCaptureKit
import Darwin

let replyLock = NSLock()
func reply(_ fd: Int32, _ value: [String: Any]) {
    replyLock.lock(); defer { replyLock.unlock() }
    guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
    data.append(10)
    data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count <= 0 { break }; offset += count
        }
    }
}
func screenshot(_ parameters: [String: Any]) async throws -> [String: Any] {
    guard let output = parameters["out"] as? String else { throw NSError(domain: "capture", code: 64) }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw NSError(domain: "capture", code: 1) }
    let width = min(display.width, max(1, parameters["max_width"] as? Int ?? 2560))
    let config = SCStreamConfiguration()
    config.width = width
    config.height = max(1, Int((Double(display.height) * Double(width) / Double(display.width)).rounded()))
    config.showsCursor = false
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: parameters["quality"] as? Double ?? 0.55]) else { throw NSError(domain: "capture", code: 2) }
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
    return ["path": output]
}
let activityLock = NSLock()
var lastRequestAt = Date()
let idleIndex = CommandLine.arguments.firstIndex(of: "--idle-seconds")
let idleSeconds = idleIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? Double(CommandLine.arguments[$0 + 1]) : nil } ?? 900
let idleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    activityLock.lock(); let elapsed = Date().timeIntervalSince(lastRequestAt); activityLock.unlock()
    if elapsed >= max(1, idleSeconds) { exit(0) }
}
let socketIndex = CommandLine.arguments.firstIndex(of: "--socket")
let socketPath = socketIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? ""
if socketPath.isEmpty { exit(64) }
signal(SIGPIPE, SIG_IGN)
let server = socket(AF_UNIX, SOCK_STREAM, 0)
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let bytes = Array(socketPath.utf8CString)
if bytes.count > MemoryLayout.size(ofValue: address.sun_path) { exit(64) }
withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
unlink(socketPath)
let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
if bound != 0 || listen(server, 8) != 0 { exit(1) }
chmod(socketPath, 0o600)
print("ready"); fflush(stdout)
DispatchQueue.global().async {
    while true {
        let fd = accept(server, nil, nil)
        if fd < 0 { continue }
        DispatchQueue.global().async {
            var buffer = Data(); var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = Darwin.read(fd, &chunk, chunk.count)
                if count <= 0 { close(fd); return }
                buffer.append(contentsOf: chunk.prefix(count))
                if buffer.count > 1_048_576 { close(fd); return }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer.prefix(upTo: newline))
                    buffer.removeSubrange(...newline)
                    guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { close(fd); return }
                    activityLock.lock(); lastRequestAt = Date(); activityLock.unlock()
                    Task {
                        let id = request["id"] ?? NSNull()
                        do {
                            if request["cmd"] as? String == "ping" { reply(fd, ["id": id, "ok": true, "data": ["ok": true]]); return }
                            guard request["cmd"] as? String == "shot_display" else { throw NSError(domain: "method", code: 64) }
                            reply(fd, ["id": id, "ok": true, "data": try await screenshot(request["args"] as? [String: Any] ?? [:])])
                        } catch { reply(fd, ["id": id, "ok": false, "error": ["code": "capture_failed", "message": "Screen capture failed"]]) }
                    }
                }
            }
        }
    }
}
RunLoop.main.run()
