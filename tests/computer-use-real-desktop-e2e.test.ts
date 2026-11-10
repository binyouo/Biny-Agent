import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

async function exited(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`real desktop process exceeded ${timeoutMs}ms\n${output}`)); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 3_000);
    const deadline = setTimeout(() => reject(new Error("owned desktop process did not exit after SIGKILL")), 6_000);
    child.once("exit", () => { clearTimeout(kill); clearTimeout(deadline); resolve(); });
    child.kill("SIGTERM");
  });
}

async function stopOwnedHelpers(directory: string, executable: string): Promise<void> {
  const { stdout } = await execute("ps", ["-axo", "pid=,command="], { maxBuffer: 2 * 1024 * 1024 });
  const owned = stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    return match?.[2]?.startsWith(`${executable} daemon `) && match[2].includes(` --socket ${directory}/`) ? [Number(match[1])] : [];
  });
  for (const pid of owned) {
    const signal = (kind: NodeJS.Signals) => {
      try { process.kill(pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const alive = () => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    if (alive()) signal("SIGTERM");
    const killAt = Date.now() + 2_000;
    const deadline = killAt + 2_000;
    while (alive()) {
      if (Date.now() > killAt) signal("SIGKILL");
      assert.ok(Date.now() < deadline, `owned helper ${pid} did not exit; preserving ${directory}`);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  }
}

async function cleanup(processes: { host?: ChildProcess; target?: ChildProcess }, directory: string, executable: string): Promise<void> {
  const stopped = await Promise.allSettled([stop(processes.host), stop(processes.target)]);
  const failures = stopped.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "owned desktop processes did not stop");
  await stopOwnedHelpers(directory, executable);
  await rm(directory, { recursive: true, force: true });
}

test("real Desktop MCP and Capability execution changes AppKit and WKWebView controls without foreground or pointer takeover", {
  skip: process.platform !== "darwin" ? "requires macOS" : process.env.BINY_TEST_COMPUTER_UI !== "1" ? "set BINY_TEST_COMPUTER_UI=1 to run real desktop input" : false,
  timeout: 240_000
}, async t => {
  const helper = await realpath(NativeProcessDriver.resolveBinary());
  const root = await mkdtemp(path.join("/tmp", "biny-rde-"));
  const processes: { target?: ChildProcess; host?: ChildProcess } = {};
  t.after(() => cleanup(processes, root, helper));
  const contents = path.join(root, "RealDesktopFixture.app", "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  const executable = path.join(contents, "MacOS", "fixture");
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.biny.real-desktop-fixture</string><key>CFBundleName</key><string>Biny Real Desktop Fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const compile = await exited(spawn("xcrun", ["swiftc", "-swift-version", "5", fileURLToPath(new URL("fixtures/computer-use-real-desktop.swift", import.meta.url)), "-framework", "AppKit", "-framework", "WebKit", "-o", executable], { stdio: ["ignore", "pipe", "pipe"] }), 45_000);
  assert.equal(compile.code, 0, compile.output);
  const signed = await exited(spawn("codesign", ["--force", "--sign", "-", path.dirname(contents)], { stdio: ["ignore", "pipe", "pipe"] }), 10_000);
  assert.equal(signed.code, 0, signed.output);
  const environment = await exited(spawn(executable, ["--environment"], { stdio: ["ignore", "pipe", "pipe"] }), 5_000);
  assert.equal(environment.code, 0, environment.output);
  const session = JSON.parse(environment.output) as { locked: boolean; onConsole: boolean; activeDisplays: number };
  if (session.locked || !session.onConsole || session.activeDisplays === 0) {
    t.skip(`real desktop unavailable: locked=${session.locked}, onConsole=${session.onConsole}, activeDisplays=${session.activeDisplays}; unlock the console session before running UI input`);
    return;
  }
  await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  const outfile = path.join(root, "host.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/computer-use-real-desktop-host.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error" });
  const scenarios = ["native", "floating", "geometry", "scroll", "web", "lifecycle", "post-input-close", "cancellation", "pointer"];
  const selected = process.env.BINY_TEST_COMPUTER_SCENARIO;
  assert.ok(selected === undefined || scenarios.includes(selected), "BINY_TEST_COMPUTER_SCENARIO must name an existing scenario");
  for (const scenario of scenarios.filter(name => selected === undefined || selected === name)) await t.test(scenario, async subtest => {
    const caseRoot = await mkdtemp(path.join(root, "case-"));
    try {
      processes.target = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
      const fixture = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`owned fixture did not become ready\n${output}`)), 20_000);
        const append = (chunk: Buffer) => {
          output += String(chunk);
          const match = output.match(/^FIXTURE_READY (.+)$/mu);
          if (match) { clearTimeout(timer); processes.target!.stdout!.off("data", append); resolve(match[1]!); }
        };
        processes.target!.stdout!.on("data", append);
        processes.target!.stderr!.on("data", chunk => { output += String(chunk); });
        processes.target!.once("error", error => { clearTimeout(timer); reject(error); });
        processes.target!.once("exit", code => { clearTimeout(timer); reject(new Error(`owned fixture exited before readiness (${code})\n${output}`)); });
      });
      processes.host = spawn(require("electron") as string, [outfile], { stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, ELECTRON_RUN_AS_NODE: "", BINY_AGENT_DIR: path.join(caseRoot, "agent"), BINY_REAL_DESKTOP_ROOT: caseRoot, BINY_REAL_DESKTOP_SCENARIO: scenario,
        BINY_REAL_DESKTOP_HELPER: helper, BINY_REAL_DESKTOP_FIXTURE_EXE: executable, BINY_REAL_DESKTOP_FIXTURE: fixture
      } });
      processes.host.stdout?.on("data", chunk => process.stdout.write(String(chunk)));
      const result = await exited(processes.host, 45_000);
      assert.equal(result.code, 0, result.output);
      const line = result.output.match(/^REAL_DESKTOP_RESULT (.+)$/mu)?.[1];
      assert.ok(line, `the actual Electron host must report a result\n${result.output}`);
      const outcome = JSON.parse(line) as { skip?: string; passed?: boolean; scenario?: string; calls?: number; clicks?: number; panelClicks?: number; closedByInput?: number; text?: string; wheelEvents?: number; panelWheelEvents?: number; web?: { clicks: number; text: string } };
      if (outcome.skip) { subtest.skip(outcome.skip); return; }
      assert.equal(outcome.passed, true);
      assert.equal(outcome.scenario, scenario);
      assert.ok((outcome.calls ?? 0) >= 3, "each scenario must execute the actual observation and input chain");
      if (scenario === "native") { assert.equal(outcome.clicks, 1); assert.equal(outcome.text, "键盘输入 ABC"); }
      if (scenario === "geometry") assert.equal(outcome.clicks, 2);
      if (scenario === "floating" || scenario === "scroll") assert.equal(outcome.panelClicks, 1);
      if (scenario === "scroll") { assert.ok(outcome.wheelEvents! > 0); assert.ok(outcome.panelWheelEvents! > 0); }
      if (scenario === "web") assert.deepEqual(outcome.web && { clicks: outcome.web.clicks, text: outcome.web.text }, { clicks: 1, text: "Web 中文 123" });
      if (scenario === "lifecycle") assert.equal(outcome.clicks, 1);
      if (scenario === "post-input-close") assert.equal(outcome.closedByInput, 1);
      if (scenario === "cancellation") assert.ok(outcome.text!.length >= 8 && outcome.text!.length < 3500);
      if (scenario === "pointer") assert.equal(outcome.clicks, 2);
    } finally {
      await cleanup(processes, caseRoot, helper);
    }
  });
});
