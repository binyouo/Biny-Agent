/** 真实子进程与 SQLite 验证备用截图协议；不访问用户屏幕，也不申请系统权限。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

await testRecorderResumesAfterExternalClear();

async function testRecorderResumesAfterExternalClear(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-external-clear-"));
  const sidecarPath = path.join(root, "sidecar.mjs");
  const startsPath = path.join(root, "starts.jsonl");
  const triggerPath = path.join(root, "trigger");
  await writeFile(sidecarPath, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const event = () => send({type:'event',eventType:'click',occurredAt:new Date().toISOString(),application:String(process.pid)});
let timer;
createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'start') {
    appendFileSync(${JSON.stringify(startsPath)}, String(process.pid) + '\\n');
    send({type:'status',status:'running',screenRecordingGranted:false,accessibilityGranted:false});
    event();
    if (!existsSync(${JSON.stringify(triggerPath)})) timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(triggerPath)})) return;
      clearInterval(timer);
      for (let i = 0; i < 20; i++) event();
    }, 10);
  } else if (command.type === 'stop') {
    clearInterval(timer);
    event();
    process.stdout.write('', () => process.exit(0));
  }
});
`, { mode: 0o700 });
  const config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: path.join(root, "records") } };
  const service = new ActivityRecorderService({ configStore: { load: async () => config } as AgentConfigStore, sidecarPath });
  const externalStore = new ActivityStore();
  let database: DatabaseSync | undefined;
  try {
    await service.initialize();
    await externalStore.open(config.activity.outputDirectory);
    database = new DatabaseSync(path.join(config.activity.outputDirectory, "activity.sqlite"));
    const applications = (): string[] => (database!.prepare("SELECT application FROM activity_events").all() as Array<{ application: string }>).map((row) => row.application);
    await waitFor(async () => applications().length === 1);
    const oldApplication = applications()[0];
    await externalStore.clear();
    await writeFile(triggerPath, "clear completed");
    await waitFor(async () => applications().some((application) => application !== oldApplication));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const starts = (await readFile(startsPath, "utf8")).trim().split("\n");
    assert.equal(starts.length, 2, "清空后只重启一次采集器");
    assert.deepEqual(applications(), [starts[1]], "排队和 stop 冲刷的旧事件不能进入清空后的数据库");
    assert.equal(service.snapshot().state, "running");
  } finally {
    await service.stop();
    database?.close();
    await externalStore.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["success", "denied", "locked", "stopped", "restarted"] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-capture-fallback-"));
  const sidecarPath = path.join(root, "sidecar.mjs");
  const resultPath = path.join(root, "results.jsonl");
  await writeFile(sidecarPath, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const status = locked => send({type:'status',status:'running',screenRecordingGranted:${mode !== "denied"},accessibilityGranted:false,screenLocked:locked});
createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'start') {
    if (!command.desktopCaptureAvailable) process.exit(3);
    status(false);
    send({type:'desktop_capture',requestId:String(process.pid),maxWidth:160});
    ${mode === "locked" ? "status(true);" : ""}
  } else if (command.type === 'desktop_capture_result') {
    appendFileSync(${JSON.stringify(resultPath)}, JSON.stringify(command) + '\\n');
    if (command.imageBase64) send({type:'capture',occurredAt:new Date().toISOString(),application:'QA',jpegBase64:command.imageBase64,captureTrigger:'heartbeat'});
  } else if (command.type === 'stop') process.exit(0);
});
`, { mode: 0o700 });
  let release: (() => void) | undefined;
  let captureCalls = 0;
  const config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: path.join(root, "records") } };
  const service = new ActivityRecorderService({
    configStore: { load: async () => config } as AgentConfigStore,
    sidecarPath,
    captureDesktopScreen: async (maxWidth) => {
      assert.equal(maxWidth, 160);
      captureCalls += 1;
      if (mode !== "success" && captureCalls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return Buffer.from("local-fallback-image");
    }
  });
  const responses = async (): Promise<Array<{ imageBase64?: string; error?: string }>> => {
    const text = await readFile(resultPath, "utf8").catch(() => "");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  try {
    await service.initialize();
    if (mode === "success") {
      await waitFor(async () => service.snapshot().fallbackCaptures === 1);
      assert.equal((await responses())[0]?.imageBase64, Buffer.from("local-fallback-image").toString("base64"));
      assert.equal(captureCalls, 1);
    } else if (mode === "denied") {
      await waitFor(async () => (await responses()).length === 1);
      assert.equal(captureCalls, 0, "无权限时不能调用备用截图后端");
      assert.ok((await responses())[0]?.error);
      assert.equal(service.snapshot().fallbackCaptures, 0);
    } else {
      await waitFor(async () => release !== undefined);
      if (mode === "locked") {
        await waitFor(async () => service.snapshot().screenLocked);
        release!();
        await waitFor(async () => (await responses()).length === 1);
        assert.ok((await responses())[0]?.error);
        assert.equal((await responses())[0]?.imageBase64, undefined);
        assert.equal(service.snapshot().fallbackCaptures, 0);
      } else {
        await service.stop();
        if (mode === "restarted") {
          await service.refresh();
          await waitFor(async () => service.snapshot().fallbackCaptures === 1);
        }
        release!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal((await responses()).length, mode === "restarted" ? 1 : 0, "旧采集器的响应不能送给新进程");
      }
    }
  } finally {
    release?.();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("备用截图协议未到达预期状态");
}
