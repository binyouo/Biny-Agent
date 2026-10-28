import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Appshot validates the captured target before collecting slow context", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-appshot-capture-"));
  try {
    const source = path.join(directory, "fixture.swift"), binary = path.join(directory, "capture-test");
    writeFileSync(source, `import Foundation
@main struct Test {
  @MainActor static func main() async throws {
    var foreground = 42, validated = 0, discarded = 0
    let shot = try await captureAppshotSnapshot(screenshot: { ["path": "/private/shot.jpg", "width": 100] }, validateTarget: {
      dispatchPrecondition(condition: .onQueue(.main))
      validated += 1; return foreground == 42
    }, collectContext: {
      dispatchPrecondition(condition: .onQueue(.main))
      foreground = 99
      return ["axText": "captured window text", "axError": "accessibility_tree_incomplete"]
    }, discard: { discarded += 1 })
    precondition(validated == 1 && discarded == 0)
    precondition(shot["path"] as? String == "/private/shot.jpg")
    precondition(shot["axText"] as? String == "captured window text")
    precondition(shot["axError"] as? String == "accessibility_tree_incomplete")

    var collected = false
    do {
      _ = try await captureAppshotSnapshot(screenshot: { ["path": "/private/shot.jpg"] }, validateTarget: { false }, collectContext: {
        collected = true; return [:]
      }, discard: { discarded += 1 })
      fatalError("changed target must fail")
    } catch { precondition(error.localizedDescription == "appshot_frontmost_changed") }
    precondition(discarded == 1 && !collected)

    var validationCalled = false
    do {
      _ = try await captureAppshotSnapshot(screenshot: { ["screenshot_error": "capture_permission_denied"] }, validateTarget: {
        validationCalled = true; return true
      }, collectContext: { collected = true; return [:] }, discard: { discarded += 1 })
      fatalError("capture failure must be reported")
    } catch { precondition(error.localizedDescription == "capture_permission_denied") }
    precondition(!validationCalled && !collected && discarded == 1)
    print("ok")
  }
}`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "native/computer-use/AppshotCapture.swift", source, "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
