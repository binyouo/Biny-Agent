import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Command } from "commander";
import { registerComputerCommands } from "../src/cli/commands/computer.js";
import { computerDesktopEndpoint } from "../src/computer/desktopActivity.js";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { requestComputer } from "../src/tools/computerUse.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { attachDesktopComputerMcp } from "../src/computer/desktopMcp.js";
import { LocalComputerMcpPolicy } from "../src/computer/mcpPolicy.js";
import { ComputerAuditStore } from "../src/computer/auditStore.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";
import { createComputerUseMcpServer } from "../src/computer/mcpServer.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// 只替换系统窗口边界；工具、Desktop 控制面、审批、driver 和进程通信均用真实装配。
const previewWindows: WindowFixture[] = [];
let previewUserData = "";
class WindowFixture extends EventEmitter {
  destroyed = false;
  presentations = 0;
  bounds = { x: 0, y: 0, width: 380, height: 250 };
  workspaceChanges: unknown[][] = [];
  topChanges: unknown[][] = [];
  paints: string[] = [];
  constructor(readonly options: Record<string, unknown>) { super(); previewWindows.push(this); }
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined,
    isLoading: () => false,
    executeJavaScript: async (script: string) => { this.paints.push(script); }
  });
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
  showInactive() { this.presentations++; }
  setVisibleOnAllWorkspaces(...args: unknown[]) { this.workspaceChanges.push(args); }
  setAlwaysOnTop(...args: unknown[]) { this.topChanges.push(args); }
  destroy() { this.destroyed = true; this.emit("closed"); }
  async loadURL() {}
}
const electron = {
  BrowserWindow: WindowFixture,
  app: { getPath: () => previewUserData },
  nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  screen: { getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getCursorScreenPoint: () => ({ x: 500, y: 500 }), getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  ipcMain: { handle() {}, removeHandler() {} },
  systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }
};
Object.assign(globalThis, { __computerDispatchElectron: electron });

interface JournalEntry { cmd: string; args: Record<string, unknown> }
const target = { pid: 42, windowId: "900" };

test("受控命令行与外部 MCP 共用连续动作和等待链路，原有直接命令行测试不覆盖桌面控制器", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const endpointPath = computerDesktopEndpoint();
  await mkdir(path.dirname(endpointPath), { recursive: true });
  await writeFile(endpointPath, JSON.stringify(f.endpoint), { mode: 0o600 });
  t.after(() => rm(endpointPath, { force: true }));
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => output.push(value));
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerComputerCommands(program);
    await program.parseAsync(["node", "biny", "computer", ...args, "--session", "fixture"]);
  };
  await run("observe", JSON.stringify({ ...target, waitFor: { text: "Fixture" } }), "--json");
  const observed = JSON.parse(output.at(-1)!).data;
  assert.equal(observed.wait.matched, true);
  await run("sequence", JSON.stringify({ ...target, captureId: observed.capture_id, actions: [{ action: "press_key", key: "Return" }] }), "--json");
  assert.equal(JSON.parse(output.at(-1)!).data.completedCount, 1);
  await run("release");
  assert.equal(f.service.controller.status().owner, undefined);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sequence-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const observation = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, waitFor: { text: "Fixture" } } });
    const text = (observation.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
    const captureId = (JSON.parse(text.split("\n")[0]!) as { capture_id: string }).capture_id;
    const result = await client.callTool({ name: "sequence", arguments: { ...target, captureId, actions: [{ action: "press_key", key: "Return" }] } });
    assert.equal(result.isError, false);
    assert.equal((result.content as { type: string }[]).some(part => part.type === "image"), true);
  } finally { await client.close(); await server.close(); }
});

test("按文字匹配选区使用独立参数且不发送替换内容，原有位置选区测试无法防止误写正文", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  await assert.rejects(f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "select_text", elementToken: "e1", matchText: "目标", text: "不应写入" }));
  await f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "select_text", elementToken: "e1", matchText: "目标", prefix: "前文", suffix: "后文" });
  const entry = (await f.entries()).find(entry => entry.cmd === "select_text")!;
  assert.equal(entry.args.match_text, "目标");
  assert.equal(entry.args.prefix, "前文");
  assert.equal(entry.args.suffix, "后文");
  assert.equal(entry.args.text, undefined);
  assert.equal(entry.args.location, undefined);
});

test("外部 MCP 文字选区通过 Desktop 放置光标而不替换正文", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "selection-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const observed = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual(observed.isError, true);
    const result = await client.callTool({ name: "select_text", arguments: {
      pid: 42, window_id: 900, ref: "e1", text: "目标", prefix: "前", suffix: "后", selection_type: "cursor_after"
    } });
    assert.notEqual(result.isError, true);
    const entry = (await f.entries()).find(entry => entry.cmd === "select_text")!;
    assert.equal(entry.args.match_text, "目标");
    assert.equal(entry.args.selection_type, "cursor_after");
    assert.equal(entry.args.text, undefined);
  } finally { await client.close(); await server.close(); }
});

test("连续动作在同一窗口逐步刷新凭据并仅返回最终画面，单动作覆盖不能证明后续步骤被实际派发", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified" });
  assert.ok(f.mcp.createTools().some(tool => tool.name === "ComputerSequence"), "必须向模型提供连续动作入口");
  await ensureAgentDirs(f.directory);
  const recorder = new SessionRecorder(f.directory, "fixture-session");
  t.after(() => recorder.close());
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  const registry = new ToolRegistry();
  for (const tool of f.mcp.createTools()) registry.registerMcpTool(tool);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: f.directory, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined, () => ({}));
  const observed = await f.invoke("ComputerObserve", target);
  const executed = await coordinator.createAgentTools().find(tool => tool.name === "ComputerSequence")!.execute("model-sequence", { ...target, captureId: observed.capture_id, actions: [
    { action: "click", x: 1, y: 2 }, { action: "type_text", text: "测试", inputMethod: "unicode" }, { action: "press_key", key: "Return" }
  ] });
  assert.equal(executed.isError, false);
  const result = executed.details as Record<string, unknown>;
  assert.equal(result.completedCount, 3);
  assert.equal(result.imageReturned, true);
  assert.equal(executed.content.filter(part => part.type === "image").length, 1, "中间画面不占用模型图像预算");
  const entries = await f.entries();
  const actions = entries.filter(entry => ["click", "type_text", "press_key"].includes(entry.cmd));
  assert.deepEqual(actions.map(entry => entry.cmd), ["click", "type_text", "press_key"]);
  assert.equal(new Set(actions.map(entry => entry.args.capture_id)).size, 3);
  assert.equal(entries.filter(entry => entry.cmd === "get_app_state").length, 4);
  assert.deepEqual(entries.filter(entry => entry.cmd === "get_app_state").map(entry => entry.args.max_depth), [undefined, 0, 0, undefined]);
  assert.equal(result.verificationRequired, true);
  await recorder.flush();
  const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const event = events.find(event => event.type === "tool_result" && event.toolCallId === "model-sequence");
  assert.equal(event.executionStatus, "succeeded");
  assert.equal(event.result.completedCount, 3);
  assert.equal(event.result.steps.length, 3);
  assert.equal(JSON.stringify(events).includes("/9j/2Q=="), false);
});

for (const route of ["builtin", "desktop-mcp", "cli"] as const) test(`partial native scroll stops the sequence and preserves its receipt: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { partialScroll: true });
  const actions = [{ action: "scroll", elementToken: "e1", direction: "down", pages: 2 }, { action: "type_text", text: "must not be sent" }];
  let result: Record<string, unknown>;
  if (route === "builtin") {
    const observed = await f.invoke("ComputerObserve", target);
    result = await f.invoke("ComputerSequence", { ...target, captureId: observed.capture_id, actions });
    assert.equal(result.imageReturned, true);
  } else if (route === "cli") {
    const endpointPath = computerDesktopEndpoint();
    await mkdir(path.dirname(endpointPath), { recursive: true });
    await writeFile(endpointPath, JSON.stringify(f.endpoint), { mode: 0o600 });
    t.after(() => rm(endpointPath, { force: true }));
    const output: string[] = [];
    t.mock.method(console, "log", (value: string) => output.push(value));
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerComputerCommands(program);
      await program.parseAsync(["node", "biny", "computer", ...args, "--session", "partial-scroll"]);
    };
    await run("observe", JSON.stringify(target), "--json");
    const captureId = JSON.parse(output.at(-1)!).data.capture_id;
    await run("sequence", JSON.stringify({ ...target, captureId, actions }), "--json");
    const reply = JSON.parse(output.at(-1)!);
    assert.equal(reply.images.length, 1);
    result = reply.data;
    await run("release");
  } else {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
    const server = createComputerUseMcpServer(f.driver, policy);
    const client = new Client({ name: "partial-scroll-sequence", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(left), server.connect(right)]);
      assert.match((await client.listTools()).tools.find(tool => tool.name === "sequence")?.description ?? "", /部分完成/);
      const observed = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
      assert.notEqual(observed.isError, true, JSON.stringify(observed.content));
      const captureId = (JSON.parse((observed.content as { text: string }[])[0]!.text) as { capture_id: string }).capture_id;
      const reply = await client.callTool({ name: "sequence", arguments: { ...target, captureId, actions } });
      assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
      assert.ok(reply.content.some(part => part.type === "image"));
      result = JSON.parse((reply.content as { text: string }[])[0]!.text.split("\n")[0]!);
    } finally { await client.close(); await server.close(); await policy.close(); }
  }
  assert.equal(result.completedCount, 0);
  assert.equal(result.stoppedAt, 0);
  assert.equal(result.stopReason, "partial_action");
  assert.equal(result.doNotRepeat, true);
  const steps = result.steps as { receipt: { outcome: string; completedPages: number } }[];
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.receipt.outcome, "partial");
  assert.equal(steps[0]?.receipt.completedPages, 1);
  assert.deepEqual((await f.entries()).filter(entry => ["scroll", "type_text"].includes(entry.cmd)).map(entry => entry.cmd), ["scroll"]);
});

test("等待文字条件通过真实工具返回当前画面，下一动作不重复等待，原有观察不会检查完成条件", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { observationTitles: ["Loading", "Fixture"] });
  const observed = await f.invoke("ComputerObserve", { ...target, waitFor: { text: "Fixture", timeoutMs: 2_000 } });
  assert.deepEqual(observed.wait, { matched: true, attempts: 2 });
  assert.equal(observed.imageReturned, true);
  const result = await f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "click", x: 1, y: 2 });
  assert.equal(result.wait, undefined);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, 3);
});

test("仅截图观察取得新凭据且不保留旧控件，原有完整观察用例未覆盖轻量路径", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  const observed = await f.invoke("ComputerObserve", { ...target, content: "image" });
  assert.equal(observed.imageReturned, true);
  assert.equal(observed.tree, undefined);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").at(-1)!.args.max_depth, 0);
  await assert.rejects(f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "click", elementToken: "e1" }), /element_token_not_in_observation/);
  const result = await f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "click", x: 1, y: 2 });
  assert.equal(result.tree, undefined);
  assert.equal(result.imageReturned, true);
});
async function fixture(t: TestContext, apps: Record<string, unknown>[] = [
  { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
  { name: "Recently Used", bundleId: "test.recent", running: false, lastUsed: "2026-10-07T00:00:00Z" }
], options: { actionEffect?: "confirmed" | "unverified"; autoInputMethod?: "physical" | "unicode"; partialScroll?: boolean; menuKeyboard?: boolean; emptyTree?: boolean; semanticElement?: boolean; observationElement?: Record<string, unknown>; observationPid?: number; observationWindowId?: number; holdActionReply?: boolean; nativeRefusal?: boolean; rejectDelivery?: boolean; nativeError?: string; failPostObservation?: boolean; failObservationAt?: number; screenshotFailure?: "capture" | "missing-file" | "oversized"; observationWarning?: string; observationWarnings?: (string | null)[]; observationTitles?: string[]; observationRefs?: string[]; previewCursor?: { x: number; y: number; remainingMs: number }; launchWindows?: { window_id: number; onscreen?: boolean }[]; launchWindowSequence?: { window_id: number; onscreen?: boolean }[][]; windowBundleSequence?: string[]; projectId?: string } = {}) {
  const firstWindow = previewWindows.length;
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-dispatch-"));
  previewUserData = directory;
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? {
      format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,ipcMain,shell,systemPreferences,screen,nativeImage}=globalThis.__computerDispatchElectron;"
    } : next(url, context);
  } });
  const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
  const { createComputerUseService } = await import("../src/desktop/electron/main/computerUseService.js");
  const browser = new DesktopBrowserService(async () => path.join(directory, "cookies.json"));
  const resources: { service?: Awaited<ReturnType<typeof createComputerUseService>>; driver?: NativeProcessDriver; mcp?: McpToolHost } = {};
  t.after(async () => {
    try { await resources.mcp?.close(); await resources.service?.close(); await browser.dispose(); }
    finally { hooks.deregister(); await rm(directory, { recursive: true, force: true }); }
  });
  const binary = path.join(directory, "native-fixture.cjs");
  const journal = path.join(directory, "requests.jsonl");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const journal = ${JSON.stringify(journal)}, directory = ${JSON.stringify(directory)};
fs.writeFileSync(path.join(directory, 'native.pid'), String(process.pid));
let generation = 0, windowReads = 0, ref, apps = ${JSON.stringify(apps)};
const server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const { id, cmd, args } = request;
      fs.appendFileSync(journal, JSON.stringify({ cmd, args }) + '\\n');
      let data = {};
      if (cmd === 'list_apps') {
        const sequence = ${JSON.stringify(options.launchWindowSequence ?? null)};
        const bundleSequence = ${JSON.stringify(options.windowBundleSequence ?? null)};
        const readIndex = args.pid ? windowReads++ : 0;
        const windows = args.pid && sequence ? sequence[Math.min(readIndex, sequence.length - 1)] : ${JSON.stringify(options.launchWindows ?? [{ window_id: 900, onscreen: true }])};
        const bundleId = args.pid && bundleSequence ? bundleSequence[Math.min(readIndex, bundleSequence.length - 1)] : undefined;
        data = { apps: args.pid && windows ? apps.map(app => ({ ...app, bundleId: bundleId || app.bundleId, windows })) : apps };
      }
      else if (cmd === 'app_identity') data = { bundleId: args.bundle, name: 'Fixture', running: false };
      else if (cmd === 'launch_app') { apps = [{ pid: 42, bundleId: args.bundle, name: 'Fixture', running: true }]; data = { pid: 42, activated: false }; }
      else if (cmd === 'pip_open') data = { state: 'open', window_id: args.window_id };
      else if (cmd === 'get_app_state') {
        ++generation; ref = ${JSON.stringify(options.observationRefs ?? [])}[generation - 1] || 'e' + generation;
        if ((generation === 2 && ${JSON.stringify(options.failPostObservation ?? false)}) || generation === ${JSON.stringify(options.failObservationAt ?? 0)}) { socket.write(JSON.stringify({ id, ok: false, error: { code: 'capture_timeout' } }) + '\\n'); continue; }
        const imagePath = path.join(directory, 'state-' + generation + '.jpg');
        const screenshotFailure = generation === 2 ? ${JSON.stringify(options.screenshotFailure ?? null)} : null;
        if (!screenshotFailure) fs.writeFileSync(imagePath, Buffer.from([255, 216, 255, 217]));
        if (screenshotFailure === 'oversized') fs.writeFileSync(imagePath, Buffer.alloc(1_048_577));
        data = { pid: ${JSON.stringify(options.observationPid ?? 42)}, bundleId: apps.find(app => app.pid === 42)?.bundleId, windowId: ${JSON.stringify(options.observationWindowId ?? 900)}, screenshot: imagePath, screenshotWidth: args.max_width || 100, screenshotHeight: 80, warning: ${JSON.stringify(options.observationWarnings ?? [])}[generation - 1] || ${JSON.stringify(options.observationWarning ?? null)} || undefined,
          elements: args.max_depth === 0 || args.max_elements === 0 || ${JSON.stringify(options.emptyTree ?? false)} ? [] : [${JSON.stringify(options.observationElement ?? null)} ? { ref, ...${JSON.stringify(options.observationElement ?? null)} } : ${JSON.stringify(options.semanticElement ?? false)} ? { ref, role: 'AXButton', description: '开始播放', focused: true, enabled: false } : { ref, role: 'AXScrollArea', title: ${JSON.stringify(options.observationTitles ?? [])}[generation - 1] || 'Fixture' }] };
        if (screenshotFailure === 'capture') { delete data.screenshot; data.screenshotWidth = 0; data.screenshotHeight = 0; data.screenshot_error = 'screen_recording_not_granted'; }
      } else if (cmd === 'shot_display' || cmd === 'capture_screen') {
        if (args.window_id !== undefined && args.window_id !== 900) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'capture_window_not_found' } }) + '\\n'); continue;
        }
        fs.writeFileSync(args.out, Buffer.from([255, 216, 255, 217]));
        data = { path: args.out, width: 100, height: 80, windowId: args.window_id || 900, cursor: ${JSON.stringify(options.previewCursor ?? null)} || undefined };
      } else if (['click', 'scroll', 'type_text', 'press_key', 'perform_secondary_action', 'set_value', 'select_text'].includes(cmd)) {
        if (${JSON.stringify(options.rejectDelivery ?? false)} && args.delivery !== undefined) { socket.write(JSON.stringify({ id, ok: false, error: { message: 'input_delivery_unsupported: 输入始终后台投递，不接受 delivery 参数' } }) + '\\n'); continue; }
        if ((cmd === 'scroll' && !args.ref && (args.x === undefined || args.y === undefined)) || (args.ref && args.ref !== ref)) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'element_ref_not_observed' } }) + '\\n'); continue;
        }
        if (${JSON.stringify(options.nativeRefusal ?? false)}) { socket.write(JSON.stringify({ id, ok: false, error: { code: 'ax_not_granted' } }) + '\\n'); continue; }
        if (${JSON.stringify(options.nativeError ?? null)}) { socket.write(JSON.stringify({ id, ok: false, error: { code: ${JSON.stringify(options.nativeError ?? null)} } }) + '\\n'); continue; }
        fs.writeFileSync(path.join(directory, 'action.json'), JSON.stringify({ cmd, args }));
        if (${JSON.stringify(options.holdActionReply ?? false)}) continue;
        data = ${JSON.stringify(options.actionEffect === "unverified" ? { clicked: "e1", route: "physical", verification_note: "sent, but could not confirm it landed" } : { clicked: "e1", route: "ax" })};
        if (cmd === 'type_text' && ${JSON.stringify(options.autoInputMethod ?? null)}) data = { typed: args.text.length, inputMethod: ${JSON.stringify(options.autoInputMethod ?? null)} };
        if (cmd === 'press_key' && ${JSON.stringify(options.menuKeyboard ?? false)}) data = { pressed: args.key, route: 'ax', via: 'menu_ax_press' };
        if (cmd === 'scroll' && ${JSON.stringify(options.partialScroll ?? false)}) data = { scrolled: args.direction, route: 'ax-page', unit: 'pages', outcome: 'partial', completedPages: 1, warning: 'observe before continuing' };
        else if (cmd === 'scroll' && data.route === 'ax') data = { scrolled: args.direction, route: 'ax-page', unit: 'pages' };
      }
      socket.write(JSON.stringify({ id, ok: true, data }) + '\\n');
    }
  });
});

const socketPath = process.argv[process.argv.indexOf('--socket') + 1];
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
server.listen(socketPath, () => console.log('ready'));
`, { mode: 0o700 });
  const store = createFileConfigStore(directory, { globalDir: directory, credentialStore: { persistent: false, get: async () => undefined, set: async () => undefined, delete: async () => undefined } });
  await updateConfig(store, undefined, () => configSchema.parse({ ...defaultConfig, computer: { enabled: true, strictApproval: false, apps: [] } }));
  const navigation: { channel: string; target: unknown }[] = [];
  const main = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => false, restore: () => undefined, show: () => undefined, focus: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), webContents: { send: (channel: string, target: unknown) => navigation.push({ channel, target }) } });
  const service = await createComputerUseService(browser, () => options.projectId ? main as unknown as import("electron").BrowserWindow : undefined, async () => undefined, store, onExit => {
    const driver = new NativeProcessDriver(onExit, { binaryPath: binary, socketDir: directory });
    resources.driver = driver;
    return driver;
  });
  resources.service = service;
  const endpoint = await browser.startAutomationServer(path.join(directory, "desktop.sock"));
  const mcp = new McpToolHost();
  resources.mcp = mcp;
  await attachDesktopComputerMcp(mcp, { ...endpoint, projectId: options.projectId });
  const tools = mcp.createTools();
  const images: { mimeType: string; data: string }[] = [];
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(entry => entry.name === name)!;
    const execution = await tool.resolveExecution(args);
    assert.ok("execute" in execution);
    return await execution.execute({ toolCallId: "fixture-call", operationId: "fixture-operation", sessionId: "fixture-session", onImage: image => { images.push(image); return true; } }) as Record<string, unknown>;
  };
  const entries = async (): Promise<JournalEntry[]> => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const externalActivity = async () => await requestComputer(endpoint, "external_activity", target);
  return { directory, endpoint, store, service, driver: resources.driver!, mcp, invoke, entries, externalActivity, images, navigation, browserClose: () => browser.dispose(), windows: () => previewWindows.slice(firstWindow) };
}

for (const route of ["standalone", "desktop-mcp"] as const) for (const scenario of ["menu", "unverified"] as const) test(`action receipt reaches the normalized MCP result: ${route}, ${scenario}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { menuKeyboard: scenario === "menu", actionEffect: scenario === "unverified" ? "unverified" : "confirmed" });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); } };
  });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = host.createTools().find(candidate => candidate.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(args);
      assert.ok("execute" in execution);
      return await execution.execute({ sessionId: "menu-shortcut", operationId: name, toolCallId: name, onImage: () => true });
    };
    await call("get_app_state", { pid: 42, window_id: 900 });
    const action = scenario === "menu" ? "press_key" : "type_text";
    const result = await call(action, scenario === "menu" ? { pid: 42, window_id: 900, key: "cmd+s" } : { pid: 42, window_id: 900, text: "test", input_method: "unicode" });
    assert.match(JSON.stringify(result), scenario === "menu" ? /menu_ax_press/ : /verification_note/);
    assert.match(JSON.stringify(result), scenario === "menu" ? /cmd\+s/ : /could not confirm/);
    assert.equal((await f.entries()).filter(entry => entry.cmd === action).length, 1);
  } finally { await host.close(); }
});

for (const [name, bundleId, expected] of [
  ["Clock", "com.apple.clock", [/TimePicker/, /世界时钟/, /询问用户是否取消已有计时器/]],
  ["iPhone Mirroring", "com.apple.ScreenContinuity", [/回到主屏幕\s*\|\s*`cmd\+1`/, /App 切换器\s*\|\s*`cmd\+2`/, /Spotlight\s*\|\s*`cmd\+3`/, /输入始终后台投递/]],
  ["Notion", "notion.id", [/ComputerAction[^\n]*`matchText`/, /外部 MCP[^\n]*`text`[^\n]*查找/, /ComputerAction[^\n]*`text`[^\n]*替换/, /代码块[^\n]*`Return`[^\n]*换行[^\n]*`shift\+Return`[^\n]*退出/, /引用块[^\n]*`Return`[^\n]*退出[^\n]*`shift\+Return`[^\n]*换行/, /空块[^\n]*全选[^\n]*所有块/]],
  ["Spotify", "com.spotify.client", [/搜索框[^\n]*焦点[^\n]*`Return`/, /没有结果[^\n]*重新观察/, /open\.spotify\.com[^\n]*类型/]],
  ["Apple Music", "com.apple.Music", [/filterField[^\n]*当前视图/, /More[^\n]*Play Next[^\n]*Play Last/]]
] as const) test(`${name} 的说明书随观察送达内置工具及外部 MCP`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ pid: 42, name, bundleId, running: true }]);
  const observed = await f.invoke("ComputerObserve", target);
  for (const pattern of expected) assert.match(String(observed.playbook), pattern);
  assert.equal(observed.imageReturned, true);
  await requestComputer(f.endpoint, "release", { session: "fixture-session" });

  for (const desktop of [true, false]) {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => desktop ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const client = new Client({ name: "clock-playbook", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(left), server.connect(right)]);
      const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
      assert.notEqual(result.isError, true);
      for (const pattern of expected) assert.match((result.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n"), pattern);
      assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    } finally { await client.close(); await server.close(); await policy.close(); }
  }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`native description and focused state reach the observation: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { semanticElement: true });
  if (route === "builtin") {
    const result = await f.invoke("ComputerObserve", target);
    assert.match(String(result.tree), /\(e1\) AXButton "开始播放".*\(focused,disabled\)/);
    assert.equal(result.imageReturned, true);
    const waited = await f.invoke("ComputerObserve", { ...target, waitFor: { text: "开始播放", timeoutMs: 1000 } });
    assert.equal((waited.wait as { matched?: boolean }).matched, true);
    return;
  }
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "observation-semantics", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual(result.isError, true);
    const text = (result.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.match(text, /\(e1\) AXButton "开始播放".*\(focused,disabled\)/);
    assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    if (route === "desktop-mcp") {
      const waited = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, waitFor: { text: "开始播放", timeoutMs: 1000 } } });
      const waitText = (waited.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
      assert.equal((JSON.parse(waitText.split("\n")[0]!) as { wait: { matched: boolean } }).wait.matched, true);
    }
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`control value, selection and actions survive observation: ${route}`, { timeout: 12_000 }, async t => {
  const element = { role: "AXSlider", subrole: "AXVolume", title: "音量", value: "0.75", selected: true, actions: ["AXIncrement", "AXDecrement"], children_count: 2, frame: { x: 10, y: 20, w: 40, h: 30 } };
  const f = await fixture(t, undefined, { observationElement: element });
  if (route === "builtin") {
    const result = await f.invoke("ComputerObserve", target);
    assert.match(String(result.tree), /音量.*value="0\.75"/);
    assert.match(String(result.tree), /selected/);
    assert.match(String(result.tree), /AXIncrement/);
    return;
  }
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "control-metadata", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, interactive_only: false } });
    assert.notEqual(result.isError, true);
    const data = JSON.parse((result.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!);
    const { frame, ...attributes } = element;
    assert.deepEqual(data.elements[0], { ...attributes, ref: "e1", bounds: frame });
    assert.match(JSON.stringify(result.content), /AXIncrement/);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`long role descriptions remain visible and matchable through observation: ${route}`, { timeout: 12_000 }, async t => {
  const label = "这是一个必须保持完整才能区分目标控件的角色描述".repeat(3) + "目标尾部";
  const f = await fixture(t, undefined, { observationElement: { role: "AXButton", title: "  ", description: "\n", role_description: label, focused: true } });
  if (route === "builtin") {
    const result = await f.invoke("ComputerObserve", { ...target, waitFor: { text: "目标尾部", timeoutMs: 1000 } });
    assert.match(String(result.tree), /目标尾部/);
    assert.ok(String(result.tree).includes(label));
    assert.doesNotMatch(String(result.tree), /@0,0/);
    assert.equal((result.wait as { matched?: boolean }).matched, true);
    return;
  }
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "long-role-description", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual(result.isError, true);
    const text = (result.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
    assert.ok(text.includes(label));
    assert.doesNotMatch(text, /@0,0/);
    const sky = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture", window_id: 900 } });
    assert.notEqual(sky.isError, true);
    const body = JSON.parse((sky.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!);
    assert.ok((body.text as string).includes(label));
    assert.doesNotMatch(body.text as string, /@0,0/);
    if (route === "desktop-mcp") {
      const waited = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, waitFor: { text: "目标尾部", timeoutMs: 1000 } } });
      const waitText = (waited.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
      assert.equal((JSON.parse(waitText.split("\n")[0]!) as { wait: { matched: boolean } }).wait.matched, true);
    }
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`external MCP returns parseable controls that can be acted on: ${route}`, { timeout: 12_000 }, async t => {
  const element = { role: "AXButton", title: "播放", description: "播放音乐", focused: true, enabled: true, frame: { x: 10, y: 20, w: 40, h: 30 } };
  const f = await fixture(t, undefined, { observationElement: element });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "structured-observation", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observed = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual(observed.isError, true);
    const json = (observed.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
    const body = JSON.parse(json) as { elements: Record<string, unknown>[] };
    assert.deepEqual(body.elements[0], { role: "AXButton", title: "播放", description: "播放音乐", focused: true, enabled: true, ref: "e1", bounds: { x: 10, y: 20, w: 40, h: 30 } });
    assert.deepEqual(observed.structuredContent?.elements, body.elements);
    assert.ok(observed.content.some(part => part.type === "image"));
    assert.doesNotMatch(json, /\/9j\/2Q==|state-\d+\.jpg/);
    const clicked = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: body.elements[0]!.ref } });
    assert.notEqual(clicked.isError, true);
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) for (const failure of ["capture", "missing-file", "oversized"] as const) test(`failed screenshot preserves its cause and invalidates input: ${route}, ${failure}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { screenshotFailure: failure });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "failed-screenshot", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    const failed = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.match(JSON.stringify(failed), failure === "capture" ? /screen_recording_not_granted/ : failure === "oversized" ? /screenshot_too_large/ : /screenshot_read_failed/);
    assert.doesNotMatch(JSON.stringify(failed), /state-2\.jpg/);
    assert.equal(failed.content.some(part => part.type === "image"), false);
    if (route === "standalone") assert.equal(failed.structuredContent?.observationRequired, true);
    if (failure === "oversized") await assert.rejects(stat(path.join(f.directory, "state-2.jpg")), { code: "ENOENT" });
    assert.equal((await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e2" } })).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 0);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    assert.notEqual((await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e3" } })).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("desktop action retains its receipt and screenshot failure without replaying input", { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { screenshotFailure: "capture" });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "post-action-screenshot-failure", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    const action = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e1" } });
    assert.notEqual(action.isError, true);
    const receipt = JSON.parse((action.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!.split("\n")[0]!);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.doNotRepeat, true);
    assert.equal(receipt.observationRequired, true);
    assert.match(receipt.observation.reason, /screen_recording_not_granted/);
    assert.equal((await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e1" } })).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`normalized MCP observation retains actionable controls and application guidance: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ pid: 42, name: "Clock", bundleId: "com.apple.clock", running: true }], { observationElement: { role: "AXButton", title: "开始" } });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); await policy.close(); } };
  });
  try {
    let images = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = host.createTools().find(candidate => candidate.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(args);
      assert.ok("execute" in execution);
      return await execution.execute({ sessionId: "normalized-observation", operationId: name, toolCallId: name, onImage: () => { images++; return true; } }) as Record<string, unknown>;
    };
    const observed = await call("get_app_state", { pid: 42, window_id: 900 });
    const elements = observed.elements as { ref?: string; title?: string }[];
    assert.equal(elements[0]?.ref, "e1");
    assert.equal(elements[0]?.title, "开始");
    assert.match(String(observed.playbook), /TimePicker/);
    assert.equal(images, 1);
    assert.doesNotMatch(JSON.stringify(observed), /\/9j\/2Q==|state-\d+\.jpg/);
    await call("click", { pid: 42, window_id: 900, ref: elements[0]!.ref });
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { await host.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky actions use the approved native transport: ${route}`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-dispatch", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
      ["sky_click", { element_index: 0 }, "click", {}],
      ["sky_press_key", { key: "Super_L+d" }, "press_key", { key: "Super_L+d" }],
      ["sky_type_text", { text: "hello" }, "type_text", { text: "hello" }],
      ["sky_scroll", { element_index: 0, direction: "d", pages: 2 }, "scroll", { direction: "down", pages: 2 }],
      ["sky_set_value", { element_index: 0, value: "new" }, "set_value", { value: "new" }],
      ["sky_drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, "drag", { x1: 1, y1: 2, x2: 3, y2: 4 }],
      ["sky_perform_secondary_action", { element_index: 0, action: "AXPress" }, "perform_secondary_action", { secondary_action: "AXPress" }],
      ["sky_select_text", { element_index: 0, text: "目标", selection_type: "cursor_after" }, "select_text", { match_text: "目标", selection_type: "cursor_after" }]
    ];
    for (const [name, args, command, expected] of cases) {
      const state = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
      assert.notEqual(state.isError, true, `${name}: ${JSON.stringify(state.content)}`);
      const stateText = JSON.parse((state.content as { text: string }[])[0]!.text).text as string;
      const freshIndex = Number(stateText.match(/^\[(\d+)\]/m)![1]);
      const before = (await f.entries()).length;
      const reply = await client.callTool({ name, arguments: { app: "test.fixture", ...args, ...("element_index" in args ? { element_index: freshIndex } : {}) } });
      assert.notEqual(reply.isError, true, `${name}: ${JSON.stringify(reply.content)}`);
      const sent = (await f.entries()).slice(before).find(entry => entry.cmd === command);
      assert.ok(sent, `${name} did not dispatch ${command}`);
      assert.equal(sent.args.pid, 42); assert.equal(sent.args.window_id, 900);
      assert.equal(typeof sent.args.client_id, "string"); assert.equal(typeof sent.args.capture_id, "string");
      for (const [key, value] of Object.entries(expected)) assert.equal(sent.args[key], value, `${name} ${key}`);
      if ("element_index" in args) assert.match(String(sent.args.ref), /^e\d+$/);
    }
    if (route === "desktop-mcp") {
      const lastState = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
      assert.notEqual(lastState.isError, true);
      const lastText = JSON.parse((lastState.content as { text: string }[])[0]!.text).text as string;
      const lastIndex = Number(lastText.match(/^\[(\d+)\]/m)![1]);
      f.service.controller.control("takeover");
      const before = (await f.entries()).filter(entry => entry.cmd === "click").length;
      const refused = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: lastIndex } });
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused.content), /taken-over/);
      assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, before);
    }
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`external MCP input_method and observation depth reach the native driver: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "external-input-method", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observe = async (depth?: number) => await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, depth } });
    assert.notEqual((await observe()).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").at(-1)!.args.max_depth, 6);
    const before = (await f.entries()).filter(entry => entry.cmd === "type_text").length;
    const duplicate = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 900, text: "hello", input_method: "unicode", inputMethod: "physical" } });
    assert.equal(duplicate.isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "type_text").length, before);
    const typed = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 900, text: "hello", input_method: "unicode" } });
    assert.notEqual(typed.isError, true, JSON.stringify(typed.content));
    assert.equal((await f.entries()).filter(entry => entry.cmd === "type_text").at(-1)!.args.input_method, "unicode");
    assert.notEqual((await observe(9)).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").at(-1)!.args.max_depth, 9);
    assert.notEqual((await observe(0)).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").at(-1)!.args.max_depth, 0);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`partial accessibility observations retain controls, warning and screenshot: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationElement: { role: "AXButton", title: "已读取的控件" }, observationWarning: "accessibility_tree_incomplete: 1 个分支读取失败" });
  if (route === "builtin") {
    const result = await f.invoke("ComputerObserve", target);
    assert.match(JSON.stringify(result), /accessibility_tree_incomplete/);
    assert.match(String(result.tree), /已读取的控件/);
    assert.equal(result.imageReturned, true);
    return;
  }
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "partial-accessibility", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.match(body.text, /accessibility_tree_incomplete/);
    assert.match(body.text, /\[0\].*已读取的控件/);
    assert.match(body.screenshot.url, /^data:image\/jpeg;base64,/);
    assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    const clicked = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(clicked.isError, true, JSON.stringify(clicked.content));
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky observation retains native warnings: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationWarning: "empty_after_wakeup: accessibility tree unavailable" });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-warning", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(result.isError, true);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.match(body.text, /empty_after_wakeup: accessibility tree unavailable/);
    assert.match(body.text, /\[0\]/);
    assert.match(body.screenshot.url, /^data:image\/jpeg;base64,/);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky preserves labels containing dimensions through native dispatch: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationElement: {
    role: "AXButton", title: "显示器 1920×1080", frame: { x: 10, y: 20, w: 40, h: 30 }
  } });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-frame-label", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.match(body.text, /\[0\] Button "显示器 1920×1080" @10,20 40x30/);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(click.isError, true, JSON.stringify(click.content));
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`expired sky history returns a full tree and usable index: ${route}`, { timeout: 12_000 }, async t => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e1"] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-history-expired", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observe = async () => await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual((await observe()).isError, true);
    now += 60_000;
    const result = await observe();
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.doesNotMatch(body.text, /\(diff:/);
    assert.match(body.text, /\[0\] ScrollArea "Fixture"/);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(click.isError, true, JSON.stringify(click.content));
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { await client.close(); await server.close(); await policy.close(); t.mock.restoreAll(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`an older sky app lookup cannot replace the latest native observation: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  let release!: () => void, entered!: () => void, listCount = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const run = policy.run.bind(policy);
  policy.run = async (tool, args, operation, signal) => {
    if (tool === "list_apps" && ++listCount === 1) { entered(); await gate; }
    return await run(tool, args, operation, signal);
  };
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-app-lookup-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let first: ReturnType<typeof client.callTool> | undefined;
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    first = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    await waiting;
    const second = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(second.isError, true, JSON.stringify(second.content));
    release();
    assert.equal((await first).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, 1);
    const click = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(click.isError, true, JSON.stringify(click.content));
    assert.equal((await f.entries()).find(entry => entry.cmd === "click")?.args.ref, "e1");
  } finally { release(); await first?.catch(() => undefined); await client.close(); await server.close(); await policy.close(); }
});

for (const [route, held] of [["standalone", "action"], ["desktop-mcp", "action"], ["standalone", "refresh"]] as const) test(`new sky lookup supersedes a dispatched action ${held}: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  let releaseOld!: () => void, oldEntered!: () => void, releaseList!: () => void, listEntered!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const oldWaiting = new Promise<void>(resolve => { oldEntered = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const listWaiting = new Promise<void>(resolve => { listEntered = resolve; });
  let lists = 0, observations = 0, actions = 0;
  const run = policy.run.bind(policy);
  policy.run = async (tool, args, operation, signal) => {
    if (tool === "list_apps" && ++lists === 2) { listEntered(); await listGate; }
    const hold = tool === "click" ? ++actions === 1 && held === "action" : tool === "get_app_state" ? ++observations === 2 && held === "refresh" : false;
    const result = await run(tool, args, operation, signal);
    if (hold) { oldEntered(); await oldGate; }
    return result;
  };
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-action-lookup-race", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  let action: ReturnType<typeof client.callTool> | undefined, newer: ReturnType<typeof client.callTool> | undefined;
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const initial = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(initial.isError, true, JSON.stringify(initial.content));
    action = client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    await oldWaiting;
    newer = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    await listWaiting;
    releaseOld();
    const receipt = await action;
    assert.notEqual(receipt.isError, true, JSON.stringify(receipt.content));
    assert.equal(receipt.structuredContent?.observationRequired, true);
    assert.equal(receipt.structuredContent?.doNotRepeat, true);
    assert.equal(receipt.content.some(part => part.type === "image"), false, "a superseded action cannot publish its stale screenshot");
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
    const readsBeforeNewer = (await f.entries()).filter(entry => entry.cmd === "get_app_state").length;
    assert.equal(readsBeforeNewer, route === "desktop-mcp" || held === "refresh" ? 2 : 1);
    releaseList();
    const state = await newer;
    assert.notEqual(state.isError, true, JSON.stringify(state.content));
    const stateText = JSON.parse((state.content as { text: string }[])[0]!.text).text as string;
    const index = Number(stateText.match(/^\[(\d+)\]/m)![1]);
    const next = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: index } });
    assert.notEqual(next.isError, true, JSON.stringify(next.content));
    assert.deepEqual((await f.entries()).filter(entry => entry.cmd === "click").map(entry => entry.args.ref), ["e1", `e${readsBeforeNewer + 1}`]);
  } finally {
    releaseOld(); releaseList();
    await Promise.allSettled([...(action ? [action] : []), ...(newer ? [newer] : [])]);
    await client.close(); await server.close(); await policy.close();
  }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`accessibility timeout remains visible with a usable screenshot: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true, launchWindows: [{ window_id: 900, onscreen: true }], observationWarning: "accessibility_timeout: 无障碍树读取超时" });
  if (route === "builtin") {
    const result = await f.invoke("ComputerObserve", target);
    assert.match(JSON.stringify(result), /accessibility_timeout/);
    assert.equal(result.imageReturned, true);
    return;
  }
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-timeout", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const body = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.match(body.text, /accessibility_timeout/);
    assert.match(body.screenshot.url, /^data:image\/jpeg;base64,/);
    assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    const clicked = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", x: 20, y: 30 } });
    assert.notEqual(clicked.isError, true, JSON.stringify(clicked.content));
    const input = (await f.entries()).find(entry => entry.cmd === "click");
    assert.equal(input?.args.x, 20); assert.equal(input?.args.y, 30);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky reuses an index only while the same element survives the post-action capture: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e1", "e2"] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-continuity", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observed = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(observed.isError, true);
    const click = async () => await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    const first = await click();
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    assert.match(JSON.stringify(first.content), /Fresh observation captured/);
    assert.match(JSON.stringify(first.content), /observationRequired[^a-zA-Z]+false/);
    const second = await click();
    assert.notEqual(second.isError, true, JSON.stringify(second.content));
    assert.match(JSON.stringify(second.content), /removed indices: 0/);
    assert.deepEqual(second.structuredContent?.removedIndices, [0]);
    const third = await click();
    assert.equal(third.isError, true);
    assert.match(JSON.stringify(third.content), /element_index_not_observed/);
    const inputs = (await f.entries()).filter(entry => entry.cmd === "click");
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map(entry => entry.args.ref), ["e1", "e1"]);
    assert.notEqual(inputs[0]!.args.capture_id, inputs[1]!.args.capture_id);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, 3);
    if (route === "standalone") assert.equal((await f.entries()).filter(entry => entry.cmd === "shot_display").length, 0);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky diff does not claim unseen controls were removed from an incomplete observation: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e2"], observationWarnings: [null, "accessibility_timeout: 无障碍树读取超时"] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-incomplete-diff", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observe = async () => await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual((await observe()).isError, true);
    const next = await observe();
    const body = JSON.parse((next.content as { text: string }[])[0]!.text);
    assert.match(body.text, /accessibility_timeout/);
    assert.match(body.text, /unavailable indices: 0/);
    assert.doesNotMatch(body.text, /removed indices/);
    const rejected = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.equal(rejected.isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 0);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky reports an incomplete post-action observation without claiming removal: ${route}`, { timeout: 12_000 }, async t => {
  const warning = "accessibility_tree_incomplete: 1 个分支读取失败";
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e2"], observationWarnings: [null, warning] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-partial-refresh", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const result = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.match(JSON.stringify(result.content), /accessibility_tree_incomplete/);
    assert.doesNotMatch(JSON.stringify(result.content), /removed indices/);
    assert.equal(result.structuredContent?.observationWarning, warning);
    assert.deepEqual(result.structuredContent?.unavailableIndices, [0]);
    assert.equal(result.structuredContent?.doNotRepeat, true);
    assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    const rejected = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.equal(rejected.isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky never retries an input when its post-action observation fails: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], failPostObservation: true });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-refresh-failure", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const first = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    assert.match(JSON.stringify(first.content), /observationRequired[^a-zA-Z]+true/);
    const next = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.equal(next.isError, true);
    assert.match(JSON.stringify(next.content), /computer_observation_required/);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("sky reports a failed standalone refresh after a delivered action", { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], failObservationAt: 2 });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-auto-refresh-failure", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const result = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.structuredContent?.observationRequired, true);
    assert.equal(result.structuredContent?.observationRefreshFailed, true);
    assert.equal(result.structuredContent?.postShotDeferred, undefined);
    assert.ok(result.content.some(part => part.type === "image"));
    const receipt = (result.content as { type: string; text?: string }[]).find(part => part.type === "text")!.text!;
    assert.equal(JSON.parse(receipt.split("\n")[0]!).observationRequired, true);
    assert.match(JSON.stringify(result.content), /do not repeat this action automatically/);
    assert.equal((await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } })).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
    const fallback = (await f.entries()).filter(entry => entry.cmd === "shot_display");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]!.args.pid, 42);
    assert.equal(fallback[0]!.args.window_id, 900);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("sky fallback screenshot respects control disabled after the action", { timeout: 12_000 }, async t => {
  const f = await fixture(t);
  const observe = f.driver.observeRaw.bind(f.driver);
  let reads = 0;
  f.driver.observeRaw = async (args, signal) => {
    if (++reads === 2) {
      await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, enabled: false } }));
      throw new Error("capture_timeout");
    }
    return await observe(args, signal);
  };
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-fallback-authorization", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const result = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.observationRequired, true);
    assert.equal(result.structuredContent?.doNotRepeat, true);
    assert.equal(result.content.some(part => part.type === "image"), false);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "shot_display").length, 0);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("sky keeps the action receipt when both observation and fallback screenshot fail", { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { failObservationAt: 2 });
  f.driver.capturePreview = async () => { throw new Error("capture_window_not_found"); };
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-fallback-failure", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const result = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.effect, "confirmed");
    assert.equal(result.structuredContent?.observationRequired, true);
    assert.equal(result.structuredContent?.doNotRepeat, true);
    assert.equal(result.content.some(part => part.type === "image"), false);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("sky desktop actions reuse the controller observation without another capture", { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e1"], failObservationAt: 3 });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-desktop-refresh", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } })).isError, true);
    const result = await client.callTool({ name: "sky_click", arguments: { app: "test.fixture", element_index: 0 } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.structuredContent?.observationRequired, false);
    assert.equal(result.structuredContent?.doNotRepeat, true);
    assert.equal(result.structuredContent?.status, "completed");
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, 2);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("ordinary standalone MCP actions still return their post-action screenshot", { timeout: 12_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "ordinary-action-screenshot", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    const result = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e1" } });
    assert.notEqual(result.isError, true);
    assert.ok(result.content.some(part => part.type === "image"));
    assert.equal((await f.entries()).filter(entry => entry.cmd === "shot_display").length, 1);
    assert.equal(result.structuredContent?.postShotDeferred, undefined);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky observation cannot bypass application approval: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }] });
  await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval: true } }));
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-approval", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /approval_required/);
    assert.equal((await f.entries()).some(entry => ["get_app_state", "click", "shot_display"].includes(entry.cmd)), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`sky observation requires an exact window when an application has several: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }, { window_id: 901, onscreen: true }] });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "sky-windows", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const ambiguous = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.equal(ambiguous.isError, true);
    assert.match(JSON.stringify(ambiguous.content), /computer_window_selection_required/);
    assert.equal((await f.entries()).some(entry => entry.cmd === "get_app_state"), false);
    const selected = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture", window_id: 900 } });
    assert.notEqual(selected.isError, true);
    assert.equal((await f.entries()).find(entry => entry.cmd === "get_app_state")?.args.window_id, 900);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`computer MCP screenshots reach the model without entering session text: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }] });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); } };
  });
  t.after(() => host.close());
  await ensureAgentDirs(f.directory);
  const recorder = new SessionRecorder(f.directory, "mcp-image-session");
  t.after(() => recorder.close());
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access"; config.permission.denyPaths = [];
  const registry = new ToolRegistry();
  for (const tool of host.createTools()) registry.registerMcpTool(tool);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: f.directory, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined, () => ({}));
  const tools = coordinator.createAgentTools();
  const observe = tools.find(tool => tool.name === "mcp_computer-use_get_app_state")!;
  const action = tools.find(tool => tool.name === "mcp_computer-use_press_key")!;
  const observed = await observe.execute("mcp-observation", { pid: 42, window_id: 900 });
  assert.equal(observed.isError, false);
  assert.equal(observed.content.find(part => part.type === "image")?.data, "/9j/2Q==");
  assert.match(JSON.stringify(observed.content), /AXScrollArea/);
  assert.match(JSON.stringify(observed.content), /e1/);
  const pressed = await action.execute("mcp-press", { pid: 42, window_id: 900, key: "Return" });
  assert.equal(pressed.isError, false);
  assert.equal(pressed.content.find(part => part.type === "image")?.data, "/9j/2Q==");
  const directObserve = await host.createTools().find(tool => tool.mcpIdentity?.toolName === "get_app_state")!.resolveExecution({ pid: 42, window_id: 900 });
  assert.ok("execute" in directObserve);
  const noImage = await directObserve.execute({ sessionId: "mcp-image-session", operationId: "missing-image", toolCallId: "missing-image", mcpResultMode: "envelope", onImage: () => false });
  assert.match(JSON.stringify(noImage), /Observation image unavailable/);
  assert.doesNotMatch(JSON.stringify(noImage), /\/9j\/2Q==/);
  const directAction = await host.createTools().find(tool => tool.mcpIdentity?.toolName === "press_key")!.resolveExecution({ pid: 42, window_id: 900, key: "Return" });
  assert.ok("execute" in directAction);
  const noActionImage = await directAction.execute({ sessionId: "mcp-image-session", operationId: "missing-action-image", toolCallId: "missing-action-image", mcpResultMode: "envelope", onImage: () => false }) as { content: { type: string; text?: string }[]; structuredContent?: { observationImageUnavailable?: boolean; observationRequired?: boolean; doNotRepeat?: boolean } };
  const status = noActionImage.structuredContent ?? JSON.parse(noActionImage.content.find(part => part.type === "text")!.text!.split("\n")[0]!);
  assert.equal(status.observationImageUnavailable, true);
  assert.equal(status.observationRequired, true);
  assert.equal(status.doNotRepeat, true);
  assert.doesNotMatch(JSON.stringify(noActionImage), /\/9j\/2Q==/);
  const skyObserve = tools.find(tool => tool.name === "mcp_computer-use_sky_get_app_state")!;
  const skyClick = tools.find(tool => tool.name === "mcp_computer-use_sky_click")!;
  const skyState = await skyObserve.execute("sky-observation", { app: "test.fixture" });
  assert.equal(skyState.isError, false, JSON.stringify(skyState.content));
  assert.equal(skyState.content.find(part => part.type === "image")?.data, "/9j/2Q==");
  assert.doesNotMatch(JSON.stringify(skyState.content.filter(part => part.type === "text")), /\/9j\/2Q==/, "data URLs must not enter model text");
  const skyPressed = await skyClick.execute("sky-click", { app: "test.fixture", element_index: 0 });
  assert.equal(skyPressed.isError, false, JSON.stringify(skyPressed.content));
  assert.equal(skyPressed.content.find(part => part.type === "image")?.data, "/9j/2Q==");
  await recorder.flush();
  const saved = await readFile(recorder.filePath, "utf8");
  assert.doesNotMatch(saved, /\/9j\/2Q==/, "image bytes must not enter the durable session");
  await host.close();
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`normalized sky results retain removed indices and action status: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e2"] });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); await policy.close(); } };
  });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = host.createTools().find(candidate => candidate.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(args);
      assert.ok("execute" in execution);
      return await execution.execute({ sessionId: "normalized-sky", operationId: name, toolCallId: name, onImage: () => true }) as Record<string, unknown>;
    };
    await call("sky_get_app_state", { app: "test.fixture" });
    const result = await call("sky_click", { app: "test.fixture", element_index: 0 });
    assert.equal(result.observationRequired, false);
    assert.equal(result.doNotRepeat, true);
    assert.deepEqual(result.removedIndices, [0]);
    if (route === "desktop-mcp") assert.equal(result.status, "completed");
    else assert.equal(result.effect, "confirmed");
    assert.doesNotMatch(JSON.stringify(result), /\/9j\/2Q==/);
  } finally { await host.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`normalized sky results retain incomplete refresh warnings: ${route}`, { timeout: 12_000 }, async t => {
  const warning = "accessibility_tree_incomplete: 1 个分支读取失败";
  const f = await fixture(t, undefined, { launchWindows: [{ window_id: 900, onscreen: true }], observationRefs: ["e1", "e2"], observationWarnings: [null, warning] });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); await policy.close(); } };
  });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = host.createTools().find(candidate => candidate.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(args);
      assert.ok("execute" in execution);
      return await execution.execute({ sessionId: "normalized-sky-partial", operationId: name, toolCallId: name, onImage: () => true }) as Record<string, unknown>;
    };
    await call("sky_get_app_state", { app: "test.fixture" });
    const result = await call("sky_click", { app: "test.fixture", element_index: 0 });
    assert.equal(result.observationWarning, warning);
    assert.deepEqual(result.unavailableIndices, [0]);
    assert.equal(result.doNotRepeat, true);
    assert.equal(result.observationRequired, false);
    assert.equal(result.removedIndices, undefined);
    assert.doesNotMatch(JSON.stringify(result), /\/9j\/2Q==/);
  } finally { await host.close(); }
});

test("normalized sky results retain standalone refresh failure and do-not-repeat state", { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { failObservationAt: 2 });
  const host = new McpToolHost();
  await host.attachLocalServer("computer-use", "native", undefined, async () => {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return { transport: client, close: async () => { await server.close(); await policy.close(); } };
  });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = host.createTools().find(candidate => candidate.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(args);
      assert.ok("execute" in execution);
      return await execution.execute({ sessionId: "normalized-sky-failure", operationId: name, toolCallId: name, onImage: () => true }) as Record<string, unknown>;
    };
    await call("sky_get_app_state", { app: "test.fixture" });
    const result = await call("sky_click", { app: "test.fixture", element_index: 0 });
    assert.equal(result.effect, "confirmed");
    assert.equal(result.observationRequired, true);
    assert.equal(result.observationRefreshFailed, true);
    assert.equal(result.doNotRepeat, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await host.close(); }
});

test("Desktop supervision floats across workspaces and fullscreen without activating or repeatedly presenting", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  f.service.controller.setPreview(true);
  await f.invoke("ComputerObserve", target);
  const windows = f.windows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.options.alwaysOnTop, true);
  assert.deepEqual(windows[0]!.topChanges, [[true, "floating"]]);
  assert.deepEqual(windows[0]!.workspaceChanges, process.platform === "darwin" ? [[true, { visibleOnFullScreen: true, skipTransformProcessType: true }]] : []);
  assert.equal(windows[0]!.options.show, false);
  assert.equal(windows[0]!.options.focusable, true);
  assert.equal(windows[0]!.options.frame, false);
  assert.equal(windows[0]!.options.backgroundColor, "#1c1c1e");
  assert.equal(windows[0]!.options.skipTaskbar, true);
  assert.equal(windows[0]!.options.width, 380);
  assert.equal(windows[0]!.options.height, 250);
  assert.equal(windows[0]!.options.minWidth, 220);
  assert.equal(windows[0]!.options.minHeight, 150);
  windows[0]!.emit("ready-to-show");
  await f.invoke("ComputerObserve", target);
  assert.equal(windows[0]!.presentations, 1);
  assert.equal(windows[0]!.topChanges.length, 1);
});

test("MCP session metadata preserves Desktop ownership and closing releases the observed window", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  assert.equal(f.service.controller.status().owner, "fixture-session");
  const list = f.mcp.createTools().find(tool => tool.name === "ComputerList")!;
  const prepared = await list.resolveExecution({});
  assert.ok("execute" in prepared);
  await assert.rejects(prepared.execute({ toolCallId: "other", operationId: "other", sessionId: "another-session" }), /computer_owner_conflict/);
  await assert.rejects(f.mcp.callServerTool("computer-use", "ComputerList", {}, undefined, true), /invalid_type|Required/);
  await f.mcp.close();
  assert.equal(f.service.controller.status().owner, undefined, "an MCP disconnect must not leave its session owning the Desktop controller");
  await assert.rejects(requestComputer(f.endpoint, "action", { ...target, session: "fixture-session", action: "click", captureId: "closed-capture", x: 1, y: 2 }, undefined, true), /capture_target_mismatch/);
});

test("returning from computer preview carries the owning project and session through Desktop MCP", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { projectId: "project-a" });
  const observed = await f.invoke("ComputerObserve", target);
  await f.invoke("ComputerAction", { ...target, captureId: observed.capture_id, action: "click", x: 1, y: 2 });
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "fixture-session", projectId: "project-a", revealBrowser: undefined });
});

test("an unexpected native process exit invalidates Desktop ownership and observation before further input", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  f.service.controller.setPreview(true);
  const observed = await f.invoke("ComputerObserve", target);
  const pid = Number(await readFile(path.join(f.directory, "native.pid"), "utf8"));
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (f.service.controller.status().state !== "disabled" && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.service.controller.status().state, "disabled");
  assert.equal(f.service.controller.status().diagnostic, "driver_exited");
  assert.equal(f.service.controller.status().owner, undefined);
  assert.equal(f.service.controller.status().lastOutcome, "unknown");
  assert.ok(f.windows()[0]?.paints.findLast(script => script.includes("status.textContent="))?.includes("已停止 · 输入结果未知 · driver_exited"));
  await assert.rejects(f.service.controller.act("fixture-session", { ...target, action: "click", captureId: String(observed.capture_id), x: 1, y: 2 }), /disabled/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 0);
  await f.service.controller.enable();
  const fresh = await f.service.controller.observe("fixture-session", target);
  assert.notEqual(fresh.data.capture_id, observed.capture_id);
});

test("a helper exit during input reports an unknown outcome and never replays it", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { holdActionReply: true });
  const observed = await f.invoke("ComputerObserve", target);
  const action = f.service.controller.act("fixture-session", { ...target, action: "click", captureId: String(observed.capture_id), x: 1, y: 2 });
  const rejection = assert.rejects(action, error => error instanceof ToolOutcomeUnknownError);
  const deadline = Date.now() + 2_000;
  while (!(await f.entries()).some(entry => entry.cmd === "click")) {
    assert.ok(Date.now() < deadline, "native input did not arrive within the bounded IPC deadline");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const pid = Number(await readFile(path.join(f.directory, "native.pid"), "utf8"));
  process.kill(pid, "SIGKILL");
  await rejection;
  assert.equal(f.service.controller.status().state, "disabled");
  assert.equal(f.service.controller.status().lastOutcome, "unknown");
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
});

test("cancelling an MCP action after native dispatch keeps its effect unknown and never replays it", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { holdActionReply: true });
  const observed = await f.invoke("ComputerObserve", target);
  const action = f.mcp.createTools().find(tool => tool.name === "ComputerAction")!;
  const execution = await action.resolveExecution({ ...target, action: "click", captureId: observed.capture_id, x: 1, y: 2 });
  assert.ok("execute" in execution);
  const cancelled = new AbortController();
  const result = execution.execute({ toolCallId: "cancelled-input", operationId: "cancelled-input", sessionId: "fixture-session", signal: cancelled.signal });
  const rejection = assert.rejects(result, error => error instanceof ToolOutcomeUnknownError && error.reason === "cancelled");
  const deadline = Date.now() + 2_000;
  while (!(await f.entries()).some(entry => entry.cmd === "click")) {
    assert.ok(Date.now() < deadline, "native dispatch did not arrive within the bounded IPC deadline");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  cancelled.abort();
  await rejection;
  await f.mcp.close();
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  assert.equal(f.service.controller.status().owner, undefined);
});

test("failed MCP ownership cleanup remains visible and cannot silently restore Computer tools", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  await f.browserClose();
  await assert.rejects(f.mcp.detachLocalServer("computer-use"), /ownership release could not be confirmed/);
  const status = f.mcp.listServers().find(server => server.name === "computer-use");
  assert.ok(status, "existing successful disconnect coverage misses cleanup failure diagnostics");
  assert.equal(status.connected, false);
  assert.equal(status.enabled, false);
  assert.match(status.lastError ?? "", /ownership release could not be confirmed/);
  assert.deepEqual(f.mcp.createTools(), []);
});

test("unverified input returns its fresh image without claiming success or replaying the action", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "unverified");
  assert.equal(result.error, undefined);
  assert.equal(result.verificationRequired, true);
  assert.equal(result.doNotRepeat, true);
  assert.equal(result.imageReturned, true, "existing successful-action coverage misses images dropped only for unverified delivery");
  assert.equal(result.observationImageUnavailable, undefined);
  assert.equal(f.images.length, 2);
  assert.deepEqual(f.images[1], { type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" });
  assert.notEqual(result.capture_id, observed.capture_id);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id }), /capture_target_mismatch/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
});

for (const desktop of [true, false]) test(`外部输入已投递待核对时保留原生警告且不报调用失败：${desktop ? "桌面转接" : "独立服务"}`, { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified" });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => desktop ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "result-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const observe = () => client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    if (!desktop) {
      const waiting = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, waitFor: { text: "Fixture" } } });
      assert.equal(waiting.isError, true);
      const sequence = await client.callTool({ name: "sequence", arguments: { ...target, captureId: "unavailable", actions: [{ action: "press_key", key: "Return" }] } });
      assert.equal(sequence.isError, true);
      assert.match(JSON.stringify(sequence.content), /computer_desktop_required/);
      await assert.rejects(stat(path.join(f.directory, "requests.jsonl")), { code: "ENOENT" });
    }
    await observe();
    const result = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 900, text: "test", inputMethod: "unicode" } });
    assert.equal(result.isError ?? false, false);
    const content = result.content as { type: string; text?: string }[];
    assert.equal(content.some(part => part.type === "image"), true);
    assert.match(content.find(part => part.type === "text")!.text!, /verification_note/);
    assert.match(content.find(part => part.type === "text")!.text!, /"verificationRequired"\s*:\s*true/);
    if (!desktop) await observe();
    const next = await client.callTool({ name: "press_key", arguments: { pid: 42, window_id: 900, key: "Return" } });
    assert.equal(next.isError ?? false, false);
    assert.deepEqual((await f.entries()).filter(entry => ["type_text", "press_key"].includes(entry.cmd)).map(entry => entry.cmd), ["type_text", "press_key"]);
  } finally { await client.close(); await server.close(); }
});

for (const failPostObservation of [false, true]) test(`已投递待核对的输入允许下一步，覆盖原有用例遗漏的任务续行：${failPostObservation ? "回图失败后重新观察" : "复用返回画面"}`, { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified", failPostObservation });
  await ensureAgentDirs(f.directory);
  const recorder = new SessionRecorder(f.directory, "fixture-session");
  t.after(() => recorder.close());
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  const registry = new ToolRegistry();
  for (const tool of f.mcp.createTools()) registry.registerMcpTool(tool);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: f.directory, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), () => undefined, () => ({}));
  const action = coordinator.createAgentTools().find(tool => tool.name === "ComputerAction")!;
  const observed = await f.invoke("ComputerObserve", target);
  const result = await action.execute("model-action", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.isError, false);
  assert.equal(result.content.filter(part => part.type === "image").length, failPostObservation ? 0 : 1, JSON.stringify(result.details));
  const details = result.details as Record<string, unknown>;
  assert.equal(details.status, "unverified", "工具调用完成不能被解释为业务目标已验证");
  assert.equal(details.verificationRequired, true);
  assert.equal(details.observationRequired, failPostObservation, "只有缺失观察时才要求重新采集");
  assert.doesNotThrow(() => coordinator.assertCanContinue());
  let nextCapture = details.capture_id;
  if (failPostObservation) {
    const blocked = await action.execute("model-before-recovery", { ...target, action: "type_text", text: "blocked", captureId: observed.capture_id });
    assert.equal(blocked.isError, true);
    assert.equal((await f.entries()).some(entry => entry.cmd === "type_text"), false);
    const observe = coordinator.createAgentTools().find(tool => tool.name === "ComputerObserve")!;
    const recovered = await observe.execute("model-recovery", target);
    assert.equal(recovered.isError, false);
    nextCapture = (recovered.details as Record<string, unknown>).capture_id;
  }
  const next = await action.execute("model-next", { ...target, action: "type_text", text: "next", captureId: nextCapture });
  assert.equal(next.isError, false);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, failPostObservation ? 4 : 3, "仅回图失败时额外观察，不重复派发动作");
  assert.deepEqual((await f.entries()).filter(entry => ["click", "type_text"].includes(entry.cmd)).map(entry => entry.cmd), ["click", "type_text"]);
  const stale = await action.execute("model-stale", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(stale.isError, true);
  assert.equal(stale.content.filter(part => part.type === "image").length, 0);
  await recorder.close();
  const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "tool_result" && JSON.stringify(event).includes("unverified")));
  const actionResult = events.find(event => event.type === "tool_result" && event.toolCallId === "model-action");
  assert.equal(actionResult?.executionStatus, "succeeded", "调用已返回的事实与业务效果待核对分别保存");
  assert.equal(JSON.stringify(events).includes("/9j/2Q=="), false, "retaining model evidence must not persist screenshot bytes in the session ledger");
});

test("custom windows without AX elements accept focused keyboard input but still require fresh exact-window captures", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true, actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal(observed.tree, undefined);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半", inputMethod: "ax" }), /requires.*elementToken/);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id }), /requires.*text/);
  await assert.rejects(f.invoke("ComputerAction", { ...target, windowId: "901", action: "type_text", captureId: observed.capture_id, text: "一半一半" }), /capture_target_mismatch/);
  const typed = await f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半", inputMethod: "unicode" });
  assert.equal(typed.status, "unverified");
  assert.equal(typed.imageReturned, true);
  assert.equal(typed.doNotRepeat, true);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半" }), /capture_target_mismatch/);
  const pressed = await f.invoke("ComputerAction", { ...target, action: "press_key", captureId: typed.capture_id, key: "Return" });
  assert.equal(pressed.imageReturned, true);
  const requests = await f.entries();
  assert.deepEqual(requests.filter(entry => entry.cmd === "type_text"), [{ cmd: "type_text", args: { pid: 42, window_id: 900, client_id: requests.find(entry => entry.cmd === "get_app_state")!.args.client_id, capture_id: observed.capture_id, text: "一半一半", input_method: "unicode" } }]);
  assert.deepEqual(requests.filter(entry => entry.cmd === "press_key"), [{ cmd: "press_key", args: { pid: 42, window_id: 900, client_id: requests.find(entry => entry.cmd === "get_app_state")!.args.client_id, capture_id: typed.capture_id, key: "Return" } }]);
});

test("model inputs reject the removed delivery option and only dispatch background requests", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true, actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal("foregroundAllowed" in observed, false);
  for (const action of [
    { action: "click", x: 1, y: 2 },
    { action: "type_text", text: "no input" },
    { action: "press_key", key: "Return" }
  ]) await assert.rejects(f.invoke("ComputerAction", { ...target, ...action, captureId: observed.capture_id, delivery: "foreground" }), /[Uu]nrecognized/);
  await assert.rejects(f.invoke("ComputerSequence", { ...target, captureId: observed.capture_id, delivery: "foreground", actions: [{ action: "press_key", key: "Return" }] }), /[Uu]nrecognized/);
  assert.equal((await f.entries()).some(entry => ["click", "type_text", "press_key"].includes(entry.cmd)), false);
  const clicked = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  const typed = await f.invoke("ComputerAction", { ...target, action: "type_text", text: "一半一半", inputMethod: "unicode", captureId: clicked.capture_id });
  const pressed = await f.invoke("ComputerAction", { ...target, action: "press_key", key: "Return", captureId: typed.capture_id });
  assert.equal(pressed.status, "unverified");
  assert.equal(pressed.imageReturned, true);
  const inputs = (await f.entries()).filter(entry => ["click", "type_text", "press_key"].includes(entry.cmd));
  assert.deepEqual(inputs.map(entry => [entry.cmd, entry.args.pid, entry.args.window_id, entry.args.delivery]), [
    ["click", 42, 900, undefined], ["type_text", 42, 900, undefined], ["press_key", 42, 900, undefined]
  ]);
});
for (const route of ["standalone", "desktop-mcp"] as const) test(`running app window discovery waits for the first unique window: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindowSequence: [[], [{ window_id: 900 }]] });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "running-window-readiness", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const entries = await f.entries();
    assert.ok(entries.filter(entry => entry.cmd === "list_apps" && entry.args.pid === 42).length >= 2);
    assert.equal(entries.some(entry => entry.cmd === "launch_app"), false);
    assert.equal(entries.find(entry => entry.cmd === "get_app_state")?.args.window_id, 900);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`window discovery rejects pid reuse by another app: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { launchWindowSequence: [[], [{ window_id: 900 }]], windowBundleSequence: ["test.fixture", "test.other"] });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "window-pid-reuse", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /computer_app_identity_unavailable/);
    assert.equal((await f.entries()).some(entry => entry.cmd === "get_app_state"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`bundle observation refuses ambiguous running processes: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ pid: 42, name: "Fixture A", bundleId: "test.fixture", running: true }, { pid: 43, name: "Fixture B", bundleId: "test.fixture", running: true }]);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "ambiguous-process", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const ambiguous = await client.callTool({ name: "get_app_state", arguments: { bundle: "test.fixture", window_id: 900 } });
    assert.equal(ambiguous.isError, true);
    assert.match(JSON.stringify(ambiguous.content), /computer_app_identity_unavailable/);
    assert.equal((await f.entries()).some(entry => entry.cmd === "get_app_state"), false);
    const exact = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual(exact.isError, true, JSON.stringify(exact.content));
    assert.equal((await f.entries()).filter(entry => entry.cmd === "get_app_state").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`conflicting pid and bundle cannot observe another app: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "conflicting-observation-target", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, bundle: "test.other", window_id: 900 } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /computer_app_identity_unavailable/);
    assert.equal((await f.entries()).some(entry => entry.cmd === "get_app_state"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) for (const scenario of ["pid", "window"] as const) test(`observation reply must match its requested target: ${route}, ${scenario}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, scenario === "pid" ? { observationPid: 43 } : { observationWindowId: 901 });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "observation-target-check", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /capture_target_mismatch/);
    assert.equal((result.content as { type: string }[]).some(part => part.type === "image"), false);
    const action = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, x: 10, y: 10 } });
    assert.equal(action.isError, true);
    assert.equal((await f.entries()).some(entry => entry.cmd === "click"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) for (const scenario of ["delayed", "multiple", "focused", "conflicting-focus"] as const) test(`auto-launch waits for an exact window before observing: ${route}, ${scenario}`, { timeout: 12_000 }, async t => {
  const windows = scenario === "delayed" ? [{ window_id: 900, onscreen: true }] : [
    { window_id: 900, onscreen: true, focused: scenario === "conflicting-focus" },
    { window_id: 901, onscreen: true, focused: scenario === "focused" || scenario === "conflicting-focus" }
  ];
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }], { launchWindowSequence: [[], windows], observationWindowId: scenario === "focused" ? 901 : 900 });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "launch-window-readiness", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    const entries = await f.entries();
    assert.equal(entries.filter(entry => entry.cmd === "launch_app").length, 1);
    assert.ok(entries.filter(entry => entry.cmd === "list_apps" && entry.args.pid === 42).length >= 2);
    if (scenario === "delayed" || scenario === "focused") {
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal(entries.find(entry => entry.cmd === "get_app_state")?.args.window_id, scenario === "focused" ? 901 : 900);
      assert.ok((result.content as { type: string }[]).some(part => part.type === "image"));
    } else {
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /computer_window_selection_required/);
      assert.equal(entries.some(entry => entry.cmd === "get_app_state"), false);
    }
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`auto-launch reports a bounded wait when no window appears: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }], { launchWindowSequence: [[]] });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "launch-window-timeout", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const result = await client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /computer_window_not_ready/);
    assert.match(JSON.stringify(result.content), /不要重复启动/);
    const entries = await f.entries();
    assert.equal(entries.filter(entry => entry.cmd === "launch_app").length, 1);
    assert.equal(entries.some(entry => entry.cmd === "get_app_state"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`disabling control during launch window discovery prevents capture: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }], { launchWindowSequence: [[], [{ window_id: 900 }]] });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "launch-window-disable", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const pending = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } });
    const deadline = Date.now() + 4_000;
    while (!(await f.entries().catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).some(entry => entry.cmd === "list_apps" && entry.args.pid === 42)) {
      assert.ok(Date.now() < deadline, "window discovery did not start");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, enabled: false } }));
    if (route === "desktop-mcp") await f.service.controller.disable();
    const result = await pending;
    assert.equal(result.isError, true);
    const entries = await f.entries();
    assert.equal(entries.filter(entry => entry.cmd === "launch_app").length, 1);
    assert.equal(entries.some(entry => entry.cmd === "get_app_state"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`cancelling launch window discovery stops before capture: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }], { launchWindowSequence: [[]] });
  f.service.controller.setPreview(false);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "launch-window-cancel", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const cancellation = new AbortController();
    const pending = client.callTool({ name: "sky_get_app_state", arguments: { app: "test.fixture" } }, undefined, { signal: cancellation.signal }).then(() => false, () => true);
    const deadline = Date.now() + 4_000;
    while (!(await f.entries().catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).some(entry => entry.cmd === "list_apps" && entry.args.pid === 42)) {
      assert.ok(Date.now() < deadline, "window discovery did not start");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    cancellation.abort();
    assert.equal(await pending, true);
    await policy.close();
    const entries = await f.entries();
    assert.equal(entries.filter(entry => entry.cmd === "launch_app").length, 1);
    assert.equal(entries.some(entry => entry.cmd === "get_app_state"), false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`system application usage reaches both application lists: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, [
    { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true, lastUsed: "2026-10-27T00:00:00Z", useCount: 17 },
    { name: "Recent", bundleId: "test.recent", running: false, lastUsed: "2026-10-26T00:00:00Z", useCount: 3 }
  ]);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "application-usage", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const ordinary = await client.callTool({ name: "list_apps", arguments: {} });
    assert.notEqual(ordinary.isError, true);
    const apps = JSON.parse((ordinary.content as { text: string }[])[0]!.text).apps;
    assert.equal(apps[0].useCount, 17); assert.equal(apps[0].lastUsed, "2026-10-27T00:00:00Z");
    assert.equal(apps[1].useCount, 3); assert.equal(apps[1].running, false);
    const sky = await client.callTool({ name: "sky_list_apps", arguments: {} });
    assert.notEqual(sky.isError, true);
    const displayed = JSON.parse((sky.content as { text: string }[])[0]!.text);
    assert.equal(displayed[0].useCount, 17); assert.equal(displayed[0].lastUsedDate, "2026-10-27T00:00:00Z");
    assert.equal(displayed[1].useCount, 3); assert.equal(displayed[1].isRunning, false);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("recently used apps without PID do not block observation, mirrors or external preview of a running target", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const listing = await f.invoke("ComputerList", {});
  assert.deepEqual(listing.apps, [
    { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
    { name: "Recently Used", bundleId: "test.recent", running: false, lastUsed: "2026-10-07T00:00:00Z" }
  ]);
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal(typeof observed.capture_id, "string");
  assert.equal((await f.invoke("ComputerMirror", { operation: "open", ...target })).state, "open");
  assert.equal((await f.externalActivity()).data.visible, true);
  assert.deepEqual((await f.store.load()).computer.apps.map(app => app.bundleId), ["test.fixture"]);
});

for (const scenario of [
  { name: "running application missing PID", apps: [{ name: "Fixture", bundleId: "test.fixture", running: true }], error: /Running applications require a PID/ },
  { name: "non-running application cannot supply target identity", apps: [{ ...target, name: "Fixture", bundleId: "test.fixture", running: false }], error: /computer_app_identity_unavailable/ },
  { name: "ambiguous running PID cannot select an arbitrary identity", apps: [
    { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
    { pid: 42, name: "Other", bundleId: "test.other", running: true }
  ], error: /computer_app_identity_unavailable/ }
]) {
  test(`${scenario.name} refuses capture and mirrors before any native side effect`, { timeout: 8_000 }, async t => {
    const f = await fixture(t, scenario.apps);
    await assert.rejects(f.invoke("ComputerObserve", target), scenario.error);
    await assert.rejects(f.invoke("ComputerMirror", { operation: "open", ...target }), scenario.error);
    await assert.rejects(f.externalActivity(), scenario.error);
    assert.equal((await f.entries()).some(entry => ["get_app_state", "pip_open", "shot_display", "click", "scroll"].includes(entry.cmd)), false);
    assert.deepEqual((await f.store.load()).computer.apps, []);
  });
}

test("mixed app listings still enforce strict approval before capture or mirror dispatch", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval: true } }));
  await assert.rejects(f.invoke("ComputerObserve", target), /computer_app_approval_required/);
  await assert.rejects(f.invoke("ComputerMirror", { operation: "open", ...target }), /computer_app_approval_required/);
  await assert.rejects(f.externalActivity(), /computer_app_approval_required/);
  assert.equal((await f.entries()).every(entry => entry.cmd === "list_apps"), true);
  const pending = (await f.store.load()).computer.apps;
  assert.deepEqual(pending.map(app => app.bundleId), ["test.fixture"]);
  assert.equal(pending[0]?.approvedAt, undefined);
});

test("product observation options survive Desktop and native transport and post-action verification", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const options = { depth: 3, screenshotMaxWidth: 320, interactiveOnly: false };
  const observed = await f.invoke("ComputerObserve", { ...target, ...options });
  assert.equal(observed.screenshot_width, 320);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  const reads = (await f.entries()).filter(entry => entry.cmd === "get_app_state");
  assert.equal(reads.length, 2);
  for (const entry of reads) {
    const { client_id, capture_id, ...options } = entry.args;
    assert.equal(typeof client_id, "string"); assert.equal(typeof capture_id, "string");
    assert.deepEqual(options, { pid: 42, window_id: 900, max_depth: 3, max_width: 320, interactive_only: false });
  }
  assert.ok((await f.store.load()).computer.apps[0]?.approvedAt, "real app approval persisted before capture");
});

test("product scrolling sends the observed element ref to the native process", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "scroll", elementToken: "e1", captureId: observed.capture_id, direction: "down", pages: 2 });
  assert.equal(result.status, "completed");
  const action = JSON.parse(await readFile(path.join(f.directory, "action.json"), "utf8"));
  assert.equal(action.cmd, "scroll"); assert.equal(action.args.ref, "e1"); assert.equal(action.args.pages, 2);
});

test("reference-only click uses the current snapshot and rejects stale or invented refs before input", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", elementToken: "invented", captureId: observed.capture_id }), /element_token_not_in_observation/);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id }), /capture_target_mismatch/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  const action = JSON.parse(await readFile(path.join(f.directory, "action.json"), "utf8"));
  assert.equal(action.args.ref, "e1"); assert.equal("x" in action.args, false);
});

test("Desktop preview captures only pixels of the exact target and leaves model refs usable", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  try {
    f.service.controller.setPreview(true);
    // 帧泵依赖真实进程调度；按请求日志等待下一次捕获，上限三秒。
    const deadline = Date.now() + 3_000;
    let captures: JournalEntry[] = [];
    while (Date.now() < deadline) {
      captures = (await f.entries()).filter(entry => ["get_app_state", "shot_display", "capture_screen"].includes(entry.cmd));
      if (captures.length >= 2) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captures.length >= 2, true, "preview frame request did not arrive");
    assert.equal(captures[1]!.cmd, "shot_display", "preview must not re-observe AX or replace native reference tables");
    assert.equal(captures[1]!.args.pid, 42); assert.equal(captures[1]!.args.window_id, 900);
    f.service.controller.setPreview(false);
    const result = await f.invoke("ComputerAction", { ...target, action: "scroll", elementToken: "e1", captureId: observed.capture_id, direction: "down" });
    assert.equal(result.status, "completed");
  } finally { f.service.controller.setPreview(false); }
});

test("native preview cursor reaches the current Desktop surface after an action", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { previewCursor: { x: 0.25, y: 0.5, remainingMs: 8_000 } });
  const observed = await f.invoke("ComputerObserve", target);
  await f.invoke("ComputerAction", { ...target, action: "click", x: 20, y: 40, captureId: observed.capture_id });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && !f.windows().some(window => window.paints.some(script => script.includes('point={"x":0.25,"y":0.5}')))) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(f.windows().some(window => window.paints.some(script => script.includes('point={"x":0.25,"y":0.5}'))));
  assert.ok(f.windows()[0]!.paints.some(script => script.includes('"label":"Fixture"')), "the computer source uses the authorized application name");
  const request = (await f.entries()).find(entry => entry.cmd === "shot_display")!;
  assert.equal(request.args.pid, 42); assert.equal(request.args.window_id, 900);
});

test("closing a Desktop preview keeps subsequent MCP input running without reopening it", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const first = await f.invoke("ComputerObserve", target);
  await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: first.capture_id });
  const window = f.windows()[0]!;
  const closed = once(window, "closed", { signal: AbortSignal.timeout(2_000) });
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  const next = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 2, y: 3, captureId: next.capture_id });
  assert.equal(result.status, "completed");
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 2);
  await closed;
  assert.equal(f.windows().filter(item => !item.isDestroyed()).length, 0);
});

test("pixel captures clean their files, preserve direct-client refs, and reject missing or cancelled targets", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.driver.observeRaw({ pid: 42 });
  const pixels = await f.driver.captureWindow();
  assert.equal(pixels.images.length, 1);
  assert.equal("capture_id" in pixels.data, false, "pixels cannot masquerade as a new model observation");
  assert.equal("path" in pixels.data, false, "temporary file paths are not returned after deletion");
  await assert.rejects(f.driver.capturePreview({ pid: 42, windowId: "999" }), /capture_window_not_found/);
  const captures = (await f.entries()).filter(entry => entry.cmd === "shot_display");
  assert.equal(captures.length, 2);
  for (const entry of captures) await assert.rejects(stat(String(entry.args.out)), /ENOENT/);
  const requests = (await f.entries()).length;
  await assert.rejects(f.driver.capturePreview(target, AbortSignal.abort()), /abort/iu);
  assert.equal((await f.entries()).length, requests, "pre-cancelled capture cannot reach the process");
  const action = await f.driver.actRaw("scroll", { ref: "e1", direction: "down" });
  assert.equal(action.data.effect, "confirmed", "post-action pixel capture must not clear direct-client references");
});

// 原有端到端替身直接提供效果字段，不能发现原生回包与领域状态的转换缺口。
test("原生无障碍成功回包保留已完成投递，明确权限拒绝后仍可重新观察", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, {});
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  assert.equal(result.error, undefined);
});
test("原生派发前权限拒绝不锁死观察，也不产生输入副作用", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { nativeRefusal: true });
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "refused");
  assert.match(String(result.error), /ax_not_granted/);
  assert.equal(f.service.controller.status().state, "ready");
  await f.invoke("ComputerObserve", target);
  await assert.rejects(stat(path.join(f.directory, "action.json")), { code: "ENOENT" });
});

test("后台输入兼容不接受 delivery 字段的原生服务，并取得动作后的观察", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { rejectDelivery: true });
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  assert.equal(result.observationRequired, false);
  assert.equal((await f.entries()).find(entry => entry.cmd === "click")!.args.delivery, undefined);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "action.json"), "utf8")).cmd, "click");
});

for (const [action, code] of [["click", "input_delivery_unsupported"], ["click", "click_action_unsupported"], ["click", "click_action_unavailable"], ["perform_secondary_action", "secondary_action_unsupported"], ["set_value", "element_value_unsupported"], ["select_text", "selection_unsupported"], ["type_text", "text_input_ax_unsupported"], ["type_text", "text_input_target_not_focused"], ["press_key", "background_keyboard_target_not_focused"], ["press_key", "menu_shortcut_unsupported"], ["press_key", "keyboard_event_creation_failed"], ["scroll", "scroll_event_creation_failed"], ["scroll", "scroll_target_unavailable"], ["scroll", "element_ref_not_observed"]] as const) test(`明确不支持的原生动作报告未执行: ${code}`, { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { nativeError: code });
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action, elementToken: "e1", captureId: observed.capture_id,
    secondaryAction: action === "perform_secondary_action" ? "AXPress" : undefined, value: action === "set_value" ? "abc" : undefined,
    matchText: action === "select_text" ? "abc" : undefined, text: action === "type_text" ? "abc" : undefined, inputMethod: action === "type_text" ? code === "text_input_target_not_focused" ? "auto" : "ax" : undefined, key: action === "press_key" ? "cmd+s" : undefined, direction: action === "scroll" ? "down" : undefined });
  assert.equal(result.status, "refused");
  assert.match(String(result.error), new RegExp(code));
  assert.equal(f.service.controller.status().state, "ready");
  assert.equal((await f.entries()).filter(entry => entry.cmd === action).length, 1);
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) test(`automatic text fallback reports its actual input method: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { autoInputMethod: "physical" });
  if (route === "builtin") {
    const observed = await f.invoke("ComputerObserve", target);
    const result = await f.invoke("ComputerAction", { ...target, action: "type_text", elementToken: "e1", captureId: observed.capture_id, text: "abc", inputMethod: "auto" });
    assert.match(JSON.stringify(result), /"inputMethod":"physical"/);
  } else {
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const client = new Client({ name: "auto-text-route", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(left), server.connect(right)]);
      assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
      const result = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 900, ref: "e1", text: "abc", input_method: "auto" } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.match(JSON.stringify(result), /inputMethod.*physical/);
    } finally { await client.close(); await server.close(); await policy.close(); }
  }
  const inputs = (await f.entries()).filter(entry => entry.cmd === "type_text");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.args.input_method, "auto");
  assert.equal(inputs[0]!.args.ref, "e1");
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`unfocused automatic text fallback is a pre-dispatch refusal: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { nativeError: "text_input_target_not_focused" });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "auto-text-focus-refusal", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observe = async () => await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } });
    assert.notEqual((await observe()).isError, true);
    const result = await client.callTool({ name: "type_text", arguments: { pid: 42, window_id: 900, ref: "e1", text: "abc", input_method: "auto" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /text_input_target_not_focused/);
    assert.doesNotMatch(JSON.stringify(result), /outcome_unknown/);
    await assert.rejects(stat(path.join(f.directory, "action.json")), { code: "ENOENT" });
    assert.notEqual((await observe()).isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "type_text").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const route of ["standalone", "desktop-mcp"] as const) for (const code of ["scroll_target_unavailable", "element_ref_not_observed"] as const) test(`scroll target rejection stays pre-dispatch: ${route}, ${code}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { nativeError: code });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "scroll-target-refusal", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    const result = await client.callTool({ name: "scroll", arguments: { pid: 42, window_id: 900, ref: "e1", direction: "down" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), new RegExp(code));
    assert.doesNotMatch(JSON.stringify(result), /outcome_unknown/);
    await assert.rejects(stat(path.join(f.directory, "action.json")), { code: "ENOENT" });
  } finally { await client.close(); await server.close(); await policy.close(); }
});

for (const [action, code] of [["click", "click_action_outcome_unknown"], ["scroll", "scroll_action_outcome_unknown"], ["perform_secondary_action", "secondary_action_outcome_unknown"], ["set_value", "value_action_outcome_unknown"], ["select_text", "selection_outcome_unknown"], ["type_text", "text_input_outcome_unknown"], ["type_text", "background_keyboard_target_not_focused"], ["type_text", "keyboard_event_creation_failed"], ["press_key", "menu_shortcut_outcome_unknown"]] as const) test(`输入结果未知且不会重试: ${action}, ${code}`, { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { nativeError: code });
  const observed = await f.invoke("ComputerObserve", target);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action, elementToken: "e1", captureId: observed.capture_id,
    direction: action === "scroll" ? "down" : undefined, value: action === "set_value" ? "abc" : undefined,
    matchText: action === "select_text" ? "abc" : undefined, text: action === "type_text" ? "abc" : undefined, inputMethod: action === "type_text" ? code === "text_input_outcome_unknown" ? "ax" : "unicode" : undefined, key: action === "press_key" ? "cmd+s" : undefined }), /outcome unknown|outcome_unknown/i);
  assert.equal(f.service.controller.status().state, "unknown");
  assert.equal((await f.entries()).filter(entry => entry.cmd === action).length, 1);
});

for (const route of ["standalone", "desktop-mcp"] as const) test(`外部 MCP 的 AX 未知结果不会重放输入: ${route}`, { timeout: 12_000 }, async t => {
  const f = await fixture(t, undefined, { nativeError: "click_action_outcome_unknown" });
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "ax-unknown-external", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.notEqual((await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900 } })).isError, true);
    const result = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e1" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /outcome unknown|outcome_unknown/i);
    const again = await client.callTool({ name: "click", arguments: { pid: 42, window_id: 900, ref: "e1" } });
    assert.equal(again.isError, true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  } finally { await client.close(); await server.close(); await policy.close(); }
});

test("普通观察读图后删除临时截图，原有预览清理覆盖不到这条路径", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  assert.equal(f.images.length, 1);
  await assert.rejects(stat(path.join(f.directory, "state-1.jpg")), { code: "ENOENT" });
});

test("无控件引用的窗口按截图坐标滚动，坐标必须完整且位于当前画面内", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true });
  const observed = await f.invoke("ComputerObserve", target);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "scroll", captureId: observed.capture_id, x: 10, direction: "down" }), /scroll/);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "scroll", captureId: observed.capture_id, x: 110, y: 10, direction: "down" }), /bounds/);
  await f.invoke("ComputerAction", { ...target, action: "scroll", captureId: observed.capture_id, x: 10, y: 20, direction: "down", pages: 2 });
  const action = (await f.entries()).find(entry => entry.cmd === "scroll")!;
  assert.equal(action.args.x, 10); assert.equal(action.args.y, 20);
  assert.equal(action.args.window_id, 900); assert.equal(action.args.pages, 2);
});

test("未启动应用经审批启动后返回真实进程，严格审批拒绝时不得启动", { timeout: 8_000 }, async t => {
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }]);
  assert.ok(f.mcp.createTools().some(tool => tool.name === "ComputerLaunch"), "内置工具必须有受控启动入口");
  await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval: true } }));
  await assert.rejects(f.invoke("ComputerLaunch", { bundleId: "test.fixture" }), /approval_required/);
  assert.equal((await f.entries()).some(entry => entry.cmd === "launch_app"), false);
  assert.equal(f.windows().length, 0, "a refused launch must not open a preview");
  await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval: false } }));
  const result = await f.invoke("ComputerLaunch", { bundleId: "test.fixture" });
  assert.equal(result.pid, 42);
  assert.equal(f.windows().length, 1, "an authorized launch automatically presents supervision");
  assert.ok(f.windows()[0]!.paints.some(script => script.includes("正在等待观察目标")));
  assert.ok(f.windows()[0]!.paints.some(script => script.includes('"label":"Fixture"')), "launch preview uses the authorized application name while waiting");
  assert.equal((await f.entries()).some(entry => ["get_app_state", "shot_display", "capture_screen"].includes(entry.cmd)), false, "launch alone has no authorized window to capture");
  const observed = await f.invoke("ComputerObserve", target);
  assert.ok(observed.capture_id);
  assert.ok(f.windows()[0]!.paints.some(script => script.includes("data:image/jpeg;base64,")), "the target observation fills the existing preview");
  const window = f.windows()[0]!;
  const closed = once(window, "closed", { signal: AbortSignal.timeout(2_000) });
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await f.invoke("ComputerLaunch", { bundleId: "test.fixture" });
  assert.equal(f.windows().length, 1, "launch activity respects the user's dismissal");
  await closed;
  assert.equal(window.destroyed, true);
});

test("launch preview discovers and captures the authorized app window without creating an observation", { timeout: 8_000 }, async t => {
  const f = await fixture(t, [{ name: "Fixture", bundleId: "test.fixture", running: false }], { launchWindows: [{ window_id: 0 }, { window_id: 900, onscreen: true }] });
  const launched = await f.invoke("ComputerLaunch", { bundleId: "test.fixture" });
  assert.equal(launched.pid, 42);
  const deadline = Date.now() + 4_000;
  let entries: JournalEntry[] = [];
  while (Date.now() < deadline) {
    entries = await f.entries();
    if (entries.some(entry => entry.cmd === "shot_display")) break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const shot = entries.find(entry => entry.cmd === "shot_display");
  assert.ok(shot, "the launched application's window must reach the preview without an explicit observation");
  assert.equal(shot.args.pid, 42);
  assert.equal(shot.args.window_id, 900);
  assert.equal(entries.some(entry => entry.cmd === "get_app_state" || entry.cmd === "capture_screen"), false);
  assert.equal(f.service.controller.currentCapture(), undefined, "a preview frame must not grant model input credentials");
  await assert.rejects(f.service.controller.act("fixture-session", { ...target, captureId: "unobserved", action: "click", x: 1, y: 2 }), /capture_target_mismatch/);
});

test("原生输入携带观察身份和调用方身份，不允许只靠进程编号解析控件", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  await f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id });
  const requests = await f.entries();
  const observation = requests.find(entry => entry.cmd === "get_app_state")!;
  const action = requests.find(entry => entry.cmd === "click")!;
  assert.equal(action.args.capture_id, observed.capture_id);
  assert.equal(observation.args.capture_id, observed.capture_id);
  assert.equal(typeof action.args.client_id, "string");
  assert.equal(action.args.client_id, observation.args.client_id);
});

test("外部客户端遵守桌面暂停和接管，不得转到独立原生输入", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  let bypassed = 0;
  const fallback = async () => { bypassed++; return { content: [{ type: "text" as const, text: JSON.stringify({ pid: 42, window_id: 900 }) }] }; };
  try {
    await policy.run("get_app_state", { pid: 42, window_id: 900 }, fallback);
    f.service.controller.control("pause");
    await assert.rejects(policy.run("click", { pid: 42, window_id: 900, x: 1, y: 2 }, fallback), /paused/);
    f.service.controller.control("takeover");
    await assert.rejects(policy.run("get_app_state", { pid: 42, window_id: 900 }, fallback), /taken-over/);
    assert.equal(bypassed, 0);
    assert.equal((await f.entries()).some(entry => entry.cmd === "click"), false);
  } finally { await policy.close(); }
});

test("外部客户端接入桌面后保留列表期限和观察数量选项，原有内置工具测试不覆盖转接", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const fallback = async () => { throw new Error("不应绕过桌面"); };
  try {
    await policy.run("list_apps", { days: 7 }, fallback);
    await policy.run("get_app_state", { pid: 42, window_id: 900, maxElements: 12 }, fallback);
    const entries = await f.entries();
    assert.equal(entries.find(entry => entry.cmd === "list_apps")!.args.recent_days, 7);
    assert.equal(entries.find(entry => entry.cmd === "get_app_state")!.args.max_elements, 12);
    const result = await policy.run("scroll", { pid: 42, window_id: 900, ref: "e1", direction: "down" }, fallback);
    assert.equal(result.isError, false);
    assert.equal(result.content.some(part => part.type === "image"), true);
    assert.equal((await f.entries()).filter(entry => entry.cmd === "scroll").length, 1);
  } finally { await policy.close(); }
});

test("外部 MCP 的截图模式和禁止自动启动经 Desktop 生效", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => f.endpoint);
  const server = createComputerUseMcpServer(f.driver, policy);
  const client = new Client({ name: "observation-contract", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    const observed = await client.callTool({ name: "get_app_state", arguments: {
      pid: 42, window_id: 900, depth: 0, screenshot_max_width: 320, interactive_only: false
    } });
    assert.notEqual(observed.isError, true);
    const entry = (await f.entries()).find(item => item.cmd === "get_app_state")!;
    assert.equal(entry.args.max_depth, 0);
    assert.equal(entry.args.max_width, 320);
    assert.equal(entry.args.interactive_only, false);
    const stopped = await client.callTool({ name: "get_app_state", arguments: { bundle: "test.recent", auto_launch: false } });
    assert.equal(stopped.isError, true);
    assert.equal((await f.entries()).some(item => item.cmd === "launch_app"), false);
    const launched = await client.callTool({ name: "get_app_state", arguments: { bundle: "test.recent", window_id: 900, auto_launch: true } });
    assert.notEqual(launched.isError, true);
    assert.equal((await f.entries()).filter(item => item.cmd === "launch_app").length, 1);
  } finally { await client.close(); await server.close(); }
});

for (const route of ["builtin", "standalone", "desktop-mcp"] as const) {
  test(`shared Computer Use input reaches native transport: ${route}`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const client = new Client({ name: "input-contract", version: "1" });
    const policy = new LocalComputerMcpPolicy(f.driver, f.store, new ComputerAuditStore(), async () => undefined, async () => route === "desktop-mcp" ? f.endpoint : undefined);
    const server = createComputerUseMcpServer(f.driver, policy);
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(left), server.connect(right)]);
      const invoke = async (action: string, fields: Record<string, unknown>, ref: string, captureId: unknown) => {
        if (route === "builtin") {
          const aliases: Record<string, string> = { ref: "elementToken", show_cursor: "showCursor", click_count: "clickCount", coord_space: "coordinateSpace" };
          return await f.invoke("ComputerAction", { ...target, action, captureId, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [aliases[key] ?? key, value === "REF" ? ref : value])) });
        }
        const result = await client.callTool({ name: action, arguments: { pid: 42, window_id: 900, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === "REF" ? ref : value])) } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return result;
      };
      const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
        ["click", { ref: "REF", button: "right", click_count: 2, strategy: "ax", coord_space: "screen" }, { ref: "REF", button: "right", clicks: 2, strategy: "ax", coord_space: "screen" }],
        ["type_text", { ref: "REF", text: "中文", inputMethod: "ax" }, { ref: "REF", text: "中文", input_method: "ax" }],
        ["press_key", { key: "Return" }, { key: "Return" }],
        ["press_key", { key: "F1" }, { key: "F1" }],
        ["press_key", { key: "cmd+opt+esc" }, { key: "cmd+opt+esc" }],
        ["press_key", { key: "Super_L+d" }, { key: "Super_L+d" }],
        ["scroll", { ref: "REF", direction: "left" }, { ref: "REF", direction: "left", pages: 1 }],
        ["drag", { ...(route === "builtin" ? { x1: 1, y1: 2, x2: 30, y2: 40 } : { start_x: 1, start_y: 2, end_x: 30, end_y: 40 }), button: "right", coord_space: "screenshot" }, { x1: 1, y1: 2, x2: 30, y2: 40, button: "right", coord_space: "screenshot" }],
        ["perform_secondary_action", { ref: "REF" }, { ref: "REF" }],
        ["perform_secondary_action", { ref: "REF", ...(route === "builtin" ? { secondaryAction: "AXPress" } : { secondary_action: "AXPress" }) }, { ref: "REF", secondary_action: "AXPress" }],
        ["perform_secondary_action", { x: 31, y: 24, coord_space: "screenshot" }, { x: 31, y: 24, coord_space: "screenshot" }],
        ["perform_secondary_action", { x: -150, y: 500, coord_space: "screen" }, { x: -150, y: 500, coord_space: "screen" }],
        ["set_value", { ref: "REF", value: false }, { ref: "REF", value: false }],
        ["select_text", { ref: "REF", location: 0, length: 2 }, { ref: "REF", location: 0, length: 2 }],
        ["select_text", { ref: "REF", matchText: "目标", prefix: "前", suffix: "后" }, { ref: "REF", match_text: "目标", prefix: "前", suffix: "后" }]
      ];
      for (const [action, fields, expected] of cases) {
        const options = { maxElements: 20, depth: 3, screenshotMaxWidth: 320, interactiveOnly: false };
        const observation = route === "builtin" ? await f.invoke("ComputerObserve", { ...target, ...options }) : await client.callTool({ name: "get_app_state", arguments: { pid: 42, window_id: 900, ...options } });
        assert.notEqual(observation.isError, true);
        const entries = await f.entries();
        const reads = entries.filter(entry => entry.cmd === "get_app_state");
        assert.equal(reads.at(-1)!.args.max_elements, 20);
        assert.equal(reads.at(-1)!.args.max_depth, 3);
        assert.equal(reads.at(-1)!.args.max_width, 320);
        assert.equal(reads.at(-1)!.args.interactive_only, false);
        const ref = `e${reads.length}`;
        const captureId = (observation as Record<string, unknown>).capture_id;
        // Invalid payloads must not dispatch or consume this valid observation.
        for (const invalid of [{ ref: "REF", value: "x".repeat(4001) }, { ref: "e".repeat(257), value: 0 }]) {
          await assert.rejects(invoke("set_value", invalid, ref, captureId));
        }
        await assert.rejects(invoke("click", { ref: "REF", x: 1 }, ref, captureId));
        await invoke(action, { ...fields, show_cursor: false }, ref, captureId);
        const dispatched = (await f.entries()).slice(entries.length).filter(entry => entry.cmd === action);
        assert.equal(dispatched.length, 1);
        const { client_id, capture_id, delivery, ...actual } = dispatched[0]!.args;
        assert.equal(typeof client_id, "string");
        assert.equal(delivery, undefined);
        if (route !== "standalone") assert.equal(typeof capture_id, "string");
        assert.deepEqual(actual, { pid: 42, window_id: 900, show_cursor: false, ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value === "REF" ? ref : value])) });
      }
    } finally { await client.close(); await server.close(); }
  });
}
