import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("native connections cannot write or run monitor work after their descriptor is reused", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bcu-connection-"));
  try {
    const source = path.join(directory, "main.swift");
    const binary = path.join(directory, "connection-test");
    writeFileSync(source, `
import Foundation
import Darwin

var first: [Int32] = [-1, -1]
precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &first) == 0)
let oldFD = first[0]
let old = NativeConnection(oldFD)
old.disconnect()
var second: [Int32] = [-1, -1]
precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &second) == 0)
if second[0] != oldFD {
    precondition(second[1] != oldFD)
    precondition(dup2(second[0], oldFD) == oldFD)
    close(second[0]); second[0] = oldFD
}
var ran = false
precondition(old.withOpen { ran = true } == nil && !ran)
precondition(!old.send(Data("stale".utf8)))
var bytes = [UInt8](repeating: 0, count: 16)
precondition(recv(second[1], &bytes, bytes.count, MSG_DONTWAIT) == -1 && (errno == EAGAIN || errno == EWOULDBLOCK))
let current = NativeConnection(second[0])
precondition(current.send(Data("new".utf8)))
let count = read(second[1], &bytes, bytes.count)
precondition(count == 3 && String(bytes: bytes.prefix(count), encoding: .utf8) == "new")
old.disconnect()
precondition(current.send(Data("ok".utf8)))
precondition(read(second[1], &bytes, bytes.count) == 2)
current.disconnect()
close(first[1]); close(second[1])
print("ok")
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", "native/computer-use/NativeConnection.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native request cancellation is immediate, connection-owned and survives partial input", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bcu-cancel-"));
  try {
    const source = path.join(directory, "main.swift"), binary = path.join(directory, "cancel-test");
    writeFileSync(source, `import Foundation
import Darwin
import ApplicationServices
func cancelled(_ state: NativeInputDispatch) -> Bool {
    NativeInputDispatch.$current.withValue(state) {
        do { try NativeInputDispatch.checkCancellation(); return false }
        catch { return error.localizedDescription.hasPrefix("input_cancelled:") }
    }
}
var first: [Int32] = [-1, -1], second: [Int32] = [-1, -1]
precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &first) == 0)
precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &second) == 0)
let connection = NativeConnection(first[0]), other = NativeConnection(second[0])
let early = NativeInputDispatch(), sibling = NativeInputDispatch(), foreign = NativeInputDispatch()
precondition(connection.registerInput(requestID: "first", state: early))
precondition(connection.registerInput(requestID: "sibling", state: sibling))
precondition(other.registerInput(requestID: "first", state: foreign))
connection.cancelInput(requestID: "first")
precondition(cancelled(early) && early.inputNotDispatched)
precondition(!cancelled(sibling) && !cancelled(foreign))
NativeInputDispatch.$current.withValue(early) {
    var calls = 0
    do { _ = try NativeInputDispatch.action({ calls += 1; return .success }()); fatalError("cancelled request reached AX") }
    catch { precondition(calls == 0 && early.inputNotDispatched) }
}
connection.completeInput(requestID: "first", state: early)
let replacement = NativeInputDispatch()
precondition(connection.registerInput(requestID: "first", state: replacement))
connection.completeInput(requestID: "first", state: early)
connection.cancelInput(requestID: "first")
precondition(cancelled(replacement), "late completion removed a newer request")
NativeInputDispatch.$current.withValue(sibling) {
    try! NativeInputDispatch.beginInput()
    precondition(!sibling.inputNotDispatched)
}
connection.disconnect()
precondition(cancelled(sibling) && !sibling.inputNotDispatched, "disconnect cannot erase already dispatched input")
precondition(cancelled(replacement) && !cancelled(foreign))
let closed = NativeInputDispatch()
precondition(!connection.registerInput(requestID: "closed", state: closed) && cancelled(closed))
other.disconnect()
precondition(cancelled(foreign))
close(first[1]); close(second[1])
print("request cancellation passed")
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", "native/computer-use/NativeConnection.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "request cancellation passed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cancellation and disconnect stay responsive while a native reply is blocked", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bcu-backpressure-"));
  try {
    const source = path.join(directory, "main.swift"), binary = path.join(directory, "backpressure-test");
    writeFileSync(source, `import Foundation
import Darwin
signal(SIGPIPE, SIG_IGN)
func cancelled(_ state: NativeInputDispatch) -> Bool {
    NativeInputDispatch.$current.withValue(state) {
        do { try NativeInputDispatch.checkCancellation(); return false }
        catch { return true }
    }
}
func verify(_ disconnect: Bool) -> Bool {
    var sockets: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { exit(70) }
    var buffer: Int32 = 4096
    guard setsockopt(sockets[0], SOL_SOCKET, SO_SNDBUF, &buffer, socklen_t(MemoryLayout<Int32>.size)) == 0 else { exit(71) }
    let connection = NativeConnection(sockets[0]), state = NativeInputDispatch()
    guard connection.registerInput(requestID: "long-input", state: state) else { exit(72) }
    NativeInputDispatch.$current.withValue(state) { try! NativeInputDispatch.beginInput() }
    let writer = DispatchSemaphore(value: 0), operation = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { _ = connection.send(Data(repeating: 65, count: 4 * 1024 * 1024)); writer.signal() }
    var byte: UInt8 = 0
    let deadline = Date().addingTimeInterval(2)
    while recv(sockets[1], &byte, 1, MSG_PEEK | MSG_DONTWAIT) < 1 {
        guard Date() < deadline else { exit(73) }
        usleep(1000)
    }
    guard writer.wait(timeout: .now()) == .timedOut else { exit(74) }
    DispatchQueue.global().async {
        if disconnect { connection.disconnect() } else { connection.cancelInput(requestID: "long-input") }
        operation.signal()
    }
    let immediate = operation.wait(timeout: .now() + 0.25) == .success
    let stopped = cancelled(state) && !state.inputNotDispatched
    // 先观察取消是否被写入阻塞，再关闭对端让失败版本也能完整清理。
    _ = shutdown(sockets[1], SHUT_RDWR)
    close(sockets[1])
    guard writer.wait(timeout: .now() + 2) == .success else { exit(75) }
    if !immediate { guard operation.wait(timeout: .now() + 2) == .success else { exit(76) } }
    connection.disconnect()
    return immediate && stopped
}
print(verify(false) ? "cancel-immediate" : "cancel-blocked")
print(verify(true) ? "disconnect-immediate" : "disconnect-blocked")
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", "native/computer-use/NativeConnection.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 7_000 }).trim(), "cancel-immediate\ndisconnect-immediate");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a backpressured native reply does not block another connection", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bcu-reply-isolation-"));
  try {
    const source = path.join(directory, "main.swift"), binary = path.join(directory, "reply-isolation-test");
    writeFileSync(source, `import Foundation
import Darwin
signal(SIGPIPE, SIG_IGN)
var first: [Int32] = [-1, -1], second: [Int32] = [-1, -1]
guard socketpair(AF_UNIX, SOCK_STREAM, 0, &first) == 0,
      socketpair(AF_UNIX, SOCK_STREAM, 0, &second) == 0 else { exit(70) }
var buffer: Int32 = 4096
guard setsockopt(first[0], SOL_SOCKET, SO_SNDBUF, &buffer, socklen_t(MemoryLayout<Int32>.size)) == 0 else { exit(71) }
let blocked = NativeConnection(first[0]), healthy = NativeConnection(second[0])
let blockedDone = DispatchSemaphore(value: 0), healthyDone = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    _ = reply(blocked, ["id": "large", "ok": true, "data": ["payload": String(repeating: "x", count: 4 * 1024 * 1024)]])
    blockedDone.signal()
}
var byte: UInt8 = 0
let deadline = Date().addingTimeInterval(2)
while recv(first[1], &byte, 1, MSG_PEEK | MSG_DONTWAIT) < 1 {
    guard Date() < deadline else { exit(72) }
    usleep(1000)
}
guard blockedDone.wait(timeout: .now()) == .timedOut else { exit(73) }
DispatchQueue.global().async {
    _ = reply(healthy, ["id": "small", "ok": true, "data": ["ready": true]])
    healthyDone.signal()
}
let independent = healthyDone.wait(timeout: .now() + 0.25) == .success
_ = shutdown(first[1], SHUT_RDWR); close(first[1])
guard blockedDone.wait(timeout: .now() + 2) == .success else { exit(74) }
if !independent { guard healthyDone.wait(timeout: .now() + 2) == .success else { exit(75) } }
var bytes = [UInt8](repeating: 0, count: 1024)
let count = read(second[1], &bytes, bytes.count)
guard count > 0,
      let object = try? JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as? [String: Any],
      object["id"] as? String == "small",
      (object["data"] as? [String: Any])?["ready"] as? Bool == true else { exit(76) }
blocked.disconnect(); healthy.disconnect(); close(second[1])
print(independent ? "other-connection-responsive" : "other-connection-blocked")
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", "native/computer-use/NativeConnection.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 7_000 }).trim(), "other-connection-responsive");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
