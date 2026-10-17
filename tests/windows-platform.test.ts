import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runShellCommand, createRunCommandTool } from "../src/tools/shell/runCommand.js";
import { detectShell, interactiveShellInvocation, shellCommandInvocation } from "../src/tools/shell/shell.js";

test("Windows Host discovery separates named pipes from private registration and lock files", () => {
  const environment = { platform: "win32" as const, temporaryDirectory: "C:\\Temp", agentRoot: "C:\\Users\\test\\.biny\\agent" };
  const pathsFor = runtimeHostPaths;
  const first = pathsFor("C:\\work\\one", environment);
  assert.match(first.endpoint, /^\\\\\.\\pipe\\biny-/u);
  assert.match(first.registrationPath, /^C:\\Users\\test\\\.biny\\agent\\runtime-host\\/u);
  assert.ok(!first.registrationPath.startsWith("\\\\.\\pipe\\"));
  assert.notEqual(first.endpoint, pathsFor("C:\\work\\two", environment).endpoint);
  assert.notEqual(first.endpoint, pathsFor("C:\\work\\one", { ...environment, agentRoot: "C:\\Users\\other\\.biny\\agent" }).endpoint);
  assert.deepEqual(first, pathsFor("C:\\work\\one\\.", environment));
});

test("Windows shell selection prefers PowerShell 7, then 5.1, and finally cmd", () => {
  const env = { Path: '"C:\\Tools";C:\\Windows', SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const files = new Set(["C:\\Tools\\pwsh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  const environment = { platform: "win32" as const, env, fileExists: (file: string) => files.has(file) };
  assert.deepEqual(detectShell(environment), { kind: "pwsh", executable: "C:\\Tools\\pwsh.exe" });
  files.delete("C:\\Tools\\pwsh.exe");
  assert.deepEqual(detectShell(environment), { kind: "powershell", executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
  files.clear();
  assert.deepEqual(detectShell(environment), { kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" });
  assert.deepEqual(interactiveShellInvocation({ kind: "pwsh", executable: "C:\\Tools\\pwsh.exe" }), { executable: "C:\\Tools\\pwsh.exe", args: ["-NoLogo"] });
  assert.deepEqual(interactiveShellInvocation({ kind: "cmd", executable: env.ComSpec }), { executable: env.ComSpec, args: ["/d"] });
});

test("PowerShell carries command text outside argv and replaces inherited private command slots", () => {
  const command = "using namespace System\nWrite-Output '中文; $x `quoted`'";
  const invocation = shellCommandInvocation({ kind: "powershell", executable: "powershell.exe" }, command, { Path: "C:\\Tools", biny_shell_command: "stale-command" });
  assert.ok(!invocation.args.some((arg) => arg.includes(command)));
  assert.deepEqual(invocation.env, { Path: "C:\\Tools", BINY_SHELL_COMMAND: command });
  const script = Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /SetEnvironmentVariable\('BINY_SHELL_COMMAND', \$null\)/u);
});

test("foreground Bash executes the declared Windows shell explicitly and preserves Unicode output", async (context) => {
  const calls: unknown[][] = [];
  const spawn = context.mock.method(childProcess, "spawn", (...args: unknown[]) => {
    calls.push(args);
    const child = new EventEmitter() as childProcess.ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout!.emit("data", Buffer.from("中文输出"));
      child.emit("close", 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const options = { shell: { kind: "powershell" as const, executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" } };
    const result = await runShellCommand(process.cwd(), "Write-Output '中文输出'", options);
    assert.equal(result.stdout, "中文输出");
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0]![0], options.shell.executable);
    assert.ok(Array.isArray(calls[0]![1]));
    const invocation = calls[0]![2] as { shell: boolean; windowsHide: boolean };
    assert.equal(invocation.shell, false);
    assert.equal(invocation.windowsHide, true);
    const tool = createRunCommandTool({ workspaceRoot: process.cwd(), ignore: [] }, undefined, options);
    assert.match(tool.description, /PowerShell 5\.1/u);
    assert.match(tool.description, /PowerShell syntax/u);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});
