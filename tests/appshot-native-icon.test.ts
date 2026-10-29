import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Appshot icon encoding preserves an optional app icon in a bounded PNG", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-appshot-icon-"));
  try {
    const source = path.join(directory, "main.swift"), binary = path.join(directory, "icon-test");
    writeFileSync(source, `import AppKit
import CoreGraphics
precondition(appshotIconDataURL(nil) == nil)
let context = CGContext(data: nil, width: 512, height: 256, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.setFillColor(CGColor(red: 1, green: 0.25, blue: 0, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 512, height: 256))
let image = NSImage(cgImage: context.makeImage()!, size: NSSize(width: 512, height: 256))
let encoded = appshotIconDataURL(image)!
precondition(encoded.hasPrefix("data:image/png;base64,"))
let data = Data(base64Encoded: String(encoded.dropFirst("data:image/png;base64,".count)))!
let decoded = NSBitmapImageRep(data: data)!
precondition(decoded.pixelsWide == 96 && decoded.pixelsHigh == 96)
precondition(data.count < 256_000)
print("ok")`);
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AppshotIcon.swift", source, "-framework", "AppKit", "-o", binary], { timeout: 25_000 });
    assert.equal(execFileSync(binary, { encoding: "utf8", timeout: 3_000 }).trim(), "ok");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
