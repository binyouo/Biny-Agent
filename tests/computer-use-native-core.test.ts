import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("mirror sessions reject window ID reuse and late frames, report frame age, and bound resources", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-mirror-core-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
func expect(_ value: @autoclosure () -> Bool) { precondition(value()) }
var now: TimeInterval = 10
let sessions = MirrorSessions(limit: 2, now: { now })
let first = try sessions.begin(windowID: 42, pid: 12, armed: true)
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] is NSNull)
expect((sessions.list()["armed"] as! [[String: Any]]).count == 1)
let duplicate = try sessions.begin(windowID: 42, pid: 12, armed: true)
expect(duplicate.lease == first.lease)
do { _ = try sessions.begin(windowID: 42, pid: 13, armed: false); fatalError("accepted a different owner") }
catch { expect(error.localizedDescription == "pip_window_identity_changed") }
sessions.frame(first); now = 12.5
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] as! Int == 2500)
sessions.present(first)
expect((sessions.list()["sessions"] as! [[String: Any]]).count == 1)
sessions.fail(first, error: "stream_stopped")
expect(sessions.state(windowID: 42)!["error"] as! String == "stream_stopped")
sessions.frame(first)
expect(sessions.state(windowID: 42)!["error"] == nil)
_ = try sessions.begin(windowID: 43, pid: 12, armed: false)
do { _ = try sessions.begin(windowID: 44, pid: 12, armed: false); fatalError("unbounded sessions") }
catch { expect(error.localizedDescription == "pip_session_limit") }
sessions.close(windowID: 42)
let replacement = try sessions.begin(windowID: 42, pid: 13, armed: true)
expect(replacement.lease != first.lease)
sessions.frame(first); sessions.present(first); sessions.fail(first, error: "old error")
expect(sessions.state(windowID: 42)!["state"] as! String == "armed")
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] is NSNull)
expect(sessions.state(windowID: 42)!["error"] == nil)
for id in [0, -1, Int(UInt32.max) + 1] {
  do { _ = try sessions.begin(windowID: id, pid: 12, armed: false); fatalError("invalid ID accepted") }
  catch { expect(error.localizedDescription == "pip_invalid_window_id") }
}
print("mirror contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/MirrorSessions.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /mirror contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("physical input plans the complete text before dispatch and capture deadlines return explicit errors", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-native-contracts-"));
  try {
    const source = path.join(directory, "Contracts.swift");
    await writeFile(source, `import Foundation
import CoreGraphics
actor Gate {
  var released = false
  var pending: [CheckedContinuation<Void, Never>] = []
  func wait() async { if released { return }; await withCheckedContinuation { pending.append($0) } }
  func release() { released = true; for waiter in pending { waiter.resume() }; pending = [] }
}
@main struct Contracts {
  static func main() async throws {
    try validateCaptureTarget(pid: nil, windowID: nil, applications: [12], windows: [42: 12])
    try validateCaptureTarget(pid: 12, windowID: 42, applications: [12], windows: [42: 12])
    try validateForegroundTarget(pid: 12, windowID: 42, frontmostPID: 12, focusedWindowID: 42)
    let invalidFocus: [(Int, Int, Int?, Int?)] = [(12, 42, nil, 42), (12, 42, 13, 42), (12, 42, 12, nil), (12, 42, 12, 43), (0, 42, 0, 42), (12, 0, 12, 0), (12, Int(UInt32.max) + 1, 12, Int(UInt32.max) + 1)]
    for (pid, window, frontmost, focused) in invalidFocus {
      do { try validateForegroundTarget(pid: pid, windowID: window, frontmostPID: frontmost, focusedWindowID: focused); fatalError("keyboard input escaped its exact foreground window") }
      catch { precondition(error.localizedDescription.hasPrefix("foreground_target_not_focused")) }
    }
    for (pid, window, message) in [(13, 42, "capture_application_not_found"), (12, 43, "capture_window_not_found"), (12, 44, "capture_window_identity_changed")] {
      do { try validateCaptureTarget(pid: pid, windowID: window, applications: [12], windows: [42: 12, 44: 13]); fatalError("expanded a missing target") }
      catch { precondition(error.localizedDescription == message) }
    }
    let bounds: NSDictionary = ["X": NSNumber(value: 300), "Y": NSNumber(value: 200), "Width": NSNumber(value: 640), "Height": NSNumber(value: 480)]
    let window: [String: Any] = [kCGWindowOwnerPID as String: NSNumber(value: 12), kCGWindowNumber as String: NSNumber(value: 42), kCGWindowLayer as String: NSNumber(value: 0), kCGWindowBounds as String: bounds]
    precondition(windowNumberForApp(12, windows: [window]) == 42)
    precondition(windowScreenBounds(pid: 12, windowID: 42, windows: [window])?["x"] == 300)
    precondition(windowScreenBounds(pid: 12, windowID: 43, windows: [window]) == nil)
    let keys: [String: PhysicalStroke] = ["a": PhysicalStroke(keyCode: 0, flags: []), "A": PhysicalStroke(keyCode: 0, flags: .maskShift)]
    precondition(PhysicalInput.autoRoute(axWritable: true, physicalAvailable: true) == "ax")
    precondition(PhysicalInput.autoRoute(axWritable: false, physicalAvailable: true) == "physical")
    precondition(PhysicalInput.autoRoute(axWritable: false, physicalAvailable: false) == "unicode")
    let plan = try PhysicalInput.plan("aA") { keys[$0] }
    precondition(plan.count == 2 && plan[0].flags.isEmpty && plan[1].flags == .maskShift)
    do { _ = try PhysicalInput.plan("a🦊") { keys[$0] }; fatalError("accepted an unmappable suffix") }
    catch { precondition(error.localizedDescription.contains("input_method_unmappable_character: index 1")) }
    let timeout = Gate(), work = Gate(), timerStarted = Gate(), workStarted = Gate()
    let latePath = NSTemporaryDirectory() + "biny-late-capture-\\(UUID().uuidString).jpg"
    let operation = Task {
      await captureObservation(timeout: 3, wait: { _ in await timerStarted.release(); await timeout.wait() }, describeError: { $0.localizedDescription }) {
        try Data("late pixels".utf8).write(to: URL(fileURLWithPath: latePath))
        await workStarted.release(); await work.wait(); return ["path": latePath]
      }
    }
    await timerStarted.wait(); await workStarted.wait(); await timeout.release()
    let result = await operation.value
    precondition((result["screenshot_error"] as? String)?.hasPrefix("capture_timeout") == true && result["path"] == nil)
    await work.release()
    // 等待真实异步工作完成后的文件清理；条件轮询上限两秒，不用固定等待判成功。
    let cleanupDeadline = Date().addingTimeInterval(2)
    while FileManager.default.fileExists(atPath: latePath) && Date() < cleanupDeadline { try await Task.sleep(nanoseconds: 1_000_000) }
    let removed = !FileManager.default.fileExists(atPath: latePath)
    try? FileManager.default.removeItem(atPath: latePath)
    precondition(removed, "late capture file was retained after timeout")
    let never = Gate()
    let success = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) { ["path": "fresh.jpg"] }
    precondition(success["path"] as? String == "fresh.jpg" && success["screenshot_error"] == nil)
    let empty = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) { [:] }
    precondition((empty["screenshot_error"] as? String)?.hasPrefix("capture_empty") == true)
    let denied = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) {
      throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "screen_recording_not_granted"])
    }
    precondition(denied["screenshot_error"] as? String == "screen_recording_not_granted")
    await never.release()
    print("native contracts passed")
  }
}
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "native/computer-use/PhysicalInput.swift", "native/computer-use/CaptureDeadline.swift", "native/computer-use/WindowGeometry.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /native contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("background mouse packets name the exact window for clicks and drags without posting UI events", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-background-input-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `
import Foundation
import CoreGraphics
for type: CGEventType in [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp] {
    let event = try BackgroundInput.mouseEvent(pid: 123, windowID: 456, type: type, point: CGPoint(x: 315, y: 245), button: .left, clickState: 2)
    precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointer) == 456, "packet omitted exact window ID")
    precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent) == 456)
    precondition(event.getIntegerValueField(.eventTargetUnixProcessID) == 123)
    precondition(event.getIntegerValueField(.mouseEventClickState) == 2)
    precondition(event.location == CGPoint(x: 315, y: 245))
}
print("background packets passed")
let focusGuard = BackgroundFocusGuard()
focusGuard.block(123); focusGuard.block(123)
precondition(focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
precondition(focusGuard.shouldDropActivation(type: 14, subtype: 8, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 14, subtype: 7, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 1, subtype: 0, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 124))
focusGuard.release(123)
precondition(focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
focusGuard.release(123)
precondition(!focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/BackgroundInput.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /background packets passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("double modifier requires separate bare presses and resets after a chord", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-modifier-"));
  try {
    const source = path.join(root, "main.swift"), binary = path.join(root, "gesture");
    await writeFile(source, `import Foundation
var taps = ModifierDoubleTap()
precondition(!taps.update(pressed: true, interrupted: false, now: 0))
precondition(!taps.update(pressed: true, interrupted: false, now: 0.1), "a repeated flags event is not a second press")
precondition(!taps.update(pressed: false, interrupted: false, now: 0.2))
precondition(taps.update(pressed: true, interrupted: false, now: 0.3))
precondition(!taps.update(pressed: false, interrupted: false, now: 0.4))
precondition(!taps.update(pressed: true, interrupted: false, now: 1))
precondition(!taps.update(pressed: true, interrupted: true, now: 1.1))
precondition(!taps.update(pressed: false, interrupted: false, now: 1.2))
precondition(!taps.update(pressed: true, interrupted: false, now: 1.3), "a chord cancels the first press")
precondition(!taps.update(pressed: false, interrupted: false, now: 1.4))
precondition(!taps.update(pressed: true, interrupted: false, now: 2), "expired taps must not capture")
print("gesture contracts passed")`);
    execFileSync("xcrun", ["swiftc", "native/computer-use/ModifierDoubleTap.swift", source, "-o", binary], { timeout: 30_000 });
    assert.match(execFileSync(binary, { encoding: "utf8", timeout: 5000 }), /gesture contracts passed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
