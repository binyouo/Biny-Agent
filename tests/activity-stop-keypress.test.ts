/** Stop/restart must settle the old monitor's trailing input before ending its session. */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

interface FixtureEvent {
  eventType: "keypress" | "click" | "lock";
  application: string;
  bundleId?: string;
  inputEventCount?: number;
  keyCode?: number;
}

interface EventRow {
  session_id: string;
  kind: string;
  app_name: string | null;
  data: string;
}

interface TrackedChild {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
}

const editorBundle = "test.activity.editor";
const privateBundle = "test.activity.private";
const trailingEvents: FixtureEvent[] = [
  { eventType: "keypress", application: "Old tail first", inputEventCount: 1, keyCode: 11 },
  { eventType: "click", application: "Old tail click", inputEventCount: 1 },
  { eventType: "keypress", application: "Old tail last", inputEventCount: 1, keyCode: 12 }
];
const testOptions = { skip: process.platform === "win32", timeout: 15_000 };

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function killAndWait({ child, closed }: TrackedChild): Promise<void> {
  // Only target the exact fake child object, never an independently looked-up PID.
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Fake Activity monitor did not close during cleanup")), 3_000);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fixture(
  t: TestContext,
  options: { initialEvents?: FixtureEvent[]; tailEvents?: FixtureEvent[] } = {}
): Promise<{
  service: ActivityRecorderService;
  database: DatabaseSync;
  rows(): EventRow[];
  trackCurrentChild(): void;
  activeIdleTimers: Set<ReturnType<typeof setTimeout>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-stop-keypress-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  const children = new Map<ChildProcessWithoutNullStreams, TrackedChild>();
  const activeIdleTimers = new Set<ReturnType<typeof setTimeout>>();
  let service: ActivityRecorderService | undefined;
  let database: DatabaseSync | undefined;
  const trackCurrentChild = (): void => {
    // Read the child only for deterministic process cleanup; assertions use public behavior and SQLite.
    const child = (service as unknown as { child?: ChildProcessWithoutNullStreams } | undefined)?.child;
    if (!child || children.has(child)) return;
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
    children.set(child, { child, closed });
  };
  t.after(async () => {
    trackCurrentChild();
    try {
      // A second stop also removes timers left by the intentionally failing baseline.
      await service?.stop();
    } finally {
      try {
        await Promise.all([...children.values()].map(killAndWait));
      } finally {
        database?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  // Simulate old stdout arriving while the host awaits close. The real Swift monitor
  // emits each key immediately; it does not generate extra keys upon a stop command.
  const script = [
    "#!" + process.execPath,
    "import { createInterface } from 'node:readline';",
    "let generation;",
    "const initialEvents = " + JSON.stringify(options.initialEvents ?? []) + ";",
    "const tailEvents = " + JSON.stringify(options.tailEvents ?? []) + ";",
    "const event = value => ({ type: 'event', occurredAt: new Date().toISOString(), bundleId: " + JSON.stringify(editorBundle) + ", ...value });",
    "const line = value => JSON.stringify(value) + '\\n';",
    "createInterface({ input: process.stdin }).on('line', raw => {",
    "  const command = JSON.parse(raw);",
    "  if (command.type === 'start') {",
    "    generation = command.settings.jpegQuality === " + String(defaultActivitySettings.jpegQuality) + " ? 'Old' : 'New';",
    "    const messages = [",
    "      event({ eventType: 'app_focus', application: generation }),",
    "      ...(generation === 'Old' ? initialEvents.map(event) : []),",
    "      event({ eventType: 'click', application: generation + ' ready', inputEventCount: 1 })",
    "    ];",
    "    process.stdout.write(messages.map(line).join(''));",
    "  } else if (command.type === 'stop') {",
    "    const messages = generation === 'Old' ? tailEvents.map(event) : [];",
    "    process.stdout.write(messages.map(line).join(''), () => process.exit(0));",
    "  }",
    "});",
    ""
  ].join("\n");
  await writeFile(inputMonitorPath, script, { mode: 0o700 });
  const settings = {
    ...defaultActivitySettings,
    outputDirectory: path.join(root, "records"),
    sensitiveApplications: [privateBundle]
  };
  service = new ActivityRecorderService({
    agentDir: root,
    inputMonitorPath,
    configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
    // No capture/encoding callbacks are installed: the fixture cannot capture the screen.
    sessionIdleTimers: {
      setTimeout: ((_callback: () => void) => {
        const handle = {} as ReturnType<typeof setTimeout>;
        activeIdleTimers.add(handle);
        return handle;
      }) as unknown as typeof setTimeout,
      clearTimeout: handle => { if (handle && typeof handle === "object") activeIdleTimers.delete(handle); }
    }
  });
  await service.initialize();
  trackCurrentChild();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  const db = database;
  const rows = (): EventRow[] => db.prepare(
    "SELECT session_id, kind, app_name, data FROM activity_events ORDER BY rowid"
  ).all() as unknown as EventRow[];
  await until(() => rows().some(row => row.kind === "click" && row.app_name === "Old ready"),
    "Fake Activity monitor did not publish its initial input");
  await service.search("stop-keypress-initial-queue-barrier");
  return { service, database, rows, trackCurrentChild, activeIdleTimers };
}

function keyCount(rows: EventRow[]): number {
  return rows.filter(row => row.kind === "keypress").reduce((total, row) => {
    const data = JSON.parse(row.data) as { count: number };
    return total + data.count;
  }, 0);
}

function assertStopped(
  service: ActivityRecorderService,
  database: DatabaseSync,
  activeIdleTimers: Set<ReturnType<typeof setTimeout>>
): void {
  assert.equal(service.snapshot().state, "paused");
  assert.equal(service.snapshot().currentSessionId, undefined, "stop must not enqueue a new session");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_sessions WHERE ended_at IS NULL").get()!.n, 0);
  assert.equal(activeIdleTimers.size, 0, "stop must not leave a new idle timer behind");
}

test("stopRuntime settles trailing keypresses and clicks in the old session", testOptions, async t => {
  const { service, database, rows, activeIdleTimers } = await fixture(t, { tailEvents: trailingEvents });
  const oldSession = rows().find(row => row.kind === "app_focus")!.session_id;
  await service.stopRuntime();
  await service.search("stop-keypress-stopped-queue-barrier");

  const tail = rows().filter(row => row.app_name?.startsWith("Old tail"));
  assert.deepEqual(tail.map(row => row.app_name), trailingEvents.map(event => event.application),
    "the stop buffer must preserve key/click FIFO order");
  assert.ok(tail.every(row => row.session_id === oldSession));
  assert.equal(keyCount(tail), 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_sessions").get()!.n, 1);
  assertStopped(service, database, activeIdleTimers);
});

test("an in-place settings restart cannot move trailing keys into the new monitor session", testOptions, async t => {
  const { service, database, rows, trackCurrentChild } = await fixture(t, { tailEvents: trailingEvents });
  const oldSession = rows().find(row => row.kind === "app_focus")!.session_id;
  // An actual changed value takes applySettings through stop and spawn in one queue operation.
  await service.updateRuntimeSettings({ jpegQuality: defaultActivitySettings.jpegQuality + 1 });
  trackCurrentChild();
  // The method returning does not imply the new child's stdout has arrived yet.
  await until(() => rows().some(row => row.kind === "click" && row.app_name === "New ready"),
    "Restarted Activity monitor did not publish its new input");
  await service.search("stop-keypress-restarted-queue-barrier");

  const newSession = rows().find(row => row.kind === "app_focus" && row.app_name === "New")!.session_id;
  assert.notEqual(newSession, oldSession);
  const tail = rows().filter(row => row.app_name?.startsWith("Old tail"));
  assert.deepEqual(tail.map(row => row.app_name), trailingEvents.map(event => event.application));
  assert.equal(keyCount(tail), 2);
  assert.ok(tail.every(row => row.session_id === oldSession), "old input must finish before the new session starts");
  assert.equal(keyCount(rows().filter(row => row.session_id === newSession)), 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_sessions").get()!.n, 2);
  assert.equal(service.snapshot().state, "running");
  assert.equal(service.snapshot().currentSessionId, newSession);
});

test("running input still batches forty keys and flushes the remainder at the next event", testOptions, async t => {
  const initialEvents: FixtureEvent[] = Array.from({ length: 45 }, () => ({
    eventType: "keypress", application: "Running keys", inputEventCount: 1, keyCode: 11
  }));
  const { service, database, rows, activeIdleTimers } = await fixture(t, { initialEvents });
  const keys = rows().filter(row => row.kind === "keypress");
  assert.deepEqual(keys.map(row => (JSON.parse(row.data) as { count: number }).count), [40, 5]);
  assert.equal(keyCount(keys), 45);
  assert.ok(keys.every(row => row.session_id === rows()[0]!.session_id));
  await service.stopRuntime();
  await service.search("stop-keypress-normal-queue-barrier");
  assertStopped(service, database, activeIdleTimers);
});

test("stop buffering still rejects sensitive keys and keys following a lock", testOptions, async t => {
  const tailEvents: FixtureEvent[] = [
    { eventType: "keypress", application: "Private key", bundleId: privateBundle, inputEventCount: 1, keyCode: 11 },
    { eventType: "lock", application: "Locked editor", bundleId: editorBundle },
    { eventType: "keypress", application: "Locked key", bundleId: editorBundle, inputEventCount: 1, keyCode: 12 }
  ];
  const { service, database, rows, activeIdleTimers } = await fixture(t, { tailEvents });
  const oldSession = rows()[0]!.session_id;
  await service.stopRuntime();
  await service.search("stop-keypress-private-queue-barrier");

  assert.equal(keyCount(rows()), 0, "the stop path must not bypass the existing privacy gates");
  assert.deepEqual(rows().filter(row => row.kind === "lock").map(row => row.session_id), [oldSession]);
  assert.ok(rows().every(row => row.app_name !== "Private key" && row.app_name !== "Locked key"));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_sessions").get()!.n, 1);
  assertStopped(service, database, activeIdleTimers);
});
