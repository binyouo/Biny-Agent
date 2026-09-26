/** 输入已在队列等待时，旧空闲关闭任务不得结束被该输入延长的会话。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-idle-race-"));
const inputMonitorPath = path.join(root, "activity-input-monitor");
const triggerPath = path.join(root, "second-click");
await writeFile(inputMonitorPath, `#!${process.execPath}\nimport {existsSync} from 'node:fs';\nimport {createInterface} from 'node:readline';\nlet timer;\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='stop'){clearInterval(timer);process.exit(0)}if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));console.log(JSON.stringify({type:'event',eventType:'click',occurredAt:new Date().toISOString(),application:'First',bundleId:'test.first'}));timer=setInterval(()=>{if(existsSync(${JSON.stringify(triggerPath)})){clearInterval(timer);console.log(JSON.stringify({type:'event',eventType:'click',occurredAt:new Date().toISOString(),application:'Second',bundleId:'test.second'}));}},5)}});\n`, { mode: 0o700 });

const callbacks = new Map<number, () => void>();
let nextTimer = 0;
const service = new ActivityRecorderService({
  agentDir: root,
  inputMonitorPath,
  configStore: { load: async () => ({ ...defaultConfig, activity: {
    ...defaultActivitySettings, outputDirectory: root, idleTimeoutMs: 10_000
  } }) } as AgentConfigStore,
  sessionIdleTimers: {
    setTimeout: ((callback: () => void) => {
      const id = ++nextTimer;
      callbacks.set(id, callback);
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: number) => { callbacks.delete(handle); }) as unknown as typeof clearTimeout
  }
});
let database: DatabaseSync | undefined;
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Activity idle race fixture timed out");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
};
const fire = (id: number): void => {
  const callback = callbacks.get(id);
  assert.ok(callback, `missing idle timer ${id}`);
  callbacks.delete(id);
  callback();
};
const release = Promise.withResolvers<void>();
try {
  await service.initialize();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  await waitFor(() => Boolean(database!.prepare("SELECT id FROM activity_sessions WHERE ended_at IS NULL").get()));
  const sessionId = String((database.prepare("SELECT id FROM activity_sessions WHERE ended_at IS NULL").get() as { id: string }).id);
  const oldTimer = nextTimer;
  const entered = Promise.withResolvers<void>();
  // 用队列屏障确定竞态次序；可观察断言仍只读取真实输入事件和 SQLite 会话。
  const queue = service as unknown as { enqueue(operation: () => Promise<void>): Promise<void> };
  const blocker = queue.enqueue(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await writeFile(triggerPath, "go");
  await waitFor(() => service.httpCaptureStatus().frontmost.bundleId === "test.second");
  fire(oldTimer);
  release.resolve();
  await blocker;
  await service.search("idle-race-drain");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE session_id = ? AND kind = 'click'").get(sessionId)!.n, 2);
  assert.equal((database.prepare("SELECT ended_at FROM activity_sessions WHERE id = ?").get(sessionId) as { ended_at: number | null }).ended_at,
    null, "已排队的真实输入应使旧空闲关闭任务失效");
  fire(nextTimer);
  await service.search("idle-race-drain-again");
  assert.equal(typeof (database.prepare("SELECT ended_at FROM activity_sessions WHERE id = ?").get(sessionId) as { ended_at: number | null }).ended_at,
    "number", "新的空闲截止到达后才关闭会话");
} finally {
  release.resolve();
  await service.stop();
  database?.close();
  await rm(root, { recursive: true, force: true });
}
