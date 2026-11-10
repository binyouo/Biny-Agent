import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("native pointer projects multiple displays and mirror letterboxing, preserves action identity and respects reduced motion", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-indicator-"));
  try {
    const source = path.join(directory, "main.swift"), executable = path.join(directory, "test");
    await writeFile(source, `import AppKit
import QuartzCore
import ImageIO
let main = CGRect(x: 0, y: 0, width: 1600, height: 900)
let left = CGRect(x: -1200, y: 0, width: 1200, height: 700)
let above = CGRect(x: 0, y: 900, width: 1600, height: 900)
let right = CGRect(x: 1600, y: -300, width: 1200, height: 1000)
precondition(ActionCursorGeometry.screenPoint(CGPoint(x: 300, y: 200), screen: main, desktopTop: 900) == CGPoint(x: 300, y: 200))
precondition(ActionCursorGeometry.screenPoint(CGPoint(x: -600, y: 350), screen: left, desktopTop: 900) == CGPoint(x: 600, y: 150))
precondition(ActionCursorGeometry.screenPoint(CGPoint(x: 400, y: -200), screen: above, desktopTop: 900) == CGPoint(x: 400, y: 700))
precondition(ActionCursorGeometry.screenPoint(CGPoint(x: 1700, y: 600), screen: right, desktopTop: 900) == CGPoint(x: 100, y: 400))
precondition(ActionCursorGeometry.screenPoint(CGPoint(x: -600, y: 350), screen: main, desktopTop: 900) == nil)
let bounds = CGRect(x: 0, y: 0, width: 400, height: 300), point = CGPoint(x: 0.25, y: 0.5)
precondition(ActionCursorGeometry.imagePoint(point, image: CGSize(width: 800, height: 400), bounds: bounds) == CGPoint(x: 100, y: 150))
precondition(ActionCursorGeometry.imagePoint(point, image: CGSize(width: 400, height: 800), bounds: bounds) == CGPoint(x: 162.5, y: 150))
precondition(ActionCursorGeometry.imagePoint(point, image: .zero, bounds: bounds) == nil)
precondition(ActionCursorGeometry.imagePoint(CGPoint(x: 2, y: 0), image: CGSize(width: 400, height: 800), bounds: bounds) == nil)
func window(_ pid: Int, _ id: Int, layer: Int = 0, alpha: Double = 1) -> [String: Any] {
    [kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id, kCGWindowLayer as String: layer, kCGWindowAlpha as String: alpha,
     kCGWindowBounds as String: ["X": 0, "Y": 0, "Width": 400, "Height": 300]]
}
let source = window(12, 42), other = window(13, 43), own = window(99, 44)
precondition(ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [source, other], ignoringPID: 99))
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [other, source], ignoringPID: 99))
precondition(ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [own, window(13, 45, alpha: 0), source], ignoringPID: 99))
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [], ignoringPID: 99))
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [window(13, 42)], ignoringPID: 99))
let display = CGRect(x: 0, y: 0, width: 400, height: 300)
let dockBackdrop = window(55, 71, layer: Int(CGWindowLevelForKey(.dockWindow)))
precondition(ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [dockBackdrop, source], ignoringPID: 99, dockPID: 55, displays: [display]), "the system Dock display backdrop must not hide a visible action pointer")
var dockBar = dockBackdrop
dockBar[kCGWindowBounds as String] = ["X": 0, "Y": 100, "Width": 400, "Height": 100]
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [dockBar, source], ignoringPID: 99, dockPID: 55, displays: [display]), "the visible Dock bar still occludes the target")
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [other, dockBackdrop, source], ignoringPID: 99, dockPID: 55, displays: [display]), "an application in front must still hide the desktop pointer")
precondition(!ActionCursorGeometry.windowVisible(at: CGPoint(x: 100, y: 150), pid: 12, windowID: 42, windows: [dockBackdrop, source], ignoringPID: 99, dockPID: 56, displays: [display]), "an unrelated process cannot claim the Dock exception")
var now: TimeInterval = 10
let cursor = ActionCursor(now: { now }), frame = CGRect(x: 300, y: 200, width: 800, height: 400)
_ = cursor.mark(pid: 12, windowID: 42, owner: "a", point: CGPoint(x: 500, y: 400), action: .click)
let first = cursor.snapshot(pid: 12, windowID: 42, frame: frame)!
precondition(first.point == point && first.action == .click && first.remainingMs == 8000)
precondition(cursor.snapshot(pid: 12, windowID: 43, frame: frame) == nil)
precondition(cursor.snapshot(pid: 12, windowID: 42, frame: frame)!.eventID == first.eventID)
_ = cursor.mark(pid: 12, windowID: 42, owner: "a", point: nil, action: .scroll, symbol: "arrow.down")
let second = cursor.snapshot(pid: 12, windowID: 42, frame: frame)!
precondition(second.point == point && second.eventID > first.eventID && second.symbol == "arrow.down")
cursor.clear(pid: 99, windowID: 42)
precondition(cursor.snapshot(pid: 12, windowID: 42, frame: frame) != nil)
cursor.clear(pid: 12, windowID: 42)
precondition(cursor.snapshot(pid: 12, windowID: 42, frame: frame) == nil)
precondition(cursor.mark(pid: 12, windowID: 42, owner: "a", point: nil) == nil)
_ = cursor.mark(pid: 12, windowID: 42, owner: "a", point: CGPoint(x: 500, y: 400))
now = 19
precondition(cursor.snapshot(pid: 12, windowID: 42, frame: frame) == nil)
MainActor.assumeIsolated {
    NSApplication.shared.setActivationPolicy(.prohibited)
    let view = ActionIndicatorView(frame: bounds)
    precondition(ActionIndicatorView.hotspot == CGPoint(x: 13, y: 22), "the character's feet must stay on the actual input point")
    precondition(view.isFlipped && view.hitTest(CGPoint(x: 100, y: 150)) == nil)
    view.show(at: CGPoint(x: 100, y: 150), action: .click, symbol: nil, eventID: 1, reduceMotion: false)
    precondition(view.cursorLayer.contents != nil && view.cursorLayer.position == CGPoint(x: 100, y: 150))
    let expiry = Mirror(reflecting: view).descendant("hideTimer") as? Timer
    precondition((expiry?.fireDate.timeIntervalSinceNow ?? 0) > 7, "the desktop character must remain visible between actions instead of flashing for one second")
    precondition(view.pulseLayer.animation(forKey: "click") != nil)
    view.pulseLayer.removeAnimation(forKey: "click")
    view.show(at: CGPoint(x: 100, y: 150), action: .click, symbol: nil, eventID: 1, reduceMotion: false)
    precondition(view.pulseLayer.animation(forKey: "click") == nil)
    precondition(view.cursorLayer.animation(forKey: "move") == nil, "repainting the same action must not restart travel")
    view.show(at: CGPoint(x: 200, y: 150), action: .scroll, symbol: "arrow.down", eventID: 2, reduceMotion: false)
    precondition(view.cursorLayer.animation(forKey: "move") != nil)
    let travel = view.cursorLayer.animation(forKey: "move") as? CAAnimationGroup
    let position = travel?.animations?.compactMap { $0 as? CAKeyframeAnimation }.first { $0.keyPath == "position" }
    precondition((position?.values?.count ?? 0) > 2, "movement needs intermediate hop positions")
    precondition(position?.values?.compactMap { ($0 as? NSValue)?.pointValue.y }.contains(where: { $0 < 150 }) == true, "the character must lift off between endpoints")
    view.show(at: CGPoint(x: 250, y: 150), action: .click, symbol: nil, eventID: 3, reduceMotion: true)
    precondition(view.cursorLayer.animationKeys() == nil && view.pulseLayer.animationKeys() == nil)
    precondition(view.cursorLayer.opacity == 1 && view.pulseLayer.opacity > 0)
    precondition(ActionIndicatorView.cursorPayload?["mimeType"] as? String == "image/png")
    let payload = ActionIndicatorView.cursorPayload!["dataBase64"] as! String
    let png = Data(base64Encoded: payload)!
    let frames = CGImageSourceCreateWithData(png as CFData, nil)!
    precondition(CGImageSourceGetCount(frames) == (NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : 2), "blink frames must respect reduced motion")
    let bitmap = NSBitmapImageRep(cgImage: CGImageSourceCreateImageAtIndex(frames, 0, nil)!)
    precondition(bitmap.pixelsWide == 52 && bitmap.pixelsHigh == 52)
    precondition(bitmap.colorAt(x: 0, y: 0)!.alphaComponent == 0)
    var orangePixels = 0
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
            let color = bitmap.colorAt(x: x, y: y)!
            if color.alphaComponent > 0.9 && abs(color.redComponent - 217.0/255) < 0.01 && abs(color.greenComponent - 119.0/255) < 0.01 && abs(color.blueComponent - 87.0/255) < 0.01 { orangePixels += 1 }
        }
    }
    precondition(orangePixels > 200, "the payload must contain the warm pixel character")
    view.hide()
    precondition(view.cursorLayer.opacity == 0 && view.pulseLayer.opacity == 0)
}
print("pointer behavior passed")
`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/ActionCursor.swift", "native/computer-use/ActionIndicator.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 10_000 }), /pointer behavior passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
