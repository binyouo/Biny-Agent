import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Extract only start(), never import the product module or its native dependencies.
const source = readFileSync(new URL("../src/runtime/ManagedProcessService.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("ManagedProcessService.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ManagedProcessService");
assert.ok(declaration);
const method = declaration.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(parsed) === "start");
assert.ok(method?.body);
const extracted = `async function extractedStart(${method.parameters.map(node => node.getText(parsed)).join(", ")}) ${method.body.getText(parsed)}`;
const compiled = stripTypeScriptTypes(extracted, { mode: "strip" });

interface Snapshot {
  processId: string;
  pid: number;
  state: string;
  cleanup: { status: string };
}
interface FakeChild { pid: number; kill(): void; unref(): void }
interface RecordEntry { snapshot: Snapshot; child: FakeChild; stopRequested: boolean }
interface StartOptions { command: string; signal?: AbortSignal }
interface FakeService {
  closing: boolean;
  workspaceRoot: string;
  processRoot: string;
  records: Map<string, RecordEntry>;
  initialize(): Promise<void>;
  observeChild(record: RecordEntry): void;
  refreshRecord(record: RecordEntry): void;
  recordLifecycle(event: string, snapshot: Snapshot): Promise<void>;
  stop(id: string, reason: string): Promise<void>;
}
type ExtractedStart = (this: FakeService, options: StartOptions) => Promise<Snapshot>;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(gateAt?: "initialize" | "binding", cancelOnSpawn?: () => void) {
  const entered = deferred();
  const released = deferred();
  const events: string[] = [];
  const gate = async (name: "initialize" | "binding"): Promise<void> => {
    if (gateAt !== name) return;
    entered.resolve();
    await released.promise;
  };
  const child: FakeChild = { pid: 123, kill: () => { events.push("kill"); }, unref: () => { events.push("unref"); } };
  const service: FakeService = {
    closing: false, workspaceRoot: "/fake", processRoot: "/fake/processes", records: new Map(),
    initialize: async () => { events.push("initialize"); await gate("initialize"); },
    observeChild: () => { events.push("observe"); },
    refreshRecord: () => undefined,
    recordLifecycle: async (event) => { events.push(event); },
    stop: async (id) => {
      events.push("stop");
      const record = service.records.get(id);
      assert.ok(record);
      record.snapshot.state = "stopped";
      record.snapshot.cleanup.status = "stopped";
    }
  };
  // Every external name used by the extracted method is a local inert fake.
  const bindings = {
    randomUUID: () => "fake-id",
    validateReadinessProbe: () => undefined,
    resolveManagedCwd: async () => "/fake",
    realpath: async (value: string) => value,
    path: { join: (...parts: string[]) => parts.join("/") },
    constants: { O_CREAT: 1, O_EXCL: 2, O_WRONLY: 4, O_APPEND: 8, O_NOFOLLOW: 16 },
    open: async () => {
      events.push("open");
      return { fd: 17, writeFile: async () => { events.push("write"); }, close: async () => { events.push("close"); } };
    },
    bindManagedProcessLog: async () => { events.push("binding"); await gate("binding"); return { path: "/fake/log", device: 1n, inode: 2n }; },
    spawn: () => { events.push("spawn"); cancelOnSpawn?.(); return child; },
    process: { platform: "linux" },
    waitForSpawn: async (_child: FakeChild, signal?: AbortSignal) => { signal?.throwIfAborted(); },
    cloneSnapshot: (snapshot: Snapshot) => ({ ...snapshot, cleanup: { ...snapshot.cleanup } }),
    isRunningState: (state: string) => state === "running" || state === "starting",
    errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error)
  };
  const start = runInNewContext(`${compiled}\nextractedStart;`, bindings, {
    timeout: 1_000,
    contextCodeGeneration: { strings: false, wasm: false }
  }) as ExtractedStart;
  return { service, events, entered, released, start: (options: StartOptions) => start.call(service, options) };
}

for (const phase of ["initialize", "binding"] as const) {
  await test(`cancellation during ${phase} prevents spawn and closes the prepared handle`, { timeout: 2_000 }, async () => {
    const fake = harness(phase);
    const controller = new AbortController();
    const reason = new Error(`cancel at ${phase}`);
    const pending = fake.start({ command: "inert fake command", signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => error === reason);
    try {
      await fake.entered.promise;
      controller.abort(reason);
      fake.released.resolve();
      await rejected;
      assert.equal(fake.events.includes("spawn"), false);
      assert.equal(fake.service.records.size, 0);
      assert.equal(fake.events.filter(event => event === "close").length, 1);
    } finally { fake.released.resolve(); await pending.catch(() => undefined); }
  });
}

await test("initial cancellation does not prepare or spawn", { timeout: 2_000 }, async () => {
  const fake = harness();
  const controller = new AbortController();
  const reason = new Error("already cancelled");
  controller.abort(reason);
  await assert.rejects(fake.start({ command: "inert fake command", signal: controller.signal }), (error: unknown) => error === reason);
  assert.deepEqual(fake.events, []);
  assert.equal(fake.service.records.size, 0);
});

await test("normal start publishes ownership before closing the handle", { timeout: 2_000 }, async () => {
  const fake = harness();
  const result = await fake.start({ command: "inert fake command" });
  assert.equal(result.state, "running");
  assert.equal(fake.service.records.get(result.processId)?.snapshot.state, "running");
  assert.equal(fake.events.filter(event => event === "spawn").length, 1);
  assert.equal(fake.events.filter(event => event === "close").length, 1);
  assert.ok(fake.events.indexOf("observe") < fake.events.indexOf("close"));
  assert.equal(fake.events.includes("stop"), false);
});

await test("closing retains priority over cancellation after preparation", { timeout: 2_000 }, async () => {
  const fake = harness("binding");
  const controller = new AbortController();
  const pending = fake.start({ command: "inert fake command", signal: controller.signal });
  const rejected = assert.rejects(pending, /Managed process service is closing/u);
  try {
    await fake.entered.promise;
    fake.service.closing = true;
    controller.abort(new Error("cancelled too"));
    fake.released.resolve();
    await rejected;
    assert.equal(fake.events.includes("spawn"), false);
    assert.equal(fake.service.records.size, 0);
    assert.equal(fake.events.filter(event => event === "close").length, 1);
  } finally { fake.released.resolve(); await pending.catch(() => undefined); }
});

await test("post-spawn cancellation retains ownership and invokes stop", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  const reason = new Error("cancel after fake spawn");
  const fake = harness(undefined, () => controller.abort(reason));
  await assert.rejects(fake.start({ command: "inert fake command", signal: controller.signal }), (error: unknown) => error === reason);
  const record = fake.service.records.get("fake-id");
  assert.ok(record);
  assert.equal(record.snapshot.state, "stopped");
  assert.equal(fake.events.filter(event => event === "spawn").length, 1);
  assert.equal(fake.events.filter(event => event === "stop").length, 1);
  assert.equal(fake.events.filter(event => event === "close").length, 1);
});
