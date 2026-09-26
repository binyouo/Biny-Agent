/** 敏感前台输入经真实 Activity 服务和 SQLite 只留下限频抑制标记。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-sensitive-input-"));
const inputMonitorPath = path.join(root, "activity-input-monitor");
await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='start')console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));if(command.type==='stop')process.exit(0)});\n`, { mode: 0o700 });
let clock = 0;
const callbacks = new Map<number, () => void>();
const settings = {
  ...defaultActivitySettings,
  outputDirectory: path.join(root, "records"),
  captureDebounceMs: 0,
  ocrEnabled: false,
  sensitiveApplications: ["test.private.app"]
};
const service = new ActivityRecorderService({
  agentDir: root,
  configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
  inputMonitorPath,
  now: () => clock,
  captureDesktopScreen: async () => Buffer.from("jpeg"),
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  captureTimers: {
    setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval,
    clearInterval: () => undefined
  }
});
let database: DatabaseSync | undefined;
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("sensitive Activity event did not reach expected state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};
const emit = (eventType: string, bundleId: string, application: string, extras: Record<string, unknown> = {}): void => {
  service.handleInputLine(JSON.stringify({
    type: "event", eventType, bundleId, application,
    occurredAt: new Date(1_700_000_000_000 + clock).toISOString(), ...extras
  }));
};
try {
  await service.initialize();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  await waitFor(() => service.snapshot().state === "running" && service.snapshot().screenRecordingGranted);
  const events = () => database!.prepare("SELECT kind, app_name, data FROM activity_events ORDER BY rowid").all() as Array<{ kind: string; app_name: string; data: string }>;
  const snapshots = () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n);

  emit("app_focus", "test.private.app", "Private", { windowTitle: "Secret window" });
  for (let index = 0; index < 20; index++) emit("keypress", "test.private.app", "Private", { keyCode: 65, text: "secret" });
  emit("click", "test.private.app", "Private", { mouseX: 12, mouseY: 13 });
  await waitFor(() => events().length >= 1);
  assert.deepEqual(events().map((row) => row.kind), ["system"]);
  assert.deepEqual(JSON.parse(events()[0]!.data), { suppressed: true, reason: "sensitive_app" });
  assert.equal(events()[0]!.data.includes("secret"), false);
  callbacks.get(settings.heartbeatMs)!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshots(), 0, "敏感前台不得截图");

  clock = 4_999;
  emit("click", "test.private.app", "Private");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events().length, 1);
  clock = 5_000;
  emit("keypress", "test.private.app", "Private", { text: "more-secret" });
  await waitFor(() => events().length >= 2);
  assert.deepEqual(events().map((row) => row.kind), ["system", "system"]);

  clock = 10_000;
  database.exec("CREATE TRIGGER fail_marker BEFORE INSERT ON activity_events WHEN NEW.kind = 'system' BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END");
  emit("click", "test.private.app", "Private");
  await waitFor(() => (service.snapshot().error ?? "").includes("injected marker failure"));
  assert.equal(events().length, 2);
  database.exec("DROP TRIGGER fail_marker");
  emit("click", "test.private.app", "Private");
  await waitFor(() => events().length >= 3);
  assert.deepEqual(events().map((row) => row.kind), ["system", "system", "system"]);

  emit("app_focus", "test.editor.app", "Editor");
  emit("click", "test.editor.app", "Editor");
  await waitFor(() => events().length >= 5);
  assert.deepEqual(events().map((row) => row.kind), ["system", "system", "system", "app_focus", "click"]);
  callbacks.get(settings.heartbeatMs)!();
  await waitFor(() => snapshots() >= 1, 10_000);
  clock = 15_000;
  emit("app_focus", "test.private.app", "Private");
  emit("lock", "test.private.app", "Private");
  await waitFor(() => events().length >= 7 && service.snapshot().currentSessionId === undefined);
  assert.deepEqual(events().slice(-2).map((row) => row.kind), ["system", "lock"], "锁屏边界不被敏感门禁吞掉");
  emit("click", "test.private.app", "Private");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events().length, 7, "锁屏后不写敏感输入");
} finally {
  await service.stop();
  database?.close();
  await rm(root, { recursive: true, force: true });
}

console.log("activity sensitive input tests passed");
