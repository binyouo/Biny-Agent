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
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/NativeConnection.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
