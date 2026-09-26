/** 真实输入子进程和 SQLite 验证解锁只重置画面基线，下一次周期触发才截图。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

for (const source of ["input", "electron"] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), `biny-activity-unlock-${source}-`));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='stop')process.exit(0);if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));${source === "input" ? "setTimeout(()=>{console.log(JSON.stringify({type:'event',eventType:'lock',occurredAt:new Date().toISOString()}));console.log(JSON.stringify({type:'event',eventType:'unlock',occurredAt:new Date().toISOString()}));},20);" : ""}}});\n`, {mode: 0o700});
  const settings = {...defaultActivitySettings, outputDirectory: path.join(root, "records"), captureDebounceMs: 0};
  const callbacks = new Map<number, () => void>();
  let captures = 0;
  const service = new ActivityRecorderService({
    agentDir: root,
    inputMonitorPath,
    configStore: {load: async () => ({...defaultConfig, activity: settings})} as AgentConfigStore,
    captureDesktopScreen: async () => { captures++; return Buffer.from(`jpeg-${captures}`); },
    encodeFrame: async jpeg => ({jpeg, width: 1, height: 1, pixels: Buffer.from([captures, 0, 0, 255])}),
    captureTimers: {
      setInterval: ((callback: () => void, ms: number) => {callbacks.set(ms, callback);return {unref() {}};}) as unknown as typeof setInterval,
      clearInterval: () => undefined
    }
  });
  let database: DatabaseSync | undefined;
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`${source} unlock fixture timed out`);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await waitFor(() => service.snapshot().state === "running" && service.snapshot().screenRecordingGranted);
    if (source === "electron") {
      service.handlePowerEvent("lock-screen");
      await waitFor(() => service.snapshot().screenLocked);
      service.handlePowerEvent("unlock-screen");
    }
    if (source === "input") {
      await waitFor(() => Boolean(database!.prepare("SELECT id FROM activity_events WHERE kind='unlock'").get()));
    } else {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='unlock'").get()!.n, 0,
        "Electron unlock only clears the capture gate");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_sessions").get()!.n, 0,
        "Electron power events without activity must not create a session");
    }
    assert.equal(service.snapshot().screenLocked, false);
    // 解锁事件已完成入库；让零延迟防抖计时器有机会运行，以观察是否意外发起截图。
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    assert.equal(captures, 0, `${source} unlock must not schedule an immediate capture`);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n, 0);
    callbacks.get(settings.heartbeatMs)!();
    await waitFor(() => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n) === 1);
    assert.equal(captures, 1, "the next heartbeat can capture after unlock");
  } finally {
    await service.stop();
    database?.close();
    await rm(root, {recursive: true, force: true});
  }
}
console.log("activity unlock capture tests passed");
