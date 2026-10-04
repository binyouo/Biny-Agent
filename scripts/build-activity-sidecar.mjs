import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


if (process.platform !== "darwin") {
  console.log("Activity sidecar 仅在 macOS 构建；当前平台跳过。");
  process.exit(0);
}

rmSync(path.join(root, "out/native/activity-recorder"), {force:true});

// computer-use daemon 需要 AX / ScreenCaptureKit / CG，单独编译。
const frameworks = {
  "computer-use": ["-framework", "AppKit", "-framework", "ScreenCaptureKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics"]
};
for (const name of ["activity-input-monitor", "activity-ocr", "computer-use"]) {
  const source = path.join(root, "native", name, "main.swift");
  const output = path.join(root, "out/native", name);
  mkdirSync(path.dirname(output), { recursive: true });
  const extra = frameworks[name] ?? [];
  const result = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", output, source, ...extra], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  chmodSync(output, 0o755);
}
