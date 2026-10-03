import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService, activityBrowserScript } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
};
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("input fixture did not reach its observable state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(run: (context: {
  service: ActivityRecorderService; database: DatabaseSync; tick(): void;
  focus(application: string, bundleId: string): Promise<void>;
  reportStatus(application: string): Promise<void>;
  setReader(reader: () => Promise<string>): void; blockConfig(): () => void;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-lifecycle-"));
  const input = path.join(root, "input");
  const inbox = path.join(root, "inbox");
  await writeFile(inbox, "{}");
  await writeFile(input, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {watch,readFileSync} from 'node:fs';
watch(${JSON.stringify(root)},(_,name)=>{if(name==='inbox')try{console.log(readFileSync(${JSON.stringify(inbox)},'utf8'));}catch{}});
createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.type==='stop')process.exit(0);if(c.type==='start')console.log(JSON.stringify({type:'event',eventType:'app_focus',occurredAt:new Date().toISOString(),application:'Browser',bundleId:'com.google.Chrome'}));});
`, { mode: 0o700 });
  const config = { ...defaultConfig, activity: { ...defaultConfig.activity, enabled: true, outputDirectory: path.join(root, "records") } };
  const callbacks = new Map<number, () => void>();
  let reader = async (): Promise<string> => "https://example.test/page\tTitle";
  let configGate: Promise<void> | undefined;
  const service = new ActivityRecorderService({ agentDir: root, inputMonitorPath: input,
    configStore: { load: async () => { await configGate; return config; } } as AgentConfigStore,
    readBrowser: async () => await reader(),
    captureTimers: { setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval, clearInterval: () => {} }
  });
  let database: DatabaseSync | undefined;
  let unblock: (() => void) | undefined;
  const publish = async (message: unknown): Promise<void> => {
    const pending = path.join(root, "inbox.pending");
    await writeFile(pending, JSON.stringify(message));
    await rename(pending, inbox);
  };
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await until(() => Boolean(database!.prepare("SELECT id FROM activity_events LIMIT 1").get()));
    await run({ service, database, tick: () => callbacks.get(config.activity.browserPollIntervalMs)!(),
      focus: async (application, bundleId) => { await publish({ type: "event", eventType: "app_focus", occurredAt: new Date().toISOString(), application, bundleId }); await until(() => service.httpCaptureStatus().frontmost.bundleId === bundleId); },
      reportStatus: async application => { await publish({ type: "status", status: "running", currentApplication: application, screenRecordingGranted: false, accessibilityGranted: true }); await until(() => service.snapshot().accessibilityGranted); },
      setReader: next => { reader = next; },
      blockConfig: () => { configGate = new Promise(resolve => { unblock = resolve; }); return () => { unblock?.(); configGate = undefined; }; }
    });
  } finally {
    unblock?.();
    await service.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("browser scripts target the stable application identifier", () => {
  for (const bundle of ["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser"])
    assert.ok(activityBrowserScript(bundle)?.includes(`tell application id "${bundle}"`));
});

test("foreground name and identifier change together while persistence is queued", async () => {
  await fixture(async ({ service, focus, blockConfig }) => {
    const release = blockConfig();
    const refreshing = service.refresh();
    await settle();
    try {
      await focus("Editor", "org.example.editor");
      assert.deepEqual(service.httpCaptureStatus().frontmost, { bundleId: "org.example.editor", appName: "Editor" });
    } finally { release(); await refreshing; }
  });
});

test("a status-only application name cannot overwrite an identified foreground app", async () => {
  await fixture(async ({ service, reportStatus }) => {
    await reportStatus("Unrelated App");
    assert.deepEqual(service.httpCaptureStatus().frontmost, { bundleId: "com.google.Chrome", appName: "Browser" });
  });
});

test("only one browser read is in flight and its result reaches SQLite once", async () => {
  await fixture(async ({ tick, setReader, database }) => {
    let calls = 0;
    let resolve!: (value: string) => void;
    setReader(async () => { calls++; return await new Promise<string>(done => { resolve = done; }); });
    tick(); tick(); await settle();
    assert.equal(calls, 1);
    resolve("https://example.test/page\tTitle");
    await until(() => Number(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='browser_visit'").get()!.n) === 1);
    tick(); await settle(); assert.equal(calls, 2);
    resolve("https://example.test/page\tTitle"); await settle();
  });
});

for (const [label, failure, attempts] of [
  ["permission denial", new Error("Not authorized (-1743)"), 1],
  ["process timeout", Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }), 1],
  ["consecutive failures", new Error("unavailable"), 3]
] as const) test(`${label} disables only that browser until recording restarts`, async () => {
  await fixture(async ({ service, tick, focus, setReader }) => {
    let calls = 0;
    setReader(async () => { calls++; throw failure; });
    for (let i = 0; i < attempts + 2; i++) { tick(); await settle(); }
    assert.equal(calls, attempts);
    await focus("Other Browser", "com.apple.Safari");
    tick(); await settle(); assert.equal(calls, attempts + 1);
    await service.stopRuntime(); await service.startRuntime();
    await until(() => service.httpCaptureStatus().frontmost.bundleId === "com.google.Chrome");
    tick(); await settle(); assert.equal(calls, attempts + 2);
  });
});

test("successful browser reads reset the consecutive failure count", async () => {
  await fixture(async ({ tick, setReader, database }) => {
    let calls = 0;
    setReader(async () => { calls++; if (calls % 3 !== 0) throw new Error("unavailable"); return `https://example.test/${calls}\tTitle`; });
    for (let i = 0; i < 6; i++) { tick(); await settle(); }
    assert.equal(calls, 6);
    await until(() => Number(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='browser_visit'").get()!.n) === 2);
  });
});

test("late browser responses cannot write or unlock a request from a restarted recorder", async () => {
  await fixture(async ({ service, tick, setReader, database }) => {
    const responses: Array<(value: string) => void> = [];
    setReader(async () => await new Promise<string>(resolve => { responses.push(resolve); }));
    tick(); await settle(); assert.equal(responses.length, 1);
    await service.stopRuntime();
    tick(); await settle(); assert.equal(responses.length, 1, "a stale timer must not start a stopped browser read");
    await service.startRuntime();
    await until(() => Number(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='app_focus'").get()!.n) >= 2);
    tick(); await settle(); assert.equal(responses.length, 2);
    responses[0]!("https://example.test/old\tOld"); await settle();
    tick(); await settle(); assert.equal(responses.length, 2, "old completion must leave the new request in flight");
    responses[1]!("https://example.test/new\tNew");
    await until(() => Number(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='browser_visit'").get()!.n) === 1);
    const row = database.prepare("SELECT data FROM activity_events WHERE kind='browser_visit'").get()!;
    assert.equal(JSON.parse(String(row.data)).url, "https://example.test/new");
  });
});
