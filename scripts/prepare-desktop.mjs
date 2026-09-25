/**
 * Desktop 开发环境增量准备。
 *
 * Activity sidecar 只在源码变更后重建；Electron 只在二进制缺失时补装；node-pty
 * 只在 Electron/node-pty 版本或平台变化后重建。避免每次 `desktop:dev` 都重复跑原生编译。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const packageRoot = path.join(root, "node_modules");
const cacheRoot = path.join(packageRoot, ".cache/biny");
const stampPath = path.join(cacheRoot, "desktop-prepare.json");
const activityBinaries = ["activity-input-monitor", "activity-ocr", "computer-use"];
const calendarSource = path.join(root, "native/calendar-reader/main.swift");
const calendarPlist = path.join(root, "native/calendar-reader/Info.plist");
const calendarOutput = path.join(root, "out/native/calendar-reader");
const electronRoot = path.join(packageRoot, "electron");
const nodePtyRoot = path.join(packageRoot, "node-pty");
const electronVersion = packageVersion(electronRoot, "electron");
const nodePtyVersion = packageVersion(nodePtyRoot, "node-pty");
const nativeKey = [process.platform, process.arch, electronVersion, nodePtyVersion].join(":");
const previous = readStamp();
const actions = [];

if (process.platform === "darwin" && (force || activityBinaries.some(name => isOlder(path.join(root, "out/native", name), path.join(root, "native", name, "main.swift"))))) {
  actions.push("activity-sidecar");
}
if (process.platform === "darwin" && (force || isOlder(calendarOutput, calendarSource) || isOlder(calendarOutput, calendarPlist))) {
  actions.push("calendar-sidecar");
}
if (force || !existsSync(electronExecutable())) actions.push("electron");
if (force || previous?.nativeKey !== nativeKey || !existsSync(path.join(nodePtyRoot, "build/Release/pty.node"))) {
  actions.push("node-pty");
}

if (!actions.length) {
  console.log("Desktop 原生依赖已是最新状态。");
  process.exit(0);
}
if (dryRun) {
  console.log(`Desktop 需要准备：${actions.join(", ")}`);
  process.exit(0);
}

if (actions.includes("activity-sidecar")) run(process.execPath, [path.join(root, "scripts/build-activity-sidecar.mjs")]);
if (actions.includes("calendar-sidecar")) run(process.execPath, [path.join(root, "scripts/build-calendar-sidecar.mjs")]);
if (actions.includes("electron")) run(pnpmCommand(), ["exec", "install-electron", "--no"]);
if (actions.includes("node-pty")) run(pnpmCommand(), ["exec", "electron-rebuild", "-w", "node-pty"]);

mkdirSync(cacheRoot, { recursive: true });
writeFileSync(stampPath, `${JSON.stringify({ nativeKey, preparedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
console.log(`Desktop 准备完成：${actions.join(", ")}`);

function packageVersion(packageDirectory, name) {
  const filePath = path.join(packageDirectory, "package.json");
  if (!existsSync(filePath)) throw new Error(`缺少 ${name}，请先运行 pnpm install。`);
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof value.version !== "string" || !value.version) throw new Error(`${name} package.json 缺少 version。`);
  return value.version;
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isOlder(output, source) {
  if (!existsSync(output)) return true;
  return statSync(output).mtimeMs < statSync(source).mtimeMs;
}

function electronExecutable() {
  if (process.platform === "darwin") return path.join(electronRoot, "dist/Electron.app/Contents/MacOS/Electron");
  if (process.platform === "win32") return path.join(electronRoot, "dist/electron.exe");
  return path.join(electronRoot, "dist/electron");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
