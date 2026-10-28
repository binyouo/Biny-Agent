import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("pure screenshot commands preserve their target and fail without expanding capture scope", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-native-shot-target-"));
  try {
    const source = path.join(directory, "fixture.swift"), binary = path.join(directory, "shot-test");
    writeFileSync(source, `import Foundation
func check(_ value: Bool, _ message: String) { if !value { print(message); exit(1) } }
actor Signal {
  var value: String?
  var waiter: CheckedContinuation<String, Never>?
  func wait() async -> String { if let value { return value }; return await withCheckedContinuation { waiter = $0 } }
  func send(_ value: String = "") { self.value = value; waiter?.resume(returning: value); waiter = nil }
}
@main struct Test {
  static func main() async throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = root.appendingPathComponent("window.jpg").path
    try Data("previous".utf8).write(to: URL(fileURLWithPath: output))
    var resolved = 0, captures = 0
    let pidShot = try await captureRequestedScreenshot(["pid": 12, "window_id": 42, "out": output, "max_width": 640, "quality": 0.7], timeout: 1, resolveTarget: { args in
      resolved += 1; check(args["pid"] as? Int == 12, "wrong target passed to resolver"); return 12
    }, describeError: { $0.localizedDescription }, capture: { args in
      captures += 1
      check(args["pid"] as? Int == 12, "explicit PID was lost: capture would expand to the display")
      check(args["window_id"] as? Int == 42, "explicit window was lost")
      let staged = args["out"] as! String
      check(staged != output && URL(fileURLWithPath: staged).deletingLastPathComponent() == root, "capture must stage beside the requested output")
      check(args["max_width"] as? Int == 640 && args["quality"] as? Double == 0.7, "image options changed")
      try Data("window pixels".utf8).write(to: URL(fileURLWithPath: staged))
      return ["path": staged, "windowId": 42]
    })
    check(pidShot["windowId"] as? Int == 42 && resolved == 1 && captures == 1, "target capture did not complete once")
    check(pidShot["path"] as? String == output, "the caller did not receive its requested output path")
    check(try String(contentsOfFile: output, encoding: .utf8) == "window pixels", "capture did not replace the requested file")

    _ = try await captureRequestedScreenshot(["bundle": "test.app", "out": root.appendingPathComponent("bundle.jpg").path], timeout: 1, resolveTarget: { args in
      resolved += 1; check(args["bundle"] as? String == "test.app", "bundle identity changed"); return 13
    }, describeError: { $0.localizedDescription }, capture: { args in
      captures += 1; check(args["pid"] as? Int == 13, "bundle capture did not resolve its PID")
      let staged = args["out"] as! String; try Data("bundle".utf8).write(to: URL(fileURLWithPath: staged))
      return ["path": staged]
    })
    _ = try await captureRequestedScreenshot(["out": root.appendingPathComponent("display.jpg").path], timeout: 1, resolveTarget: { _ in
      check(false, "explicit display capture must not select an application"); return 99
    }, describeError: { $0.localizedDescription }, capture: { args in
      captures += 1; check(args["pid"] == nil && args["bundle"] == nil, "display scope changed")
      let staged = args["out"] as! String; try Data("display".utf8).write(to: URL(fileURLWithPath: staged))
      return ["path": staged]
    })
    check(resolved == 2 && captures == 3, "scope resolver ran unexpectedly")

    for invalid: [String: Any] in [["pid": NSNull()], ["pid": 0], ["pid": -1], ["pid": 2147483648], ["pid": 12, "window_id": NSNull()], ["pid": 12, "window_id": "42"], ["pid": 12, "window_id": 1.5], ["pid": 12, "window_id": 0], ["pid": 12, "window_id": 4294967296]] {
      do {
        _ = try await captureRequestedScreenshot(invalid, timeout: 1, resolveTarget: { _ in
          check(false, "invalid capture identity reached application resolution"); return 12
        }, describeError: { $0.localizedDescription }, capture: { _ in
          check(false, "invalid capture identity expanded its scope"); return [:]
        })
        check(false, "invalid capture identity reported success")
      } catch { check(error.localizedDescription.hasPrefix("capture_target_invalid:"), "invalid identity did not report its cause") }
    }

    do {
      _ = try await captureRequestedScreenshot(["bundle": "missing.app", "out": "/private/missing.jpg"], timeout: 1, resolveTarget: { _ in
        throw NSError(domain: "target", code: 1, userInfo: [NSLocalizedDescriptionKey: "app_not_installed"])
      }, describeError: { $0.localizedDescription }, capture: { _ in
        check(false, "missing application must never fall back to a display capture"); return [:]
      })
      check(false, "missing application reported success")
    } catch { check(error.localizedDescription == "app_not_installed", "target failure was hidden") }

    for empty in [false, true] {
      do {
        _ = try await captureRequestedScreenshot(["pid": 12, "window_id": 42, "out": output], timeout: 1, resolveTarget: { _ in 12 }, describeError: { $0.localizedDescription }, capture: { args in
          captures += 1
          try Data("partial".utf8).write(to: URL(fileURLWithPath: args["out"] as! String))
          if empty { return [:] }
          throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "capture_target_unavailable"])
        })
        check(false, "failed screenshot reported success")
      } catch {
        check(error.localizedDescription.hasPrefix(empty ? "capture_empty:" : "capture_target_unavailable"), "capture failure was hidden")
      }
    }
    check(captures == 5, "failed capture was retried")
    check(try String(contentsOfFile: output, encoding: .utf8) == "window pixels", "failed capture overwrote the existing output")

    let entered = Signal(), release = Signal(), finished = Signal()
    let delayed = Task {
      try await captureRequestedScreenshot(["pid": 12, "window_id": 42, "out": output], timeout: 0.02, resolveTarget: { _ in 12 }, describeError: { $0.localizedDescription }, capture: { args in
        let staged = args["out"] as! String
        await entered.send(staged); _ = await release.wait()
        try Data("late pixels".utf8).write(to: URL(fileURLWithPath: staged))
        await finished.send(); return ["path": staged]
      })
    }
    let delayedPath = await entered.wait()
    do { _ = try await delayed.value; check(false, "capture exceeded its deadline") }
    catch { check(error.localizedDescription.hasPrefix("capture_timeout:"), "timeout cause was hidden") }
    try Data("new owner".utf8).write(to: URL(fileURLWithPath: output))
    await release.send(); _ = await finished.wait()
    let deadline = Date().addingTimeInterval(1)
    while FileManager.default.fileExists(atPath: delayedPath) && Date() < deadline { await Task.yield() }
    check(!FileManager.default.fileExists(atPath: delayedPath), "late temporary capture was not cleaned up")
    check(try String(contentsOfFile: output, encoding: .utf8) == "new owner", "late capture or cleanup changed another owner's output")
    check(try FileManager.default.contentsOfDirectory(atPath: root.path).allSatisfy { !$0.hasPrefix(".biny-capture-") }, "staging files were retained")
    print("ok")
  }
}`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "native/computer-use/CaptureDeadline.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, [directory], { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
