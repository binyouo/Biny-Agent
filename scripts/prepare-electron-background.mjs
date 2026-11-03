import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// 开发版与发布包使用相同启动身份，防止 Host 在 JS 执行前出现在 Dock。
// 发布包的配置在 config/electron-builder.yml；常规桌面入口显式恢复 regular 策略。
if (process.platform === "darwin") {
  const executable = createRequire(import.meta.url)("electron");
  const plist = path.join(path.dirname(path.dirname(executable)), "Info.plist");
  const value = spawnSync("/usr/bin/plutil", ["-extract", "LSUIElement", "raw", plist], { encoding: "utf8" });
  if (value.status !== 0 || value.stdout.trim() !== "true") {
    execFileSync("/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "true", plist]);
  }
}
