/**
 * A live input child must receive a usable operation lifetime after refresh.
 * The child is a protocol-only fixture: no screen capture, OCR, browser or model.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentConfig } from "../src/config/schema.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { ActivityAnalysisSchedulerTimers } from "../src/activity/analysisScheduler.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";

for (const action of ["refresh", "same-value settings", "normalized settings"] as const) {
  test(`running recorder renews an aborted lifetime after ${action}`, {
    timeout: 5_000,
    skip: process.platform === "win32" ? "The macOS input fixture uses an executable shebang." : false
  }, async (context) => {
    const fixture = await createFixture(context);
    const { service } = fixture;
    const oldSignal = service.getOperationSignal();
    assert.equal(oldSignal.aborted, false);

    // A report already waiting on configuration belongs to the old lifetime.
    // Renewing the service must not let this request attach to the new signal.
    const blocked = fixture.holdNextConfigLoad();
    const oldReport = service.buildReport("2026-10-01");
    const rejectedOldReport = assert.rejects(oldReport, { name: "AbortError" });
    fixture.settleOnCleanup(rejectedOldReport);
    await blocked.entered;

    if (action === "refresh") {
      await service.refresh();
    } else {
      const current = await service.settingsSnapshot();
      await service.updateSettings({
        visualPollMs: action === "normalized settings" ? 5_000 : current.activity.visualPollMs
      }, current.configRevision);
    }

    assert.equal((await service.runtimeSettingsSnapshot()).visualPollMs, 10_000);
    assert.equal(service.snapshot().state, "running");
    assert.equal(service.httpCaptureStatus().running, true);
    const nextSignal = service.getOperationSignal();
    assert.equal(oldSignal.aborted, true);
    assert.notEqual(nextSignal, oldSignal);
    assert.equal(nextSignal.aborted, false, "unchanged effective settings still need a usable lifetime");
    await fixture.waitForStarts(2);

    blocked.release();
    await rejectedOldReport;
    assert.equal(oldSignal.aborted, true, "renewal cannot revive an old operation");
    assert.equal(fixture.notes.length, 0, "the old report must not reach its downstream writer");

    // Public user-visible work must succeed, not merely report a running child.
    const report = await service.buildReport("2026-10-01");
    assert.equal(report.date, "2026-10-01");
    assert.equal(report.sessionCount, 0);
    assert.equal(fixture.notes.length, 1);
    assert.equal(service.getOperationSignal(), nextSignal);
    assert.equal(nextSignal.aborted, false);
    assert.equal(service.snapshot().events, 0, "the fixture never supplies user activity");
  });
}

test("a live unchanged start keeps its lifetime; changed settings and stop replace or cancel it", {
  timeout: 5_000,
  skip: process.platform === "win32" ? "The macOS input fixture uses an executable shebang." : false
}, async (context) => {
  const fixture = await createFixture(context);
  const { service } = fixture;
  const firstSignal = service.getOperationSignal();

  await service.startRuntime();
  assert.equal(service.getOperationSignal(), firstSignal, "the healthy no-op fast path remains available");
  assert.equal(firstSignal.aborted, false);
  assert.equal((await fixture.commands()).filter((command) => command === "start").length, 1);

  const current = await service.settingsSnapshot();
  await service.updateSettings({ visualPollMs: 12_000 }, current.configRevision);
  await fixture.waitForStarts(2);
  const changedSignal = service.getOperationSignal();
  assert.equal(firstSignal.aborted, true);
  assert.notEqual(changedSignal, firstSignal);
  assert.equal(changedSignal.aborted, false);
  assert.equal((await service.runtimeSettingsSnapshot()).visualPollMs, 12_000);

  await service.stop();
  assert.equal(changedSignal.aborted, true);
  assert.equal(service.snapshot().state, "stopped");
  assert.equal(service.httpCaptureStatus().running, false);
  assert.equal(fixture.embeddingTimers.pending.size, 0);
  assert.equal(fixture.dailyTimers.pending.size, 0);
  await assert.rejects(service.buildReport("2026-10-01"), { name: "AbortError" });
  assert.deepEqual(await fixture.commands(), ["start", "stop", "start", "stop"]);
});

async function createFixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-refresh-lifetime-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const owner: { service?: ActivityRecorderService } = {};
  const releases = new Set<() => void>();
  const cleanupTasks: Promise<unknown>[] = [];
  // Register cleanup before starting a child or opening a store.
  context.after(async () => {
    for (const release of releases) release();
    try {
      await owner.service?.stop();
    } finally {
      await Promise.allSettled(cleanupTasks);
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.BINY_AGENT_DIR = root;

  let config: AgentConfig = structuredClone(defaultConfig);
  config.providers = {};
  config.models = {};
  config.toolModel = undefined;
  config.activity = {
    ...config.activity,
    enabled: true,
    visualPollMs: 10_000,
    outputDirectory: path.join(root, "records")
  };
  let revision = "1";
  let nextLoad: { entered: Deferred; released: Deferred } | undefined;
  const snapshot = () => ({ config: structuredClone(config), revision });
  const configStore: AgentConfigStore = {
    load: async () => {
      const value = structuredClone(config);
      const blocked = nextLoad;
      nextLoad = undefined;
      if (blocked) {
        blocked.entered.resolve();
        await blocked.released.promise;
      }
      return value;
    },
    save: async (value) => {
      config = structuredClone(value);
      revision = String(Number(revision) + 1);
    },
    loadVersioned: async () => snapshot(),
    saveVersioned: async (value, expectedRevision) => {
      assert.equal(expectedRevision, revision);
      config = structuredClone(value);
      revision = String(Number(revision) + 1);
      return snapshot();
    }
  };

  const commandsPath = path.join(root, "commands.jsonl");
  const inputMonitorPath = path.join(root, "input-monitor.mjs");
  await writeFile(inputMonitorPath, `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(command.type) + "\\n");
  if (command.type === "start") {
    console.log(JSON.stringify({
      type: "status", status: "running",
      screenRecordingGranted: false, accessibilityGranted: false
    }));
  } else if (command.type === "stop") process.exit(0);
});
`, { mode: 0o700 });

  const commands = async (): Promise<string[]> => {
    let content: string;
    try { content = await readFile(commandsPath, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return content.trim().split("\n").filter(Boolean).map((line) => {
      const value: unknown = JSON.parse(line);
      assert.equal(typeof value, "string");
      return value as string;
    });
  };
  const waitForStarts = async (expected: number): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while ((await commands()).filter((command) => command === "start").length !== expected) {
      assert.ok(Date.now() < deadline, "the fake child must acknowledge the expected starts");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  const notes: string[] = [];
  const embeddingTimers = new IdleTimers();
  const dailyTimers = new IdleTimers();
  const service = new ActivityRecorderService({
    agentDir: root,
    configStore,
    inputMonitorPath,
    embeddingSchedulerTimers: embeddingTimers,
    dailySummaryTimers: dailyTimers,
    // No capture, encoding, OCR, browser or embedding adapters are supplied.
    writeDailyNote: async (date, content, options) => {
      await options?.checkpoint?.();
      notes.push(content);
      return path.join(root, `${date}.md`);
    }
  });
  owner.service = service;
  await service.initialize();
  await waitForStarts(1);
  assert.equal(service.snapshot().state, "running");
  assert.equal(service.snapshot().screenRecordingGranted, false);
  return {
    service, notes, commands, waitForStarts, embeddingTimers, dailyTimers,
    settleOnCleanup(task: Promise<unknown>) {
      // Attach rejection handling immediately, including when an earlier assertion fails.
      cleanupTasks.push(task.catch(() => undefined));
    },
    holdNextConfigLoad() {
      assert.equal(nextLoad, undefined);
      const entered = deferred();
      const released = deferred();
      nextLoad = { entered, released };
      const release = () => { released.resolve(); releases.delete(release); };
      releases.add(release);
      return { entered: entered.promise, release };
    }
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = (): void => { throw new Error("deferred resolver was not installed"); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class IdleTimers implements ActivityAnalysisSchedulerTimers {
  readonly pending = new Set<ReturnType<typeof setTimeout>>();
  setTimeout = (_callback: () => void, _ms: number): ReturnType<typeof setTimeout> => {
    const handle = {} as ReturnType<typeof setTimeout>;
    this.pending.add(handle);
    return handle;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.pending.delete(handle);
  };
}
