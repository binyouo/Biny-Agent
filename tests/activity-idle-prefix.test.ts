/** idle 恢复后的点击归属不能被之后的首次应用切换追溯覆盖。全部输入均为合成数据。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfigStore } from "../src/config/store.js";
import type { ActivityEventInput } from "../src/activity/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-idle-prefix-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const realNow = Date.now;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network access in activity fixture"); };

try {
  const { ActivityRecorderService } = await import("../src/desktop/electron/main/ActivityRecorderService.js");
  const { ActivityStore } = await import("../src/activity/store.js");
  const { buildActivitySummary } = await import("../src/activity/summary.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { defaultActivitySettings } = await import("../src/activity/settings.js");

  await test("same monitor resumes with click A, then focus B preserves the prefix", async () => {
    const directory = path.join(root, "recorder");
    await mkdir(directory);
    const inputMonitorPath = path.join(directory, "activity-input-monitor");
    const inbox = path.join(directory, "inbox.json");
    const starts = path.join(directory, "starts.txt");
    const initial = new Date(2026, 8, 26, 9).getTime();
    let now = initial;
    Date.now = () => now;
    await writeFile(inputMonitorPath, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let timer;
let sequence = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'stop') { clearInterval(timer); process.exit(0); }
  if (command.type !== 'start') return;
  appendFileSync(${JSON.stringify(starts)}, 'start\\n');
  console.log(JSON.stringify({ type: 'status', status: 'running', screenRecordingGranted: false, accessibilityGranted: true }));
  console.log(JSON.stringify({ type: 'event', eventType: 'app_focus', occurredAt: ${JSON.stringify(new Date(initial).toISOString())}, application: 'Editor A', bundleId: 'test.editor.a' }));
  timer = setInterval(() => {
    try {
      const request = JSON.parse(readFileSync(${JSON.stringify(inbox)}, 'utf8'));
      if (request.sequence <= sequence) return;
      sequence = request.sequence;
      console.log(JSON.stringify(request.event));
    } catch { /* The parent has not published the next synthetic input yet. */ }
  }, 5);
});
`, { mode: 0o700 });
    const idleCallbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const settings = { ...defaultActivitySettings, enabled: true, outputDirectory: directory,
      idleTimeoutMs: 30_000, browserPollIntervalMs: 0, ocrEnabled: false };
    const service = new ActivityRecorderService({
      agentDir: directory,
      inputMonitorPath,
      now: () => now,
      configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
      captureTimers: {
        setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
        clearInterval: () => undefined
      },
      sessionIdleTimers: {
        setTimeout: ((callback: () => void) => { const id = ++nextTimer; idleCallbacks.set(id, callback); return id; }) as unknown as typeof setTimeout,
        clearTimeout: ((id: number) => { idleCallbacks.delete(id); }) as unknown as typeof clearTimeout
      }
    });
    const store = new ActivityStore();
    const until = async (predicate: () => boolean): Promise<void> => {
      const deadline = realNow() + 5_000;
      while (!predicate()) {
        if (realNow() > deadline) assert.fail("Synthetic input did not settle");
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
    };
    const closeIdle = async (): Promise<void> => {
      const callback = idleCallbacks.get(nextTimer);
      assert.ok(callback);
      idleCallbacks.delete(nextTimer);
      callback();
      await service.search("fixture-queue-drain");
    };
    let sequence = 0;
    const publish = async (eventType: string, application: string, bundleId: string): Promise<void> => {
      const occurredAt = new Date(now).toISOString();
      await writeFile(inbox, JSON.stringify({ sequence: ++sequence,
        event: { type: "event", eventType, occurredAt, application, bundleId } }));
      await until(() => store.snapshot().recentSessions.some(session =>
        store.getSessionDetail(session.id)?.events.some(event => event.eventType === eventType && event.occurredAt === occurredAt) === true));
      await service.search("fixture-input-drain");
    };
    try {
      await service.initialize();
      await store.open(directory, directory);
      await until(() => store.snapshot().events === 1);
      await service.search("fixture-start-drain");
      const firstId = service.snapshot().currentSessionId;
      assert.ok(firstId);
      now += 30_000;
      await closeIdle();
      assert.equal(service.snapshot().currentSessionId, undefined);
      const firstEnded = now;
      now += 600_000;
      const resumedAt = now;
      await publish("click", "Editor A", "test.editor.a");
      const resumedId = service.snapshot().currentSessionId;
      assert.ok(resumedId);
      assert.notEqual(resumedId, firstId);
      now += 10_000;
      await publish("app_focus", "Browser B", "test.browser.b");
      now += 30_000;
      await closeIdle();
      assert.equal(service.snapshot().currentSessionId, undefined);
      assert.equal(await readFile(starts, "utf8"), "start\n", "idle did not restart the sidecar");
      assert.equal(service.snapshot().screenRecordingGranted, false);
      assert.equal(service.snapshot().accessibilityGranted, true);
      assert.equal(service.snapshot().fallbackCaptures, 0);
      assert.ok(resumedAt - firstEnded > 300_000, "sessions cannot be merged across the default five-minute gap");
      const detail = store.getSessionDetail(resumedId);
      assert.ok(detail);
      assert.equal(detail.startedAt, new Date(resumedAt).toISOString());
      assert.equal(detail.endedAt, new Date(resumedAt + 40_000).toISOString());
      assert.deepEqual(detail.events.map(event => event.occurredAt), [new Date(resumedAt).toISOString(), new Date(resumedAt + 10_000).toISOString()]);
      assert.deepEqual(detail.events.map(event => [event.eventType, event.application]), [["click", "Editor A"], ["app_focus", "Browser B"]]);
      const summary = buildActivitySummary(store, "daily", "2026-09-26", new Date(now));
      assert.equal(summary.stats.sessionCount, 2);
      assert.equal(summary.stats.totalActiveMs, 70_000);
      assert.deepEqual(summary.stats.apps, [{ app: "Editor A", durationMs: 40_000 }, { app: "Browser B", durationMs: 30_000 }]);
    } finally {
      try { await service.stop(); }
      finally {
        // stop 支持再次 initialize，故不关闭宿主连接；fixture 退出时单独释放它。
        try { await (service as unknown as { store: { close(): Promise<void> } }).store.close(); }
        finally {
          try { await store.close(); }
          finally { Date.now = realNow; }
        }
      }
    }
  });

  type Input = { offset: number; kind: string; app?: string; fallbackReason?: string };
  const check = async (name: string, events: Input[], expected: Array<{ app: string; durationMs: number }>, start = new Date(2026, 8, 26, 9)): Promise<void> => {
    await test(name, async () => {
      const directory = await mkdtemp(path.join(root, "source-"));
      const store = new ActivityStore();
      try {
        await store.open(directory, directory);
        const id = store.startSession(start.toISOString());
        for (const event of events) {
          const input: ActivityEventInput = { sessionId: id, occurredAt: new Date(start.getTime() + event.offset).toISOString(),
            eventType: event.kind, application: event.app, fallbackReason: event.fallbackReason };
          store.recordEvent(input);
        }
        store.endSession(id, new Date(start.getTime() + 40_000).toISOString());
        const summary = buildActivitySummary(store, "daily", "2026-09-26", new Date(2026, 8, 28));
        assert.equal(summary.stats.sessionCount, 1);
        assert.equal(summary.stats.totalActiveMs, 40_000);
        assert.deepEqual(summary.stats.apps, expected);
        if (start.getHours() === 23) {
          assert.equal(buildActivitySummary(store, "daily", "2026-09-27", new Date(2026, 8, 28)).stats.sessionCount, 0);
        }
      } finally { await store.close(); }
    });
  };
  const clickA: Input = { offset: 0, kind: "click", app: "Editor A" };
  const focusB: Input = { offset: 10_000, kind: "app_focus", app: "Browser B" };
  const split = [{ app: "Browser B", durationMs: 30_000 }, { app: "Editor A", durationMs: 10_000 }];
  await check("stored click at session start preserves prefix before first focus", [clickA, focusB], split);
  await check("existing focus-at-start allocation is unchanged", [{ ...clickA, kind: "app_focus" }, focusB], split);
  await check("no-focus sessions retain equal allocation", [clickA, { ...focusB, kind: "click" }], [
    { app: "Browser B", durationMs: 20_000 }, { app: "Editor A", durationMs: 20_000 }
  ]);
  await check("late click does not invent start ownership", [{ ...clickA, offset: 1_000 }, focusB], [{ app: "Browser B", durationMs: 40_000 }]);
  await check("missing click application retains legacy fallback", [{ ...clickA, app: undefined }, focusB], [{ app: "Browser B", durationMs: 40_000 }]);
  await check("conflicting same-time clicks retain legacy fallback", [clickA, { ...clickA, app: "Other App" }, focusB], [{ app: "Browser B", durationMs: 40_000 }]);
  await check("sensitive marker cannot seed start ownership", [{ ...clickA, fallbackReason: "sensitive_app" }, focusB], [{ app: "Browser B", durationMs: 40_000 }]);
  await check("repeated focus does not double count", [clickA, focusB, { ...focusB, offset: 20_000 }], split);
  await check("cross-midnight session stays wholly on its start date", [clickA, focusB], split, new Date(2026, 8, 26, 23, 59, 40));
} finally {
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
