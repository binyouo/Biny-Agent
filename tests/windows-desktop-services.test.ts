import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DesktopTerminalManager } from "../src/desktop/electron/main/DesktopTerminalManager.js";

test("Windows Desktop terminal and preview use cmd syntax when PowerShell is unavailable", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const saved = { Path: process.env.Path, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, ProgramFiles: process.env.ProgramFiles };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.Path = "";
  process.env.PATH = "";
  process.env.SystemRoot = "C:\\biny-nonexistent-system";
  process.env.ProgramFiles = "C:\\biny-nonexistent-programs";
  process.env.ComSpec = "C:\\biny-nonexistent-system\\cmd.exe";
  const launches: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const writes: string[] = [];
  let stopped = 0;
  let output: ((data: string) => void) | undefined;
  const fake = {
    spawn(executable: string, args: string[], options: { cwd: string }) {
      launches.push({ executable, args, cwd: options.cwd });
      return { resize() {}, onData(listener: (data: string) => void) { output = listener; }, onExit() {}, write(value: string) { writes.push(value); }, kill() { stopped++; } };
    }
  };
  Object.assign(globalThis, { __windowsPty: fake });
  const hook = registerHooks({ load(url, context, next) {
    return /\/node-pty\/lib\/index\.js$/u.test(url)
      ? { format: "module", source: "export const {spawn}=globalThis.__windowsPty;", shortCircuit: true }
      : next(url, context);
  } });
  const updates: unknown[] = [];
  const manager = new DesktopTerminalManager((event) => updates.push(event));
  try {
    const [first, second] = await Promise.all([
      manager.startPreview("project", "C:\\work\\中文 项目", "npm run dev"),
      manager.startPreview("project", "C:\\work\\中文 项目", "npm run dev")
    ]);
    assert.equal(first.terminalId, second.terminalId);
    assert.deepEqual(launches, [{ executable: "C:\\biny-nonexistent-system\\cmd.exe", args: ["/d"], cwd: "C:\\work\\中文 项目" }]);
    assert.deepEqual(writes, ["npm run dev & exit\r"]);
    output?.("中文终端输出");
    assert.deepEqual(updates, [{ terminalId: first.terminalId, type: "data", data: "中文终端输出", sequence: 1 }]);
    manager.disposeAll();
    assert.equal(stopped, 1);
    assert.deepEqual(manager.list("project"), []);
  } finally {
    manager.disposeAll();
    hook.deregister();
    Reflect.deleteProperty(globalThis, "__windowsPty");
    Object.defineProperty(process, "platform", platform);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
