/** A REST history deletion must retire old OCR without disabling future fallback OCR. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentConfigStore } from "../src/config/store.js";
import type { ActivityStore as ActivityStoreType } from "../src/activity/store.js";
import type { ActivityRecorderService as RecorderType } from "../src/desktop/electron/main/ActivityRecorderService.js";
import type { ActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";

// Establish storage isolation before importing product modules. No user model or screen is used.
const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "biny-activity-fallback-revision-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = suiteRoot;
try {
  const { ActivityRecorderService } = await import("../src/desktop/electron/main/ActivityRecorderService.js");
  const { ActivityStore } = await import("../src/activity/store.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { defaultActivitySettings } = await import("../src/activity/settings.js");
  const { startActivityHttpEndpoint } = await import("../src/activity/httpEndpoint.js");
  const { createDesktopActivityHttpDependencies } = await import("../src/desktop/electron/main/activityHttpApi.js");

  interface OcrCall { ordinal: number; file: string }
  interface KeywordHit { id: string; sessionId: string; snapshotId: string; text: string }
  const testOptions = { skip: process.platform === "win32", timeout: 25_000 };

  async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 6_000;
    while (!await check()) {
      assert.ok(Date.now() < deadline, message);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  async function fixture(t: TestContext, holdOrdinal?: number) {
    const root = await mkdtemp(path.join(suiteRoot, "case-"));
    const callsPath = path.join(root, "ocr-calls.jsonl");
    const releasePath = path.join(root, "release-ocr");
    const inputMonitorPath = path.join(root, "activity-input-monitor");
    const intervals = new Map<ReturnType<typeof setInterval>, { ms: number; callback: () => void }>();
    const idleTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const resources: { service?: RecorderType; store?: ActivityStoreType; endpoint?: ActivityHttpEndpoint } = {};
    const calls = (): OcrCall[] => existsSync(callsPath)
      ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as OcrCall)
      : [];
    t.after(async () => {
      // Release even a failed test's fake OCR before shutting down its real subprocess.
      await writeFile(releasePath, "release");
      try {
        await resources.endpoint?.close();
      } finally {
        try {
          await resources.service?.stop();
          await until(() => calls().every(call => existsSync(path.join(root, `ocr-exited-${call.ordinal}`))),
            "Every started synthetic OCR process must exit during cleanup");
          await new Promise<void>(resolve => setImmediate(resolve));
          await resources.service?.search("cleanup-queue-barrier");
        } finally {
          // The service has no public dispose. Read its owned store only to close it after stop;
          // no private field or method drives the scenario or any behavioral assertion.
          const ownedStore = (resources.service as unknown as { store?: ActivityStoreType } | undefined)?.store;
          await ownedStore?.close();
          await resources.store?.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    });

    // This protocol-only monitor exits deliberately; it cannot read real input or permissions.
    await writeFile(inputMonitorPath, [
      "#!" + process.execPath,
      "import { createInterface } from 'node:readline';",
      "createInterface({ input: process.stdin }).on('line', line => {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'stop') process.exit(0);",
      "  if (command.type === 'start') {",
      "    console.log(JSON.stringify({ type: 'status', status: 'running', screenRecordingGranted: true, accessibilityGranted: true }));",
      "    setTimeout(() => process.exit(17), 10);",
      "  }",
      "});",
      ""
    ].join("\n"), { mode: 0o700 });
    await writeFile(path.join(root, "activity-ocr"), [
      "#!" + process.execPath,
      "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const root = " + JSON.stringify(root) + ";",
      "const calls = " + JSON.stringify(callsPath) + ";",
      "const ordinal = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1;",
      "process.on('exit', () => writeFileSync(root + '/ocr-exited-' + ordinal, 'exited'));",
      "process.on('SIGTERM', () => process.exit(0));",
      "appendFileSync(calls, JSON.stringify({ ordinal, file: process.argv[2] }) + '\\n');",
      "const finish = () => process.stdout.write('revision-fixture-marker-' + ordinal + '\\n', () => process.exit(0));",
      "if (ordinal === " + JSON.stringify(holdOrdinal ?? -1) + ") {",
      "  const timer = setInterval(() => { if (existsSync(" + JSON.stringify(releasePath) + ")) { clearInterval(timer); finish(); } }, 5);",
      "} else finish();",
      ""
    ].join("\n"), { mode: 0o700 });

    const settings = {
      ...defaultActivitySettings,
      outputDirectory: path.join(root, "records"),
      captureDebounceMs: 3_000,
      heartbeatMs: 60_000,
      visualPollMs: 0,
      browserPollIntervalMs: 0,
      ocrEveryNFrames: 1
    };
    const configStore = { load: async () => ({ ...defaultConfig, providers: {}, models: {}, activity: settings }) } as AgentConfigStore;
    let captureNow = Date.now();
    const service = new ActivityRecorderService({
      agentDir: root, configStore, inputMonitorPath,
      now: () => captureNow,
      readFrontmostBundle: async () => "test.activity.editor",
      hasScreenRecordingPermission: async () => true,
      // No computer-use executable exists in this isolated directory; native capture fails closed.
      // The fallback and encoder below only return synthetic bytes, never an Electron screen.
      captureDesktopScreen: async () => Buffer.from("synthetic-fallback-jpeg"),
      encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
      captureTimers: {
        setInterval: ((callback: () => void, ms: number) => {
          const handle = { unref() {} } as ReturnType<typeof setInterval>;
          intervals.set(handle, { ms, callback });
          return handle;
        }) as unknown as typeof setInterval,
        clearInterval: handle => { if (handle && typeof handle === "object") intervals.delete(handle); }
      },
      sessionIdleTimers: {
        setTimeout: ((callback: () => void) => {
          const handle = {} as ReturnType<typeof setTimeout>;
          idleTimers.set(handle, callback);
          return handle;
        }) as unknown as typeof setTimeout,
        clearTimeout: handle => { if (handle && typeof handle === "object") idleTimers.delete(handle); }
      }
    });
    resources.service = service;
    await service.initialize();
    await until(() => (service.snapshot().error ?? "").includes("已退出"), "Synthetic input monitor must exit before fallback capture");
    const store = new ActivityStore();
    resources.store = store;
    await store.open(settings.outputDirectory, root);
    const historyId = store.startSession("2020-01-01T09:00:00.000Z");
    store.recordEvent({ sessionId: historyId, occurredAt: "2020-01-01T09:00:01.000Z", eventType: "click", application: "Synthetic historical app" });
    store.endSession(historyId, "2020-01-01T09:01:00.000Z");
    const endpoint = await startActivityHttpEndpoint(createDesktopActivityHttpDependencies({ agentDir: root, activity: service, configStore }));
    resources.endpoint = endpoint;
    const request = async (route: string, method = "GET"): Promise<Response> => await fetch(`http://${endpoint.host}:${endpoint.port}/api/activity-recorder${route}`, {
      method, headers: { Authorization: `Bearer ${endpoint.token}` }
    });
    const marker = (ordinal: number): string => `revision-fixture-marker-${ordinal}`;
    const hits = async (ordinal: number): Promise<KeywordHit[]> => {
      const response = await request(`/search/keyword?q=${encodeURIComponent(marker(ordinal))}`);
      assert.equal(response.status, 200);
      return (await response.json() as { results: KeywordHit[] }).results;
    };
    const pulse = (): void => {
      captureNow += settings.captureDebounceMs + 1;
      const heartbeat = [...intervals.values()].find(entry => entry.ms === settings.heartbeatMs);
      // Revision recovery may temporarily unregister and replace the heartbeat.
      // Only reaching the next real OCR within the deadline is required.
      heartbeat?.callback();
    };
    const enterOcr = async (ordinal: number): Promise<OcrCall> => {
      await until(() => {
        if (calls().some(call => call.ordinal === ordinal)) return true;
        pulse();
        return false;
      }, `Heartbeat must reach synthetic OCR ${ordinal}`);
      return calls().find(call => call.ordinal === ordinal)!;
    };
    const savedOcr = async (ordinal: number): Promise<KeywordHit> => {
      const call = await enterOcr(ordinal);
      await until(async () => (await hits(ordinal)).length === 1, `Fresh OCR ${ordinal} must become searchable without a settings refresh`);
      const result = (await hits(ordinal))[0]!;
      assert.equal(result.text, marker(ordinal));
      assert.equal(store.getSnapshotPath(result.snapshotId), call.file, "OCR must remain attached to its actual persisted screenshot");
      assert.ok(store.getSessionDetail(result.sessionId)?.snapshots.some(snapshot => snapshot.id === result.snapshotId));
      assert.notEqual(result.sessionId, historyId, "Fresh capture must not attach to the deleted historical session");
      return result;
    };
    return { service, store, historyId, request, marker, hits, enterOcr, savedOcr,
      release: async () => { await writeFile(releasePath, "release"); },
      closeIdleSession: async () => {
        assert.equal(idleTimers.size, 1);
        const [handle, callback] = [...idleTimers.entries()][0]!;
        idleTimers.delete(handle);
        callback();
        await service.search("idle-queue-barrier");
        assert.equal(service.snapshot().currentSessionId, undefined);
      }
    };
  }

  await test("fallback OCR resumes after deleting unrelated history and across the next idle session", testOptions, async t => {
    const f = await fixture(t);
    const first = await f.savedOcr(1);
    const revision = f.store.clearRevision();
    const response = await f.request(`/sessions/${f.historyId}`, "DELETE");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.notEqual(f.store.clearRevision(), revision);
    assert.equal(f.store.getSessionRecord(f.historyId), undefined);
    assert.ok(f.store.getSessionRecord(first.sessionId), "Deletion must leave the active capture session intact");
    const second = await f.savedOcr(2);
    await f.closeIdleSession();
    const third = await f.savedOcr(3);
    assert.notEqual(third.sessionId, second.sessionId);
    assert.equal(f.store.getSessionRecord(f.historyId), undefined);
  });

  await test("deletion rejects an old OCR result but permits the next two fresh fallback OCR results", testOptions, async t => {
    const f = await fixture(t, 2);
    const first = await f.savedOcr(1);
    const oldCall = await f.enterOcr(2);
    const retainedBeforeDelete = f.store.getSessionDetail(first.sessionId)!;
    const oldSnapshot = retainedBeforeDelete.snapshots.find(snapshot => f.store.getSnapshotPath(snapshot.id) === oldCall.file);
    assert.ok(oldSnapshot, "Held OCR belongs to a still-existing screenshot in the active session");
    assert.equal(retainedBeforeDelete.endedAt, undefined);
    const revision = f.store.clearRevision();
    const response = await f.request(`/sessions/${f.historyId}`, "DELETE");
    assert.equal(response.status, 200);
    await response.json();
    assert.notEqual(f.store.clearRevision(), revision);
    assert.ok(f.store.getSessionDetail(first.sessionId)?.snapshots.some(snapshot => snapshot.id === oldSnapshot.id),
      "The late OCR target itself must survive; otherwise removing the revision guard could falsely pass");
    await f.release();
    // Seeing the next real OCR invocation proves the old capture passed its finally block;
    // an OCR child 'done' marker alone would not establish host-side settlement.
    await f.enterOcr(3);
    assert.deepEqual(await f.hits(2), [], "A pre-deletion OCR result must not be revived in the new revision");
    const third = await f.savedOcr(3);
    const fourth = await f.savedOcr(4);
    assert.notEqual(third.snapshotId, fourth.snapshotId);
    assert.deepEqual(await f.hits(2), []);
    assert.equal(f.store.getSessionRecord(f.historyId), undefined);
  });

  await test("ordinary capture, missing deletion and rejected active-session deletion retain working OCR", testOptions, async t => {
    const f = await fixture(t);
    const first = await f.savedOcr(1);
    const second = await f.savedOcr(2);
    assert.notEqual(first.snapshotId, second.snapshotId);
    const revision = f.store.clearRevision();
    for (const [id, status] of [["missing-fixture-session", 404], [second.sessionId, 409]] as const) {
      const response = await f.request(`/sessions/${id}`, "DELETE");
      assert.equal(response.status, status);
      await response.json();
      assert.equal(f.store.clearRevision(), revision);
    }
    await f.savedOcr(3);
    assert.ok(f.store.getSessionRecord(f.historyId));
  });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(suiteRoot, { recursive: true, force: true });
}
