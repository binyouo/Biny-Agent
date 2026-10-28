import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { attachmentRoot, readAttachment, saveAttachment, savePendingAttachmentContext, updatePendingAttachmentContext } from "../src/attachments/store.js";

interface Config {
  appshots: { hotkey: string; target: "current" };
  activity: { sensitiveApplications: string[] };
}
interface Capture { bytes: Buffer; context: string; name: string; bundle: string; at: number; contextPending?: boolean; onContext?: (context: string) => void }
interface Appshots {
  pending: Map<string, Capture>;
  contexts: Map<string, Capture>;
  requests: Map<string, "current">;
  accept(id: string, raw: unknown): Promise<void>;
  receive(raw: unknown): Promise<void>;
  take(id: string): Promise<Capture>;
  close(): Promise<void>;
}
interface Store { load(): Promise<Config> }
interface Driver { onNativeEvent(): () => void; detach(): void }
interface AppshotsConstructor {
  new(driver: Driver, store: Store, emit: (event: unknown) => void): Appshots;
}
interface Service { close(): Promise<void> }
interface Project { id: string }
interface Attachment { name: string; path: string; mimeType: string; size: number }
interface Projects {
  requireProject(id: string): Project;
  saveAttachment(project: Project, name: string, mimeType: string, bytes: Buffer, context: string, pending?: boolean): Promise<Attachment>;
  updateAppshotAttachmentContext(project: Project, path: string, context: string): Promise<boolean>;
}
interface WindowFixture { webContents: { mainFrame: object } }
interface ServiceModule {
  createAppshotsService(store: Store, projects: Projects, getWindow: () => WindowFixture): Promise<Service>;
}
type Handler = (event: object, projectId: string, id: string) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const root = process.cwd();
function compile(relativePath: string): string {
  const result = ts.transpileModule(readFileSync(path.join(root, relativePath), "utf8"), {
    fileName: relativePath, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return result.outputText;
}

// Execute the complete production modules, with only reviewed, inert imports.
// The prepared pending entries are synthetic accepted captures. No capture,
// native process, filesystem attachment, or real Electron operation can run.
const appshotsCode = compile("src/computer/appshots.ts");
const serviceCode = compile("src/desktop/electron/main/appshotsService.ts");
const protocolCode = compile("src/computer/appshotsProtocol.ts");
function load<T>(code: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const module = { exports: {} };
  return runInNewContext(`${code}\nmodule.exports;`, {
    module, exports: module.exports, ...globals,
    require: (specifier: string) => {
      assert.ok(Object.hasOwn(dependencies, specifier), `unreviewed dependency: ${specifier}`);
      return dependencies[specifier];
    }
  }, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } }) as T;
}
const protocol = load<{ appshotsIpc: { attach: string } }>(protocolCode, { zod: { z } });
const forbidden = () => assert.fail("native capture, filesystem, and configuration writes are outside this fixture");
const firstId = "12345678-1234-4234-8234-123456789abc";
const secondId = "12345678-1234-4234-8234-123456789abd";
const allowed = (): Config => ({ appshots: { hotkey: "", target: "current" }, activity: { sensitiveApplications: [] } });

async function fixture(save?: Projects["saveAttachment"], options: { captureBytes?: Buffer; now?: () => number; animate?: (signal: AbortSignal) => Promise<boolean>; update?: (path: string, context: string) => Promise<boolean> } = {}) {
  const instances: Appshots[] = [];
  let read: () => Promise<Config> = async () => allowed();
  const store: Store = { load: () => read() };
  const handlers = new Map<string, Handler>();
  const emitted: unknown[] = [];
  const feedback: Array<{ frame: unknown; pixels: string }> = [];
  const window = {
    webContents: { mainFrame: {}, send: (_channel: string, event: unknown) => emitted.push(event) },
    isDestroyed: () => false, isMinimized: () => false,
    show: () => undefined, focus: () => undefined
  };
  const saves: Array<{ bytes: Buffer; context: string }> = [];
  let detaches = 0;
  let fileCloses = 0; let fileUnlinks = 0;
  const { Appshots: ProductionAppshots } = load<{ Appshots: AppshotsConstructor }>(appshotsCode, {
    "node:crypto": { randomUUID: forbidden },
    "node:fs": { constants: {} },
    "node:fs/promises": options.captureBytes ? {
      open: async () => ({
        stat: async () => ({ isFile: () => true, size: options.captureBytes!.length }),
        readFile: async () => options.captureBytes,
        close: async () => { fileCloses++; }
      }),
      unlink: async () => { fileUnlinks++; }
    } : { open: forbidden, unlink: forbidden },
    zod: { z },
    "../config/store.js": { updateConfig: forbidden },
    "./appshotsProtocol.js": protocol
  }, options.now ? { Date: { now: options.now } } : {});
  const serviceModule = load<ServiceModule>(serviceCode, {
    electron: { ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel)
    } },
    zod: { z },
    "../../../computer/appshots.js": { Appshots: class extends ProductionAppshots {
      constructor(...args: ConstructorParameters<AppshotsConstructor>) { super(...args); instances.push(this); }
    } },
    "../../../computer/appshotsProtocol.js": protocol,
    "./AppshotFeedback.js": { AppshotFeedback: class { sound() {} async animate(_window: unknown, frame: unknown, bytes: Buffer, _icon: unknown, signal: AbortSignal) { feedback.push({ frame, pixels: bytes.toString() }); return options.animate ? await options.animate(signal) : false; } close() {} } },
    "../../../computer/nativeDriver.js": { NativeProcessDriver: class implements Driver {
      onNativeEvent() { return () => undefined; }
      detach() { detaches++; }
      daemonCommand = forbidden;
    } }
  }, { AbortController, setTimeout, clearTimeout });
  const service = await serviceModule.createAppshotsService(store, {
    requireProject: id => ({ id }),
    saveAttachment: async (project, name, mimeType, bytes, context, pending) => {
      saves.push({ bytes, context });
      return save ? await save(project, name, mimeType, bytes, context, pending) : { name, path: "in-memory", mimeType, size: bytes.length };
    },
    updateAppshotAttachmentContext: async (_project: Project, attachmentPath: string, context: string) => {
      assert.ok(options.update); return await options.update(attachmentPath, context);
    }
  }, () => window);
  const appshots = instances[0]; assert.ok(appshots);
  const handler = handlers.get(protocol.appshotsIpc.attach); assert.ok(handler);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return {
    appshots, service, saves, emitted, feedback,
    attach: (id: string) => handler(event, "fixture-project", id),
    setRead: (next: () => Promise<Config>) => { read = next; },
    detaches: () => detaches,
    fileCleanup: () => ({ closes: fileCloses, unlinks: fileUnlinks }),
    seed: (id: string, text = "private pixels") => {
      const capture = { bytes: Buffer.from(text), context: "synthetic private context", name: "Notes.jpg", bundle: "test.notes", at: options.now?.() ?? Date.now() };
      appshots.pending.set(id, capture); return capture;
    }
  };
}

test("deferred window text survives attachment saving and freezes on first model read", { timeout: 15_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-deferred-appshot-"));
  const saved = deferred<void>(), release = deferred<void>();
  const root = attachmentRoot(workspace);
  const f = await fixture(async (_project, name, mimeType, bytes, context, pending) => {
    assert.equal(pending, true);
    const attachment = await saveAttachment(workspace, name, mimeType, bytes);
    await savePendingAttachmentContext(root, attachment.path, context);
    saved.resolve(); await release.promise;
    return { ...attachment, size: attachment.size ?? bytes.length };
  }, { update: async (attachmentPath, context) => await updatePendingAttachmentContext(root, attachmentPath, context) });
  const capture = f.seed(firstId);
  capture.context = JSON.stringify({ source: { appName: "Notes" }, accessibility: "", accessibilityError: "accessibility_pending" });
  capture.contextPending = true; f.appshots.contexts.set(firstId, capture);
  try {
    const attached = f.attach(firstId) as Promise<Attachment>;
    await saved.promise;
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "window text" } });
    release.resolve(); const attachment = await attached;
    const first = await readAttachment(workspace, attachment);
    assert.equal(JSON.parse(first!.hiddenContext!).accessibility, "window text");
    assert.equal(await updatePendingAttachmentContext(root, attachment.path, "unexpected late update"), false);
    assert.equal((await readAttachment(workspace, attachment))?.hiddenContext, first?.hiddenContext);
    assert.equal(JSON.stringify(f.emitted).includes("window text"), false);
  } finally { release.resolve(); await f.service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("window text arriving after first use cannot change the message on replay", { timeout: 15_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-deferred-appshot-"));
  const root = attachmentRoot(workspace), updated = deferred<boolean>();
  const f = await fixture(async (_project, name, mimeType, bytes, context, pending) => {
    assert.equal(pending, true);
    const attachment = await saveAttachment(workspace, name, mimeType, bytes);
    await savePendingAttachmentContext(root, attachment.path, context);
    return { ...attachment, size: attachment.size ?? bytes.length };
  }, { update: async (attachmentPath, context) => {
    const result = await updatePendingAttachmentContext(root, attachmentPath, context); updated.resolve(result); return result;
  } });
  const capture = f.seed(firstId);
  capture.context = JSON.stringify({ source: { appName: "Notes" }, accessibility: "", accessibilityError: "accessibility_pending" });
  capture.contextPending = true; f.appshots.contexts.set(firstId, capture);
  try {
    const attachment = await f.attach(firstId) as Attachment;
    const first = await readAttachment(workspace, attachment);
    assert.equal(JSON.parse(first!.hiddenContext!).accessibilityError, "accessibility_pending");
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "too late" } });
    assert.equal(await updated.promise, false);
    assert.equal((await readAttachment(workspace, attachment))?.hiddenContext, first?.hiddenContext);
  } finally { await f.service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("window text arriving after attachment but before first use is included in the message", { timeout: 15_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-deferred-appshot-"));
  const root = attachmentRoot(workspace), updated = deferred<boolean>();
  const f = await fixture(async (_project, name, mimeType, bytes, context, pending) => {
    assert.equal(pending, true);
    const attachment = await saveAttachment(workspace, name, mimeType, bytes);
    await savePendingAttachmentContext(root, attachment.path, context);
    return { ...attachment, size: attachment.size ?? bytes.length };
  }, { update: async (attachmentPath, context) => {
    const result = await updatePendingAttachmentContext(root, attachmentPath, context); updated.resolve(result); return result;
  } });
  const capture = f.seed(firstId);
  capture.context = JSON.stringify({ source: { appName: "Notes" }, accessibility: "", accessibilityError: "accessibility_pending" });
  capture.contextPending = true; f.appshots.contexts.set(firstId, capture);
  try {
    const attachment = await f.attach(firstId) as Attachment;
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "completed text", axError: "accessibility_tree_incomplete" } });
    assert.equal(await updated.promise, true);
    const first = await readAttachment(workspace, attachment);
    assert.equal(JSON.parse(first!.hiddenContext!).accessibility, "completed text");
    assert.equal(JSON.parse(first!.hiddenContext!).accessibilityError, "accessibility_tree_incomplete");
    assert.equal((await readAttachment(workspace, attachment))?.hiddenContext, first?.hiddenContext);
  } finally { await f.service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("a newly excluded application cannot contribute deferred context", async () => {
  const f = await fixture();
  const capture = f.seed(firstId);
  capture.context = JSON.stringify({ source: { appName: "Notes" }, accessibility: "", accessibilityError: "accessibility_pending" });
  capture.contextPending = true; f.appshots.contexts.set(firstId, capture);
  let called = false; capture.onContext = () => { called = true; };
  f.setRead(async () => ({ ...allowed(), activity: { sensitiveApplications: [capture.bundle] } }));
  try {
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "excluded text" } });
    assert.equal(called, false);
    assert.equal(JSON.parse(capture.context).accessibilityError, "accessibility_pending");
    assert.equal(JSON.stringify(f.emitted).includes("excluded text"), false);
  } finally { await f.service.close(); }
});

test("a context event that precedes image acceptance remains paired with its capture", async () => {
  const f = await fixture(undefined, { captureBytes: Buffer.from("pixels") });
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "early text" } });
    await f.appshots.receive({ type: "context", id: secondId, data: { axText: "unrelated text" } });
    await f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, axPending: true });
    const capture = await f.appshots.take(firstId);
    assert.equal(JSON.parse(capture.context).accessibility, "early text");
    assert.equal(capture.contextPending, false);
    assert.equal(JSON.stringify(f.emitted).includes("early text"), false);
    capture.bytes.fill(0);
  } finally { await f.service.close(); }
});

test("closing while an early context is checked cannot publish a captured event", async () => {
  const bytes = Buffer.from("pixels"), f = await fixture(undefined, { captureBytes: bytes });
  const privacy = deferred<Config>(), entered = deferred<void>();
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.receive({ type: "context", id: firstId, data: { axText: "early text" } });
    let reads = 0;
    f.setRead(async () => { if (++reads === 1) return allowed(); entered.resolve(); return await privacy.promise; });
    const accepting = f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, axPending: true });
    await entered.promise; await f.service.close(); privacy.resolve(allowed()); await accepting;
    assert.equal(f.emitted.length, 0);
    assert.ok(bytes.every(byte => byte === 0));
  } finally { privacy.resolve(allowed()); bytes.fill(0); }
});

test("a capture transfers to only one concurrent take after deferred privacy reads", async () => {
  const f = await fixture(); const capture = f.seed(firstId);
  const reads = [deferred<Config>(), deferred<Config>()]; let index = 0;
  f.setRead(() => reads[index++]!.promise);
  const outcomes = Promise.allSettled([f.appshots.take(firstId), f.appshots.take(firstId)]);
  reads[0]!.resolve(allowed()); reads[1]!.resolve(allowed());
  const results = await outcomes;
  try {
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "one capture must have one owner");
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "rejected");
    assert.equal(capture.bytes.toString(), "private pixels", "losing take must not zero the winner's bytes");
    await assert.rejects(f.appshots.take(firstId), /appshot_capture_expired/);
  } finally { capture.bytes.fill(0); await f.service.close(); }
});

test("concurrent attach saves once, rather than zeroing another save's shared buffer", async () => {
  const saves = [deferred<void>(), deferred<void>()]; let saveIndex = 0;
  const firstSaveStarted = deferred<void>();
  const f = await fixture(async (_project, name, mimeType, bytes) => {
    const index = saveIndex++; firstSaveStarted.resolve();
    await saves[index]!.promise;
    return { name, path: "in-memory", mimeType, size: bytes.length };
  });
  f.seed(firstId);
  const privacy = deferred<Config>(); f.setRead(() => privacy.promise);
  const first = f.attach(firstId); const second = f.attach(firstId);
  const outcomes = Promise.allSettled([first, second]);
  privacy.resolve(allowed()); await firstSaveStarted.promise;
  // Drain both attachment continuations without relying on clock timing.
  await new Promise<void>(resolve => setImmediate(resolve));
  saves[0]!.resolve(); await first;
  const secondBufferAfterFirstFinished = f.saves[1]?.bytes.toString("hex");
  saves[1]!.resolve(); const results = await outcomes;
  try {
    assert.equal(f.saves.length, 1, `duplicate save received already-zeroed buffer: ${secondBufferAfterFirstFinished}`);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(f.saves[0]!.bytes.every(byte => byte === 0), "the sole attachment owner must still wipe its buffer");
  } finally { await f.service.close(); }
});

test("distinct captures remain independent while their privacy reads and saves overlap", async () => {
  const releases = [deferred<void>(), deferred<void>()]; let saveIndex = 0;
  const started = deferred<void>();
  const f = await fixture(async (_project, name, mimeType, bytes) => {
    const index = saveIndex++; if (saveIndex === 2) started.resolve();
    await releases[index]!.promise;
    return { name, path: "in-memory", mimeType, size: bytes.length };
  });
  const capture1 = f.seed(firstId, "first pixels"); const capture2 = f.seed(secondId, "second pixels");
  const privacy = deferred<Config>(); f.setRead(() => privacy.promise);
  const first = f.attach(firstId); const second = f.attach(secondId);
  privacy.resolve(allowed()); await started.promise;
  releases[0]!.resolve(); await first;
  const secondText = capture2.bytes.toString();
  releases[1]!.resolve(); await second;
  try {
    assert.equal(f.saves.length, 2); assert.notEqual(capture1.bytes, capture2.bytes);
    assert.equal(secondText, "second pixels", "finishing one capture must not wipe the other");
    assert.ok(capture1.bytes.every(byte => byte === 0)); assert.ok(capture2.bytes.every(byte => byte === 0));
  } finally { await f.service.close(); }
});

test("close during a privacy read prevents a late attachment save", async () => {
  const f = await fixture(); const capture = f.seed(firstId);
  const privacy = deferred<Config>(); f.setRead(() => privacy.promise);
  const outcome = Promise.allSettled([f.attach(firstId)]);
  await f.service.close(); privacy.resolve(allowed());
  const [result] = await outcome;
  assert.equal(f.detaches(), 1); assert.ok(capture.bytes.every(byte => byte === 0));
  assert.equal(f.saves.length, 0, "closed service must not persist a wiped capture or its private context");
  assert.equal(result?.status, "rejected");
});

test("failed privacy reads remain retryable and never save without a successful check", async () => {
  const f = await fixture(); const capture = f.seed(firstId);
  const privacy = deferred<Config>(); f.setRead(() => privacy.promise);
  const failure = new Error("privacy configuration read failed");
  const rejected = assert.rejects(f.attach(firstId), error => error === failure);
  privacy.reject(failure); await rejected;
  try {
    assert.equal(f.saves.length, 0); assert.equal(capture.bytes.toString(), "private pixels");
    f.setRead(async () => allowed()); await f.attach(firstId);
    assert.equal(f.saves.length, 1);
    await assert.rejects(f.attach(firstId), /appshot_capture_expired/);
  } finally { await f.service.close(); }
});

test("privacy exclusion wipes the pending capture and does not make it retryable", async () => {
  const f = await fixture(); const capture = f.seed(firstId);
  f.setRead(async () => ({ ...allowed(), activity: { sensitiveApplications: [capture.bundle] } }));
  try {
    await assert.rejects(f.attach(firstId), /appshot_application_excluded/);
    assert.ok(capture.bytes.every(byte => byte === 0)); assert.equal(f.saves.length, 0);
    f.setRead(async () => allowed());
    await assert.rejects(f.attach(firstId), /appshot_capture_expired/);
  } finally { await f.service.close(); }
});

test("a late excluded take cannot wipe bytes already owned by a permitted take", async () => {
  const f = await fixture(); const capture = f.seed(firstId);
  const reads = [deferred<Config>(), deferred<Config>()]; let index = 0;
  f.setRead(() => reads[index++]!.promise);
  const first = f.appshots.take(firstId); const second = f.appshots.take(firstId);
  const outcomes = Promise.allSettled([first, second]);
  reads[0]!.resolve(allowed()); await first;
  reads[1]!.resolve({ ...allowed(), activity: { sensitiveApplications: [capture.bundle] } });
  const results = await outcomes;
  try {
    assert.equal(results[1]!.status, "rejected");
    assert.equal(capture.bytes.toString(), "private pixels", "loser no longer owns the buffer and must not wipe it");
  } finally { capture.bytes.fill(0); await f.service.close(); }
});

test("capture expiration during a privacy read prevents late attachment ownership", async () => {
  let now = 1_000_000;
  const f = await fixture(undefined, { now: () => now }); const capture = f.seed(firstId);
  const privacy = deferred<Config>(); f.setRead(() => privacy.promise);
  const outcome = Promise.allSettled([f.attach(firstId)]);
  now += 300_001; privacy.resolve(allowed());
  const [result] = await outcome;
  try {
    assert.equal(f.saves.length, 0, "an expired capture cannot be handed to attachment storage");
    assert.equal(result?.status, "rejected"); assert.ok(capture.bytes.every(byte => byte === 0));
    await assert.rejects(f.appshots.take(firstId), /appshot_capture_expired/);
  } finally { await f.service.close(); }
});

test("close during accept's privacy read discards the image without publishing a late capture", async () => {
  const bytes = Buffer.from("synthetic captured pixels");
  const f = await fixture(undefined, { captureBytes: bytes });
  const privacy = deferred<Config>(); const reading = deferred<void>();
  f.setRead(() => { reading.resolve(); return privacy.promise; });
  f.appshots.requests.set(firstId, "current");
  const accepting = f.appshots.accept(firstId, {
    path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42
  });
  await reading.promise; await f.service.close(); privacy.resolve(allowed()); await accepting;
  try {
    assert.deepEqual(f.fileCleanup(), { closes: 1, unlinks: 1 });
    assert.equal(f.appshots.pending.size, 0, "close must not be followed by a newly retained capture");
    assert.equal(f.emitted.length, 0, "no captured event may be published after close");
    assert.equal(f.feedback.length, 0, "closed captures must not reach animation feedback");
    assert.ok(bytes.every(byte => byte === 0), "unclaimed private pixels must be wiped");
  } finally { bytes.fill(0); }
});

test("an accepted capture sends its image to feedback without adding pixels to the renderer event", async () => {
  const bytes = Buffer.from("synthetic captured pixels");
  const f = await fixture(undefined, { captureBytes: bytes });
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, frame: { x: 10, y: 20, w: 300, h: 200 } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.feedback.length, 1);
    assert.equal(f.feedback[0]?.pixels, "synthetic captured pixels");
    assert.equal(JSON.stringify(f.feedback[0]?.frame), JSON.stringify({ x: 10, y: 20, w: 300, h: 200 }));
    assert.equal(JSON.stringify(f.emitted).includes("synthetic captured pixels"), false);
    assert.equal(f.saves.length, 0, "feedback must not consume or save the pending attachment");
  } finally { await f.service.close(); bytes.fill(0); }
});

test("the attachment event arrives during the final phase of the animation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = Buffer.from("pixels"), started = deferred<boolean>();
  const f = await fixture(undefined, { captureBytes: bytes, animate: async () => await started.promise });
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, frame: { x: 10, y: 20, w: 300, h: 200 } });
    assert.equal(f.emitted.length, 0);
    started.resolve(true); await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(714); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.emitted.length, 0);
    t.mock.timers.tick(1); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.emitted.length, 1);
    assert.equal((f.emitted[0] as { type: string }).type, "captured");
  } finally { started.resolve(false); await f.service.close(); bytes.fill(0); t.mock.timers.reset(); }
});

test("a stalled animation is cancelled and cannot prevent or duplicate attachment delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = Buffer.from("pixels"), started = deferred<boolean>();
  let signal: AbortSignal | undefined;
  const f = await fixture(undefined, { captureBytes: bytes, animate: async value => { signal = value; return await started.promise; } });
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, frame: { x: 10, y: 20, w: 300, h: 200 } });
    t.mock.timers.tick(700); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    assert.equal(f.emitted.length, 1);
    started.resolve(true); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.emitted.length, 1);
  } finally { started.resolve(false); await f.service.close(); bytes.fill(0); t.mock.timers.reset(); }
});

test("closing during the animation cancels delayed attachment delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bytes = Buffer.from("pixels"), started = deferred<boolean>();
  let signal: AbortSignal | undefined, closed = false;
  const f = await fixture(undefined, { captureBytes: bytes, animate: async value => { signal = value; return await started.promise; } });
  try {
    f.appshots.requests.set(firstId, "current");
    await f.appshots.accept(firstId, { path: "/in-memory/capture.jpg", bundleId: "test.notes", appName: "Notes", pid: 12, windowId: 42, frame: { x: 10, y: 20, w: 300, h: 200 } });
    started.resolve(true); await new Promise<void>(resolve => setImmediate(resolve));
    await f.service.close(); closed = true;
    t.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    assert.equal(f.emitted.length, 0);
    assert.ok(bytes.every(byte => byte === 0));
  } finally { started.resolve(false); if (!closed) await f.service.close(); bytes.fill(0); t.mock.timers.reset(); }
});
