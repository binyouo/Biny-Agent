import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


if (process.platform !== "darwin") {
  console.log("Activity sidecar 仅在 macOS 构建；当前平台跳过。");
  process.exit(0);
}

rmSync(path.join(root, "out/native/activity-recorder"), {force:true});

for (const name of ["activity-input-monitor", "activity-ocr"]) {
  const source = path.join(root, "native", name, "main.swift");
  const output = path.join(root, "out/native", name);
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", output, source], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(output, 0o755);
}

// ---- computer-use daemon：必须打成 .app ----
// 屏幕录制（TCC）按 bundle 身份授权。裸可执行文件只能靠父进程继承权限：
// 从终端起时能用，被 Electron 拉起时拿不到画面。Alma 的原版同样是
// 「Alma Computer Use.app」独立包（alma-reverse: 16-电脑操控 §1）。
const bundleRoot = path.join(root, "out/native/computer-use.app");
const infoDir = path.join(bundleRoot, "Contents");
const macosDir = path.join(infoDir, "MacOS");
const bundleBinary = path.join(macosDir, "computer-use");
const linkPath = path.join(root, "out/native/computer-use");
rmSync(bundleRoot, { recursive: true, force: true });
rmSync(linkPath, { force: true });
mkdirSync(macosDir, { recursive: true });
writeFileSync(
  path.join(infoDir, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.biny.computer-use</string>
  <key>CFBundleName</key><string>Biny Computer Use</string>
  <key>CFBundleDisplayName</key><string>Biny Computer Use</string>
  <key>CFBundleExecutable</key><string>computer-use</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`
);
const built = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", bundleBinary, path.join(root, "native/computer-use/main.swift"), "-framework", "AppKit", "-framework", "ScreenCaptureKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics"], { stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
chmodSync(bundleBinary, 0o755);
// 临时签名：让 bundle 有稳定身份，TCC 授权才能挂上去。正式发布需要开发者证书。
spawnSync("codesign", ["--force", "--sign", "-", bundleRoot], { stdio: "inherit" });
// 保留旧路径：符号链接指进 bundle，现有调用方无需改动，
// 而 TCC 会按解析后的 bundle 归属授权。
symlinkSync(bundleBinary, linkPath);
