import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("native window inventory preserves AX identity, minimized windows and unknown metadata without positional joins", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-window-list-"));
  try {
    const source = path.join(directory, "main.swift"), executable = path.join(directory, "fixture");
    writeFileSync(source, `import Foundation
import CoreGraphics
func screen(_ id: Int, pid: Int = 12, title: String = "", onscreen: Bool = true, layer: Int = 0, width: Double = 640) -> [String: Any] {
    [kCGWindowNumber as String: id, kCGWindowOwnerPID as String: pid, kCGWindowName as String: title,
     kCGWindowIsOnscreen as String: onscreen, kCGWindowLayer as String: layer,
     kCGWindowBounds as String: ["X": 10, "Y": 20, "Width": width, "Height": 480]]
}
let ax: [[String: Any]] = [
    ["window_id": 42, "index": 0, "title": "First", "focused": true, "minimized": false],
    ["window_id": 43, "index": 1, "title": "Minimized", "focused": false, "minimized": true],
    ["window_id": 44, "index": 2, "title": "Last", "focused": false, "minimized": false]
]
let results: [String: Any] = try [
    "reordered": mergeApplicationWindows(pid: 12, axEntries: ax, screenWindows: [screen(44), screen(42)]),
    "minimized": mergeApplicationWindows(pid: 12, axEntries: ax, screenWindows: [screen(43, onscreen: false), screen(44), screen(42)]),
    "unknown": mergeApplicationWindows(pid: 12, axEntries: [["window_id": 0, "title": "Unknown AX", "index": 0]], screenWindows: [screen(50, title: "Custom UI")]),
    "filtered": mergeApplicationWindows(pid: 12, axEntries: [], screenWindows: [screen(1, pid: 99), screen(2, layer: 3), screen(3, width: 2), screen(0), screen(50, title: "Custom UI", onscreen: false)]),
    "fallback": mergeApplicationWindows(pid: 12, axEntries: [["window_id": 42, "title": "", "index": 0]], screenWindows: [screen(42, title: "Screen title")]),
    "unavailable": mergeApplicationWindows(pid: 12, axEntries: ax, screenWindows: nil)
]
let data = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/WindowListing.swift", source, "-o", executable], { timeout: 25_000 });
    const result = JSON.parse(execFileSync(executable, { encoding: "utf8", timeout: 3_000 }));
    const frame = { x: 10, y: 20, w: 640, h: 480 };
    const first = { window_id: 42, index: 0, title: "First", focused: true, minimized: false };
    const minimized = { window_id: 43, index: 1, title: "Minimized", focused: false, minimized: true };
    const last = { window_id: 44, index: 2, title: "Last", focused: false, minimized: false };
    assert.deepEqual(result.reordered, [{ ...first, frame, onscreen: true }, minimized, { ...last, frame, onscreen: true }], "screen ordering must not replace AX identity or drop minimized windows");
    assert.deepEqual(result.minimized, [{ ...first, frame, onscreen: true }, { ...minimized, frame, onscreen: false }, { ...last, frame, onscreen: true }]);
    assert.deepEqual(result.unknown, [{ window_id: 0, title: "Unknown AX", index: 0 }, { window_id: 50, title: "Custom UI", frame, onscreen: true }], "an unknown AX identity must not borrow a title, window ID or state from a positional match");
    assert.deepEqual(result.filtered, [{ window_id: 50, title: "Custom UI", frame, onscreen: false }]);
    assert.deepEqual(result.fallback, [{ window_id: 42, index: 0, title: "Screen title", frame, onscreen: true }]);
    assert.deepEqual(result.unavailable, [first, minimized, last]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native default observation chooses the focused window and keeps explicit targets exact", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-observation-window-"));
  try {
    const source = path.join(directory, "main.swift"), executable = path.join(directory, "fixture");
    writeFileSync(source, `import Foundation
func selection(_ requested: Any?, _ windows: [[String: Any]]) -> String {
    do { return String(try selectObservationWindow(requested, windows: { windows })) }
    catch { return error.localizedDescription }
}
let results: [String: Any] = [
    "focused": selection(nil, [["window_id": 42, "focused": false], ["window_id": 43, "focused": true]]),
    "single": selection(nil, [["window_id": 42]]),
    "unknownIdentity": selection(nil, [["window_id": 0, "focused": true], ["window_id": 43]]),
    "ambiguous": selection(nil, [["window_id": 42], ["window_id": 43]]),
    "conflictingFocus": selection(nil, [["window_id": 42, "focused": true], ["window_id": 43, "focused": true]]),
    "empty": selection(nil, []),
    "invalid": [NSNull(), 0, -1, 4294967296, 1.5, "42", NSNumber(value: true)].map { selection($0, [["window_id": 42]]) },
    "explicit": try selectObservationWindow(44, windows: { fatalError("an explicit target must not be replaced by another window") })
]
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/WindowListing.swift", source, "-o", executable], { timeout: 25_000 });
    const result = JSON.parse(execFileSync(executable, { encoding: "utf8", timeout: 3_000 }));
    assert.equal(result.focused, "43");
    assert.equal(result.single, "42");
    assert.equal(result.unknownIdentity, "43");
    assert.equal(result.explicit, 44);
    for (const name of ["ambiguous", "conflictingFocus"]) assert.match(result[name], /^computer_window_selection_required:/u);
    assert.match(result.empty, /^computer_window_not_ready:/u);
    for (const error of result.invalid) assert.match(error, /^capture_target_invalid:/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native window reads distinguish empty, unsupported, permission denial and transport failure", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-window-read-"));
  try {
    const source = path.join(directory, "main.swift"), executable = path.join(directory, "fixture");
    writeFileSync(source, `import Foundation
import ApplicationServices
func result(_ status: AXError, _ elements: [AXUIElement]?) -> String {
    do { return try windowListElements(status, elements: elements).map { "count:\\($0.count)" } ?? "unsupported" }
    catch { return error.localizedDescription }
}
func inventory(_ ax: [[String: Any]]?, _ screen: [[String: Any]]?) -> String {
    do { return "count:\\(try mergeApplicationWindows(pid: 12, axEntries: ax, screenWindows: screen).count)" }
    catch { return error.localizedDescription }
}
let results: [String: String] = [
    "empty": result(.success, []), "noValue": result(.noValue, nil),
    "unsupported": result(.attributeUnsupported, nil), "notImplemented": result(.notImplemented, nil),
    "malformed": result(.success, nil), "permission": result(.apiDisabled, nil),
    "disconnected": result(.cannotComplete, nil), "stale": result(.invalidUIElement, nil),
    "unexpected": result(.failure, nil),
    "bothUnavailable": inventory(nil, nil), "emptyAX": inventory([], nil), "emptyCG": inventory(nil, [])
]
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/WindowListing.swift", source, "-o", executable], { timeout: 25_000 });
    const result = JSON.parse(execFileSync(executable, { encoding: "utf8", timeout: 3_000 }));
    assert.match(result.malformed, /^window_list_invalid:/u);
    assert.match(result.permission, /^ax_not_granted:/u);
    for (const name of ["disconnected", "stale", "unexpected"]) assert.match(result[name], /^window_list_read_failed: AXError -\d+/u);
    assert.match(result.bothUnavailable, /^window_list_unavailable:/u);
    assert.equal(result.emptyAX, "count:0");
    assert.equal(result.emptyCG, "count:0");
    assert.equal(result.empty, "count:0");
    assert.equal(result.noValue, "count:0");
    assert.equal(result.unsupported, "unsupported");
    assert.equal(result.notImplemented, "unsupported");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
