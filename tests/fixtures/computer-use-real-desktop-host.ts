import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DesktopBrowserService } from "../../src/desktop/electron/main/DesktopBrowserService.js";
import { createComputerUseService } from "../../src/desktop/electron/main/computerUseService.js";
import { NativeProcessDriver } from "../../src/computer/nativeDriver.js";
import { attachDesktopComputerMcp } from "../../src/computer/desktopMcp.js";
import { McpToolHost } from "../../src/extensions/mcp.js";
import { configSchema, defaultConfig } from "../../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../../src/config/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ToolExecutionCoordinator } from "../../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../../src/runtime/RuntimeAuthority.js";
import { CapabilityStore } from "../../src/runtime/CapabilityStore.js";
import { SessionRecorder } from "../../src/session/recorder.js";
import { readSessionEvents } from "../../src/session/events.js";

const scenario = z.enum(["native", "floating", "geometry", "scroll", "web", "lifecycle", "post-input-close", "cancellation", "pointer"]).parse(process.env.BINY_REAL_DESKTOP_SCENARIO);
const root = z.string().min(1).parse(process.env.BINY_REAL_DESKTOP_ROOT);
const metadata = z.object({ pid: z.number(), port: z.number(), windows: z.object({ native: z.number(), panel: z.number(), web: z.number() }) }).parse(JSON.parse(process.env.BINY_REAL_DESKTOP_FIXTURE ?? "null"));
const pointSchema = z.object({ x: z.number(), y: z.number() });
const stateSchema = z.object({
  clicks: z.number(), panelClicks: z.number(), closedByInput: z.number(), text: z.string(), drags: z.number(), wheelEvents: z.number(), scrollOffset: z.number(), panelWheelEvents: z.number(), panelScrollOffset: z.number(), wheelTrace: z.array(z.record(z.string(), z.unknown())), panelWheelTrace: z.array(z.record(z.string(), z.unknown())),
  frontmost: z.number(), mouse: pointSchema, dragStart: pointSchema, dragEnd: pointSchema, scrollPoint: pointSchema, panelScrollPoint: pointSchema, nativeCountPoint: pointSchema, panelCountPoint: pointSchema, nativeVisible: z.boolean(), panelLevel: z.number(), windowsIgnoreHardwareInput: z.array(z.boolean()).length(3),
  web: z.object({ clicks: z.number(), text: z.string(), inputs: z.array(z.string()), activeElement: z.string(), selectionStart: z.number().nullable(), selectionEnd: z.number().nullable() }),
  selectionLength: z.number(), keyEventCount: z.number(), keyEvents: z.array(z.record(z.string(), z.unknown())), keyWindow: z.number(),
  mainWindow: z.number(), nativeWindow: z.number(), editorWindow: z.number(), editorPresent: z.boolean(), nativeResponderMatchesEditor: z.boolean(), fieldAcceptsFirstMouse: z.boolean(), applicationActive: z.boolean(),
  mouseEvents: z.array(z.record(z.string(), z.unknown())), mouseMoves: z.number(), mouseMoveSources: z.record(z.string(), z.number()), mouseMoveStates: z.record(z.string(), z.number()), lastHardwareMouse: pointSchema.nullable(), webAcceptsFirstMouse: z.boolean(), nativeAcceptsFirstMouse: z.boolean()
});

function query(operation = "state", window = "native"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: metadata.port });
    let body = "";
    const timer = setTimeout(() => socket.destroy(new Error("owned fixture query timed out")), 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(JSON.stringify({ operation, window })));
    socket.on("data", chunk => { body += chunk; if (body.length > 65_536) socket.destroy(new Error("owned fixture response exceeded its bound")); });
    socket.once("error", reject);
    socket.once("close", () => clearTimeout(timer));
    socket.once("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
}
const state = async () => stateSchema.parse(await query());
async function webAccessibility(): Promise<Record<string, unknown>> {
  const executable = z.string().min(1).parse(process.env.BINY_REAL_DESKTOP_FIXTURE_EXE);
  const result = await promisify(execFile)(executable, ["--probe-accessibility", String(metadata.pid)], { timeout: 5_000, maxBuffer: 65_536 });
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
}
async function until(predicate: (value: z.infer<typeof stateSchema>) => boolean): Promise<z.infer<typeof stateSchema>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await state();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `actual fixture state did not reach its required postcondition: ${JSON.stringify(value)}`);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

async function run(): Promise<void> {
  app.setPath("userData", path.join(root, "electron"));
  app.setActivationPolicy("accessory");
  app.on("browser-window-created", (_event, window) => window.setIgnoreMouseEvents(true));
  await app.whenReady();
  let browser: DesktopBrowserService | undefined;
  let service: Awaited<ReturnType<typeof createComputerUseService>> | undefined;
  let driver: NativeProcessDriver | undefined;
  let mcp: McpToolHost | undefined;
  let recorder: SessionRecorder | undefined;
  let capabilities: CapabilityStore | undefined;
  let authority: RuntimeEventAuthority | undefined;
  let failed = false;
  try {
    console.log("REAL_DESKTOP_STEP host-ready");
    const store = createFileConfigStore(root, { globalDir: root, credentialStore: { persistent: false, get: async () => undefined, set: async () => undefined, delete: async () => undefined } });
    await updateConfig(store, undefined, () => configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] }, computer: { enabled: true, previewEnabled: scenario === "pointer", strictApproval: false, actionLogging: false, apps: [] } }));
    browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"));
    service = await createComputerUseService(browser, () => undefined, async () => undefined, store, onExit => {
      driver = new NativeProcessDriver(onExit, { binaryPath: process.env.BINY_REAL_DESKTOP_HELPER, socketDir: root });
      return driver;
    });
    assert.ok(driver);
    console.log("REAL_DESKTOP_STEP production-helper");
    const doctor = (await driver.diagnostics()).data;
    if (doctor.accessibility !== "granted" || doctor.screenRecording !== "granted" || doctor.focusGuard !== "armed") {
      console.log("REAL_DESKTOP_RESULT " + JSON.stringify({ skip: `Production helper requires Accessibility, Screen Recording and an armed focus guard: ${JSON.stringify(doctor)}` }));
    } else {
      const endpoint = await browser.startAutomationServer(path.join(root, "desktop.sock"));
      mcp = new McpToolHost();
      await attachDesktopComputerMcp(mcp, endpoint);
      const registry = new ToolRegistry();
      for (const tool of mcp.createTools()) registry.registerMcpTool(tool);
      authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
      capabilities = await CapabilityStore.open(root, authority);
      recorder = new SessionRecorder(root, "real-desktop");
      recorder.setRuntimeContext({ runId: "real-desktop-run", turnId: "real-desktop-turn" });
      const config = await store.load();
      const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities, runId: "real-desktop-run", turnId: "real-desktop-turn" }, new PermissionManager(config.permission), () => undefined, () => ({}));
      let call = 0;
      const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        coordinator.assertCanContinue();
        console.log(`REAL_DESKTOP_STEP ${name} ${call + 1}`);
        const tool = coordinator.createAgentTools().find(tool => tool.name === name);
        assert.ok(tool, `${name} must be exposed through the actual Desktop MCP`);
        const result = await tool.execute(`real-desktop-${++call}`, args, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
        await coordinator.waitForIdle();
        return { error: result.isError === true, value: z.record(z.string(), z.unknown()).parse(result.details) };
      };
      const target = (kind: keyof typeof metadata.windows) => ({ pid: metadata.pid, windowId: String(metadata.windows[kind]) });
      const observe = async (kind: keyof typeof metadata.windows) => {
        const result = await invoke("ComputerObserve", { ...target(kind), maxElements: 300, depth: 15 });
        assert.equal(result.error, false, JSON.stringify(result.value));
        assert.equal(typeof result.value.capture_id, "string");
        return result.value;
      };
      const token = (capture: Record<string, unknown>, label: string) => {
        const role = ["FixtureText", "WebText"].includes(label) ? "AXTextField" : "AXButton";
        const line = String(capture.tree).split("\n").find(line => line.includes(role) && line.includes(JSON.stringify(label)));
        const ref = line?.match(/\(([^)]+)\)\s+AX/u)?.[1];
        assert.ok(ref, `real accessibility observation must contain ${label}: ${String(capture.tree)}`);
        return ref;
      };
      const screenshotPoint = (capture: Record<string, unknown>, point: z.infer<typeof pointSchema>) => {
        const frame = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).parse(capture.windowFrame);
        const width = z.number().positive().parse(capture.screenshot_width);
        const height = z.number().positive().parse(capture.screenshot_height);
        return { x: (point.x - frame.x) * width / frame.w, y: (point.y - frame.y) * height / frame.h };
      };
      const act = async (kind: keyof typeof metadata.windows, capture: Record<string, unknown>, args: Record<string, unknown>, expectRefusal = false) => {
        let before = await state();
        let quietSince = Date.now();
        const idleDeadline = Date.now() + 3_000;
        while (Date.now() - quietSince < 120) {
          assert.ok(Date.now() < idleDeadline, "the real desktop pointer did not become idle before the input probe");
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          const current = await state();
          if (current.mouse.x !== before.mouse.x || current.mouse.y !== before.mouse.y) quietSince = Date.now();
          before = current;
        }
        assert.notEqual(before.frontmost, metadata.pid, "each input must start with the fixture in the background");
        const result = await invoke("ComputerAction", { ...target(kind), captureId: capture.capture_id, ...args });
        let after = await state();
        assert.equal(after.frontmost, before.frontmost, "background actions must preserve the actual frontmost process");
        const samePoint = (a: z.infer<typeof pointSchema>, b: z.infer<typeof pointSchema> | null) => b !== null && a.x === b.x && a.y === b.y;
        if (!samePoint(after.mouse, before.mouse) && after.mouseMoves === before.mouseMoves) {
          after = await until(value => value.mouseMoves > before.mouseMoves || samePoint(value.mouse, before.mouse));
        }
        if (after.mouseMoves === before.mouseMoves) assert.deepEqual(after.mouse, before.mouse, "without hardware input, background actions must preserve the actual system pointer");
        else {
          after = await until(value => samePoint(value.mouse, value.lastHardwareMouse));
          assert.deepEqual(after.mouse, after.lastHardwareMouse, "during concurrent hardware input, the pointer must follow the real hardware event position");
        }
        for (const [source, count] of Object.entries(after.mouseMoveSources)) {
          if (source !== "0") assert.equal(count, before.mouseMoveSources[source] ?? 0, "background input must not create a global pointer event from another process");
        }
        for (const [source, count] of Object.entries(after.mouseMoveStates)) {
          if (source !== "0:1") assert.equal(count, before.mouseMoveStates[source] ?? 0, "only independently observed HID events may explain concurrent system pointer movement");
        }
        assert.equal(result.error, expectRefusal, JSON.stringify(result.value));
        coordinator.assertCanContinue();
        return result.value;
      };

      const initial = await state();
      assert.notEqual(initial.frontmost, metadata.pid, "the fixture must run as a background app");
      assert.deepEqual(initial.windowsIgnoreHardwareInput, [true, true, true], "owned test windows must let the user continue operating through them");
      assert.equal(initial.panelLevel, 27, "the floating window must exercise the reported nonzero CG window layer");
      const discoveryDeadline = Date.now() + 5_000;
      while (true) {
        const listed = await invoke("ComputerList", { pid: metadata.pid });
        assert.equal(listed.error, false);
        const required = scenario === "floating" || scenario === "scroll" ? ["native", "panel"] as const : scenario === "web" ? ["native", "web"] as const : ["native"] as const;
        const missing = required.filter(kind => !JSON.stringify(listed.value).includes(String(metadata.windows[kind])));
        if (missing.length === 0) break;
        assert.ok(Date.now() < discoveryDeadline, `${missing.join(",")} must be discovered by the real helper: ${JSON.stringify(listed.value)}`);
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }

      let capture: Record<string, unknown>;
      if (scenario === "native") {
        capture = await observe("native");
        const oldCapture = capture;
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical" });
        await until(value => value.clicks === 1);
        await act("native", oldCapture, { action: "click", elementToken: token(oldCapture, "NativeCount"), strategy: "physical" }, true);
        assert.equal((await state()).clicks, 1, "a consumed observation cannot replay the click");
        capture = await observe("native");
        capture = await act("native", capture, { action: "set_value", elementToken: token(capture, "FixtureText"), value: "中文 Ω 42" });
        assert.equal((await state()).text, "中文 Ω 42");
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "FixtureText"), strategy: "physical" });
        const calibration = z.object({ accepted: z.boolean(), selectedLength: z.number() }).passthrough().parse(await query("calibrateMenu"));
        assert.equal(calibration.accepted, true, `the owned fixture's real Edit menu must support Select All: ${JSON.stringify(calibration)}`);
        const beforeKeyboard = await state();
        assert.equal(beforeKeyboard.editorWindow, metadata.windows.native);
        assert.equal(beforeKeyboard.nativeResponderMatchesEditor, true);
        assert.equal(beforeKeyboard.keyWindow, 0);
        assert.equal(beforeKeyboard.mainWindow, 0);
        assert.equal(beforeKeyboard.selectionLength, 0);
        capture = await act("native", capture, { action: "press_key", key: "cmd+a" });
        const selected = await state();
        const keyboardEvents = selected.keyEvents.slice(-(selected.keyEventCount - beforeKeyboard.keyEventCount));
        assert.ok(selected.keyEventCount >= beforeKeyboard.keyEventCount + 2);
        assert.ok(keyboardEvents.some(event => event.type === 10 && event.window === metadata.windows.native && event.code === 0 && Number(event.flags) & (1 << 20)), "the cold background keyboard probe must actually receive Command+A in the exact target window");
        assert.equal(selected.selectionLength, 0, "a cold background application without a key/main menu context must not be reported as having selected its text");
        assert.equal(capture.status, "unverified");
        assert.equal(capture.verificationRequired, true);
        assert.equal(selected.text, "中文 Ω 42");
        capture = await observe("native");
        capture = await act("native", capture, { action: "select_text", elementToken: token(capture, "FixtureText"), location: 0, length: 7 });
        await until(value => value.selectionLength === 7 && value.text === "中文 Ω 42");
        capture = await act("native", capture, { action: "type_text", elementToken: token(capture, "FixtureText"), text: "键盘输入 ABC", inputMethod: "unicode" });
        await until(value => value.text === "键盘输入 ABC");
        const drag = await state();
        await act("native", capture, { action: "drag", coordinateSpace: "screen", x1: drag.dragStart.x, y1: drag.dragStart.y, x2: drag.dragEnd.x, y2: drag.dragEnd.y });
        await until(value => value.drags > 0);
      }
      if (scenario === "geometry") {
        let clicks = 0;
        for (const operation of ["move", "resize"]) {
          capture = await observe("native");
          const oldPoint = screenshotPoint(capture, (await state()).nativeCountPoint);
          await query(operation);
          const changed = await act("native", capture, { action: "click", ...oldPoint, strategy: "physical" }, true);
          assert.match(JSON.stringify(changed), /geometry_changed/u);
          assert.equal((await state()).clicks, clicks, "geometry changes must not redirect an old screenshot coordinate");
          capture = await observe("native");
          await act("native", capture, { action: "click", ...screenshotPoint(capture, (await state()).nativeCountPoint), strategy: "physical" });
          clicks++;
          await until(value => value.clicks === clicks);
        }
      }
      if (scenario === "lifecycle") {
        capture = await observe("native");
        await query("hide");
        const refused = await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical" }, true);
        assert.equal(refused.status, "refused", "a hidden target must be a known no-input refusal");
        assert.equal((await state()).clicks, 0);
        await query("show");
        capture = await observe("native");
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical" });
        await until(value => value.clicks === 1);
        await query("close");
        const closed = await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical" }, true);
        assert.equal(closed.status, "refused");
        assert.equal((await state()).clicks, 1);
      }
      if (scenario === "floating" || scenario === "scroll") {
        let panel = await observe("panel");
        panel = await act("panel", panel, { action: "click", ...screenshotPoint(panel, (await state()).panelCountPoint), strategy: "physical" });
        await until(value => value.panelClicks === 1);
        if (scenario === "scroll") {
          capture = await observe("native");
          const beforeNativeScroll = await state();
          await act("native", capture, { action: "scroll", coordinateSpace: "screen", ...beforeNativeScroll.scrollPoint, direction: "down", pages: 1 });
          const settleScroll = async (kind: "native" | "panel", baseline: z.infer<typeof stateSchema>) => {
            const changed = (value: z.infer<typeof stateSchema>) => kind === "native"
              ? value.wheelEvents > baseline.wheelEvents && value.scrollOffset > baseline.scrollOffset
              : value.panelWheelEvents > baseline.panelWheelEvents && value.panelScrollOffset > baseline.panelScrollOffset;
            let previous = await until(changed);
            let quietSince = Date.now();
            const deadline = Date.now() + 3_000;
            while (Date.now() - quietSince < 120) {
              assert.ok(Date.now() < deadline, "the actual scroll stream did not settle");
              await new Promise<void>(resolve => setTimeout(resolve, 25));
              const current = await state();
              if (current.wheelEvents !== previous.wheelEvents || current.panelWheelEvents !== previous.panelWheelEvents || current.scrollOffset !== previous.scrollOffset || current.panelScrollOffset !== previous.panelScrollOffset) quietSince = Date.now();
              previous = current;
            }
            assert.ok(changed(previous), "scrolling down must leave the actual document below its original offset");
            return previous;
          };
          const afterNativeScroll = await settleScroll("native", beforeNativeScroll);
          assert.equal(afterNativeScroll.panelWheelEvents, beforeNativeScroll.panelWheelEvents, "same-PID scrolling must not leak to the internally focused panel");
          panel = await observe("panel");
          const beforePanelScroll = await state();
          await act("panel", panel, { action: "scroll", ...screenshotPoint(panel, beforePanelScroll.panelScrollPoint), direction: "down", pages: 1 });
          const afterPanelScroll = await settleScroll("panel", beforePanelScroll);
          assert.equal(afterPanelScroll.wheelEvents, beforePanelScroll.wheelEvents, "panel scrolling must not leak to another window in the same process");
        }
      }
      if (scenario === "web") {
        let web = await observe("web");
        assert.equal((await state()).webAcceptsFirstMouse, false, "the fixture must preserve ordinary WKWebView first-mouse behavior");
        const physical = await act("web", web, { action: "click", elementToken: token(web, "WebCount"), strategy: "physical" });
        assert.equal((await state()).web.clicks, 0, "a background first physical click must not be mistaken for DOM activation");
        assert.equal(physical.status, "unverified");
        assert.equal(physical.verificationRequired, true);
        web = await observe("web");
        web = await act("web", web, { action: "click", elementToken: token(web, "WebCount"), strategy: "ax" });
        await until(value => value.web.clicks === 1);
        const beforeAX = await webAccessibility();
        console.log("REAL_DESKTOP_STEP web-accessibility-before " + JSON.stringify(beforeAX));
        const attributes = z.object({ fields: z.array(z.object({ role: z.literal("AXTextField"), windowTitle: z.literal("Biny Real Web Fixture"), AXValue: z.object({ status: z.literal(0), writableStatus: z.literal(0), writable: z.literal(true), value: z.string() }) })).length(1) }).parse(beforeAX);
        assert.equal(attributes.fields[0]!.AXValue.value, "web-initial");
        web = await act("web", web, { action: "set_value", elementToken: token(web, "WebText"), value: "Web 中文 123" });
        const afterAX = await webAccessibility();
        const afterValue = (await state()).web;
        console.log("REAL_DESKTOP_STEP web-accessibility-after " + JSON.stringify({ ax: afterAX, dom: afterValue, receipt: web.action }));
        const valueReceipt = web;
        web = await observe("web");
        web = await act("web", web, { action: "click", elementToken: token(web, "WebText"), strategy: "ax" });
        const focusReceipt = web;
        const afterPress = await state();
        console.log("REAL_DESKTOP_STEP web-after-press " + JSON.stringify({ dom: afterPress.web, receipt: focusReceipt.action, ax: await webAccessibility() }));
        web = await observe("web");
        web = await act("web", web, { action: "select_text", elementToken: token(web, "WebText"), location: 0, length: afterValue.text.length });
        await until(value => value.web.selectionStart === 0 && value.web.selectionEnd === afterValue.text.length && value.web.text === afterValue.text && value.web.activeElement === "field");
        await act("web", web, { action: "type_text", elementToken: token(web, "WebText"), inputMethod: "unicode", text: "Web 中文 123" });
        const after = await until(value => value.web.text === "Web 中文 123");
        assert.equal(after.web.clicks, 1);
        assert.ok(after.web.inputs.length > 0, "the actual WKWebView must receive DOM input events");
        if (afterValue.text !== "Web 中文 123") {
          assert.equal(valueReceipt.status, "unverified", "an accepted AX write that did not change the actual DOM cannot claim completion");
          assert.equal(valueReceipt.verificationRequired, true);
        }
      }
      if (scenario === "post-input-close") {
        capture = await observe("native");
        const completed = await act("native", capture, { action: "click", elementToken: token(capture, "CloseAfterInput"), strategy: "physical" });
        await until(value => value.closedByInput === 1);
        assert.equal(completed.observationRequired, true, "closing the target after input must retain the receipt despite capture failure");
        assert.equal(completed.doNotRepeat, true);
        assert.ok(completed.action, "a dispatched click must retain its native receipt");
      }
      if (scenario === "pointer") {
        const cursorSchema = z.object({ eventId: z.number().int().positive(), image: z.object({ mimeType: z.literal("image/png"), dataBase64: z.string().min(1) }), hotspot: pointSchema });
        const domSchema = z.object({ hidden: z.boolean(), shape: z.string(), source: z.string(), naturalWidth: z.number(), hotspotX: z.number(), hotspotY: z.number(), eventKey: z.string(), frameLoaded: z.boolean(), badge: z.string(), animation: z.string(), diagnostic: z.string() });
        const readPointer = async () => {
          const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith("data:text/html"));
          if (!window) return undefined;
          return domSchema.parse(await window.webContents.executeJavaScript(`(()=>{const marker=document.getElementById('agent-cursor'),arrow=document.getElementById('agent-cursor-image'),frame=document.getElementById('frame');return {hidden:marker.hidden,shape:marker.dataset.shape??'',source:arrow.getAttribute('src')??'',naturalWidth:arrow.naturalWidth,hotspotX:parseFloat(marker.style.getPropertyValue('--hotspot-x'))||0,hotspotY:parseFloat(marker.style.getPropertyValue('--hotspot-y'))||0,eventKey:marker.dataset.eventKey??'',frameLoaded:frame.dataset.loaded==='true',badge:document.getElementById('agent-cursor-badge').textContent??'',animation:getComputedStyle(arrow).animationName,diagnostic:document.getElementById('status').textContent??''}})()`));
        };
        const waitPointer = async (visible: boolean) => {
          const deadline = Date.now() + 5_000;
          while (true) {
            const value = await readPointer();
            if (value && (visible ? !value.hidden && value.shape === "arrow" && value.naturalWidth > 0 && value.frameLoaded : value.hidden)) return value;
            assert.ok(Date.now() < deadline, `the actual Desktop preview did not show the required pointer state: ${JSON.stringify(value)}`);
            await new Promise<void>(resolve => setTimeout(resolve, 25));
          }
        };
        capture = await observe("native");
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical", showCursor: true });
        await until(value => value.clicks === 1);
        const raw = await driver.capturePreview(target("native"));
        const cursor = cursorSchema.parse(raw.data.cursor);
        assert.deepEqual([...Buffer.from(cursor.image.dataBase64, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "the real helper must provide a decodable PNG cursor asset");
        const shown = await waitPointer(true);
        assert.equal(shown.source, `data:image/png;base64,${cursor.image.dataBase64}`, "the real preview must render the helper's cursor image");
        assert.deepEqual(cursor.hotspot, { x: 13, y: 22 }, "the pointer's feet must align to the actual click point");
        assert.equal(shown.hotspotX, 13);
        assert.equal(shown.hotspotY, 22);
        assert.match(shown.badge, /^Biny(?: |$)/u);
        assert.equal(shown.animation, "agent-cursor-breathe");
        const preview = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().startsWith("data:text/html"));
        assert.ok(preview);
        if (process.env.BINY_TEST_COMPUTER_PREVIEW_IMAGE) await writeFile(process.env.BINY_TEST_COMPUTER_PREVIEW_IMAGE, (await preview.webContents.capturePage()).toPNG());
        assert.ok(shown.eventKey.endsWith(`:${cursor.eventId}`), "the preview must preserve the native action identity");
        await preview.webContents.executeJavaScript(`(()=>{
          const marker=document.getElementById('agent-cursor'),arrow=document.getElementById('agent-cursor-image');
          window.realPointerTravel=[];window.realPointerTrace=[{dataset:{...marker.dataset},hidden:marker.hidden}];window.realPointerSeen=new Set();
          window.realPointerObserver=new MutationObserver(()=>{window.realPointerTrace.push({dataset:{...marker.dataset},hidden:marker.hidden,animations:arrow.getAnimations().map(item=>item.id)});for(const animation of arrow.getAnimations()){if(animation.id!=='agent-travel'||window.realPointerSeen.has(animation))continue;window.realPointerSeen.add(animation);window.realPointerTravel.push({animation,eventKey:marker.dataset.eventKey,frames:animation.effect.getKeyframes().map(frame=>{const matrix=new DOMMatrix(frame.transform);return {x:matrix.m41,y:matrix.m42,sx:matrix.m11,sy:matrix.m22,clipPath:frame.clipPath}})});}});
          window.realPointerObserver.observe(marker,{attributes:true,attributeFilter:['data-event-key']});
        })()`);
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "FixtureText"), strategy: "physical", showCursor: true });
        await until(value => value.editorPresent && value.editorWindow === metadata.windows.native);
        const travelSchema = z.object({ reduced: z.boolean(), records: z.array(z.object({ eventKey: z.string(), frames: z.array(z.object({ x: z.number(), y: z.number(), sx: z.number(), sy: z.number(), clipPath: z.string() })) })) });
        const readTravel = async () => travelSchema.parse(await preview.webContents.executeJavaScript(`({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,records:window.realPointerTravel.map(record=>({eventKey:record.eventKey,frames:record.frames}))})`));
        const travelDeadline = Date.now() + 5_000;
        let travel = await readTravel();
        while (!travel.reduced && travel.records.length === 0) {
          assert.ok(Date.now() < travelDeadline, "the actual second pointer action must create a Web Animation: " + JSON.stringify(await preview.webContents.executeJavaScript(`window.realPointerTrace`)));
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          travel = await readTravel();
        }
        if (travel.reduced) assert.equal(travel.records.length, 0, "reduced motion must disable pointer travel");
        else {
          assert.equal(travel.records.length, 1, "one new physical action must create exactly one pointer travel animation");
          const frames = travel.records[0]!.frames;
          const first = frames[0]!;
          assert.notEqual(first.x, 0, "the real controls must require horizontal pointer travel");
          assert.ok(frames.some(frame => frame.clipPath.includes('5.5px') && frame.sx < 1 && frame.sy > 1 && frame.y < first.y * frame.x / first.x - 2), "the actual Web Animation must lift the pointer above its travel line and tuck its feet");
        }
        const movedCursor = cursorSchema.parse((await driver.capturePreview(target("native"))).data.cursor);
        assert.notEqual(movedCursor.eventId, cursor.eventId);
        const later = cursorSchema.parse((await driver.capturePreview(target("native"))).data.cursor);
        assert.equal(later.eventId, movedCursor.eventId, "a pixel refresh must not synthesize a new click event");
        await preview.webContents.executeJavaScript(`Promise.all(window.realPointerTravel.map(record=>record.animation.finished.catch(()=>undefined)))`);
        const refreshedTravel = await readTravel();
        assert.equal(refreshedTravel.records.length, travel.records.length, "refreshing the same native action must not replay pointer travel");
        const recoveryDeadline = Date.now() + 5_000;
        let recovered = await readPointer();
        while (!recovered || /capture_busy/u.test(recovered.diagnostic) || !recovered.frameLoaded) {
          assert.ok(Date.now() < recoveryDeadline, `the real preview pump must recover its capture diagnostic: ${JSON.stringify(recovered)}`);
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          recovered = await readPointer();
        }
        assert.equal(/capture_busy/u.test(recovered.diagnostic), false);
        if (process.env.BINY_TEST_COMPUTER_PREVIEW_IMAGE) await writeFile(process.env.BINY_TEST_COMPUTER_PREVIEW_IMAGE, (await preview.webContents.capturePage()).toPNG());
        await act("native", capture, { action: "click", elementToken: token(capture, "NativeCount"), strategy: "physical", showCursor: false });
        await until(value => value.clicks === 2);
        assert.equal((await driver.capturePreview(target("native"))).data.cursor, undefined, "single-action suppression must clear the actual native pointer snapshot");
        await waitPointer(false);
      }
      if (scenario === "cancellation") {
        capture = await observe("native");
        capture = await act("native", capture, { action: "set_value", elementToken: token(capture, "FixtureText"), value: "" });
        capture = await act("native", capture, { action: "click", elementToken: token(capture, "FixtureText"), strategy: "physical" });
        const cancelled = new AbortController();
        const requested = "z".repeat(3500);
        const pending = invoke("ComputerAction", { ...target("native"), captureId: capture.capture_id, action: "type_text", text: requested, inputMethod: "unicode" }, cancelled.signal);
        await until(value => value.text.length >= 8);
        cancelled.abort();
        const interrupted = await pending;
        assert.equal(interrupted.error, true, "partially dispatched cancellation must stay unknown");
        assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
        let previous = await state();
        let quietSince = Date.now();
        const deadline = Date.now() + 2_000;
        while (Date.now() - quietSince < 300) {
          assert.ok(previous.text.length < requested.length, "cancellation must interrupt real typing before all characters are sent");
          assert.ok(Date.now() < deadline, "real key events continued after cancellation");
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          const current = await state();
          if (current.keyEventCount !== previous.keyEventCount) quietSince = Date.now();
          previous = current;
        }
        assert.ok(previous.text.length >= 8 && previous.text.length < requested.length);
        assert.equal(previous.text, requested.slice(0, previous.text.length), "cancelled input must leave a real prefix, without duplication or replay");
      }
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const unknown = events.filter(event => event.type === "tool_result" && event.executionStatus === "unknown");
      assert.equal(unknown.length, scenario === "cancellation" ? 1 : 0, "only genuinely interrupted partial input may become an unknown side effect");
      const final = await state();
      console.log("REAL_DESKTOP_RESULT " + JSON.stringify({ passed: true, scenario, calls: call, clicks: final.clicks, panelClicks: final.panelClicks, closedByInput: final.closedByInput, text: final.text, drags: final.drags, wheelEvents: final.wheelEvents, panelWheelEvents: final.panelWheelEvents, web: final.web, mouseMoveStates: final.mouseMoveStates }));
    }
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    for (const close of [() => mcp?.close(), () => recorder?.close(), () => capabilities?.close(), () => authority?.close(),
      () => service?.close(), () => browser?.dispose(), () => driver?.dispose()]) {
      try { await close(); } catch (error) { failed = true; console.error("owned desktop cleanup failed", error); }
    }
    app.exit(failed ? 1 : 0);
  }

}
void run();
