import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("double modifier supports both keys without counting a single hold twice", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bcu-hotkey-"));
  try {
    const source = path.join(directory, "main.swift"), binary = path.join(directory, "hotkey");
    writeFileSync(source, `import Foundation
import CoreGraphics
for (name, modifier, pair) in [("DoubleCommand", CGEventFlags.maskCommand, UInt64(0x18)), ("DoubleOption", CGEventFlags.maskAlternate, UInt64(0x60)), ("DoubleShift", CGEventFlags.maskShift, UInt64(0x06)), ("double-ctrl", CGEventFlags.maskControl, UInt64(0x2001))] {
    guard let spec = parseHotkey(name) else { fatalError("missing shortcut: \\(name)") }
    precondition(spec.bareModifier == modifier)
    precondition(spec.bothHeld(in: CGEventFlags(rawValue: modifier.rawValue | pair)), "both device bits must match")
    precondition(!spec.bothHeld(in: CGEventFlags(rawValue: modifier.rawValue)), "an aggregate modifier alone is not both keys")
}
precondition(parseHotkey("double-cmd")?.bareModifier == .maskCommand)
precondition(parseHotkey("Control+Alt+C")?.keyCode == 8)
precondition(parseHotkey("DoubleUnknown") == nil)
var tap = ModifierDoubleTap()
precondition(!tap.update(pressed: true, both: false, interrupted: false, now: 1))
precondition(tap.update(pressed: true, both: true, interrupted: false, now: 1.1), "both keys must trigger")
precondition(!tap.update(pressed: true, both: true, interrupted: false, now: 1.2), "holding both keys must not retrigger")
precondition(!tap.update(pressed: true, both: false, interrupted: false, now: 1.3))
precondition(!tap.update(pressed: true, both: true, interrupted: false, now: 1.35), "release both before another gesture")
precondition(!tap.update(pressed: false, both: false, interrupted: false, now: 1.4))
precondition(!tap.update(pressed: true, both: false, interrupted: false, now: 1.5), "a simultaneous gesture must not create a spare tap")
precondition(!tap.update(pressed: false, both: false, interrupted: false, now: 1.6))
precondition(tap.update(pressed: true, both: false, interrupted: false, now: 1.7), "two individual presses must trigger")
precondition(!tap.update(pressed: false, interrupted: false, now: 1.8))
precondition(!tap.update(pressed: true, interrupted: false, now: 2))
precondition(!tap.update(pressed: true, interrupted: true, now: 2.1))
precondition(!tap.update(pressed: true, interrupted: false, now: 2.2), "ending a chord while holding the modifier is not a new tap")
precondition(!tap.update(pressed: false, interrupted: false, now: 2.3))
precondition(!tap.update(pressed: true, interrupted: false, now: 2.4))
precondition(!tap.update(pressed: false, interrupted: false, now: 2.5))
precondition(tap.update(pressed: true, interrupted: false, now: 2.6), "a fresh double tap after a chord must work")
precondition(!tap.update(pressed: false, interrupted: false, now: 2.7))
precondition(!tap.update(pressed: true, interrupted: true, now: 3))
precondition(!tap.update(pressed: true, both: true, interrupted: true, now: 3.1), "another modifier must prevent a simultaneous trigger")
print("ok")`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/Hotkey.swift", "native/computer-use/ModifierDoubleTap.swift", source, "-framework", "CoreGraphics", "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
