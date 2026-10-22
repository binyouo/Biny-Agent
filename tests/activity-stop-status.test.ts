/** Public lifecycle with in-memory input streams; no child process or native capabilities. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";

class InputChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: string[] = [];
  killed = false;
  tail: unknown[] = [];
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, callback) => {
    const command = JSON.parse(chunk.toString("utf8")) as { type: string };
    this.commands.push(command.type);
    if (command.type === "stop") {
      // Deterministic ordering: stop owns cleanup before old stdout/exit arrive.
      queueMicrotask(() => {
        for (const message of this.tail) this.receive(message);
        this.finish(0);
      });
    }
    callback();
  } });
  receive(message: unknown): void { this.stdout.write(JSON.stringify(message) + "\n"); }
  finish(code: number): void {
    this.emit("exit", code, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
  kill(): boolean { throw new Error("An in-memory child must never require termination"); }
}

const running = { type: "status", status: "running", screenRecordingGranted: false, accessibilityGranted: false };
function event(eventType: string, application: string) {
  return { type: "event", eventType, application, bundleId: "test.editor", occurredAt: "2026-10-01T10:00:00.000Z", inputEventCount: 1 };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-stop-status-"));
  const monitorPath = path.join(root, "inert-input-monitor");
  await writeFile(monitorPath, "This file is only an access-check target. It is never executed.");
  const timers = new Set<object>();
  const installTimer = () => { const timer = { unref() {} }; timers.add(timer); return timer; };
  const clearTimer = (timer: object) => { timers.delete(timer); };
  t.mock.method(globalThis, "setTimeout", installTimer);
  t.mock.method(globalThis, "setInterval", installTimer);
  t.mock.method(globalThis, "clearTimeout", clearTimer);
  t.mock.method(globalThis, "clearInterval", clearTimer);
  const child = new InputChild();
  const spawn = t.mock.method(childProcess, "spawn", (target: string) => {
    assert.equal(target, monitorPath);
    return child;
  });
  t.mock.method(childProcess, "execFile", () => { throw new Error("No native command permitted"); });
  syncBuiltinESMExports();
  const config = structuredClone(defaultConfig);
  config.providers = {};
  config.models = {};
  config.toolModel = undefined;
  config.activity = { ...config.activity, enabled: true, outputDirectory: path.join(root, "records") };
  const service = new ActivityRecorderService({
    agentDir: root, inputMonitorPath: monitorPath,
    configStore: { load: async () => structuredClone(config) } as AgentConfigStore
  });
  const resources: { database?: DatabaseSync } = {};
  t.after(async () => {
    try { await service.stop(); }
    finally {
      resources.database?.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
  await service.initialize();
  assert.equal(spawn.mock.callCount(), 1);
  const db = new DatabaseSync(path.join(root, "agent.sqlite"));
  resources.database = db;
  const rows = () => db.prepare("SELECT session_id, kind, app_name FROM activity_events ORDER BY rowid").all();
  child.receive(event("app_focus", "Initial"));
  await service.search("queue-barrier");
  return { service, child, timers, rows, db };
}

for (const status of ["running", "paused", "permission_required", "unavailable", "stopped"]) {
await test(`stop remains terminal when late ${status} status precedes final input and normal exit`, async t => {
  const { service, child, timers, rows, db } = await fixture(t);
  const oldSession = rows()[0]!.session_id;
  const signal = service.getOperationSignal();
  child.tail = [{ ...running, status, screenRecordingGranted: true, accessibilityGranted: true }, event("keypress", "Tail key"), event("click", "Tail click")];
  await service.stop();
  assert.equal(service.snapshot().state, "stopped");
  assert.equal(service.httpCaptureStatus().running, false);
  assert.equal(service.snapshot().screenRecordingGranted, false);
  assert.equal(service.snapshot().accessibilityGranted, false);
  assert.equal(signal.aborted, true);
  assert.equal(timers.size, 0);
  const tail = rows().filter(row => String(row.app_name).startsWith("Tail"));
  assert.deepEqual(tail.map(row => row.app_name), ["Tail key", "Tail click"]);
  assert.ok(tail.every(row => row.session_id === oldSession));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_sessions WHERE ended_at IS NULL").get()!.n, 0);
  assert.deepEqual(child.commands, ["start", "stop"]);
});
}

await test("stop preserves late lock status privacy gates", async t => {
  const { service, child, rows } = await fixture(t);
  child.tail = [{ ...running, screenLocked: true }, event("keypress", "Private tail")];
  await service.stop();
  assert.equal(service.snapshot().state, "stopped");
  assert.equal(rows().filter(row => row.app_name === "Private tail").length, 0);
});

await test("a genuine input error during stop remains visible without dropping final input", async t => {
  const { service, child, rows } = await fixture(t);
  const oldSession = rows()[0]!.session_id;
  child.tail = [{ type: "error", message: "fixture input failure" }, event("click", "Tail after error")];
  await service.stop();
  assert.equal(service.snapshot().state, "error");
  assert.equal(service.snapshot().error, "fixture input failure");
  assert.deepEqual(rows().filter(row => row.app_name === "Tail after error").map(row => row.session_id), [oldSession]);
});

await test("unexpected input process exit remains an error", async t => {
  const { service, child } = await fixture(t);
  child.receive(running);
  child.finish(7);
  assert.equal(service.snapshot().state, "error");
  assert.match(service.snapshot().error ?? "", /code=7/);
});
