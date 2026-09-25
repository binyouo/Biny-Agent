/** 编译只读日历辅助程序，并把隐私用途说明嵌入 Mach-O 供 EventKit 权限检查。 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "native/calendar-reader/main.swift");
const plist = path.join(root, "native/calendar-reader/Info.plist");
const output = path.join(root, "out/native/calendar-reader");
const cliOutput = path.join(root, "dist/native/calendar-reader");
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(path.dirname(cliOutput), { recursive: true });
const result = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", "-Xlinker", "-sectcreate",
  "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist, "-o", output, source], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(output, 0o755);
copyFileSync(output, cliOutput);
chmodSync(cliOutput, 0o755);
