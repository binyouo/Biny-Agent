/** 真实子进程与 SQLite 验证备用截图协议；不访问用户屏幕，也不申请系统权限。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityNativeClient } from "../src/desktop/electron/main/ActivityNativeClient.js";
import { ActivityStore } from "../src/activity/store.js";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

await testRecorderResumesAfterExternalClear();
await testFailedSnapshotDoesNotAdvanceOcrCadence();
await testMissingOcrBinaryKeepsCadence();
await testCaptureSurvivesInputMonitorExit();
await testPermissionDenialBlocksCaptureAfterMonitorExit();
await testBrowserPollAfterInputMonitorExit();

async function testBrowserPollAfterInputMonitorExit(): Promise<void> {
  // Given: 输入进程退出且原 session 已结束；When: 截图新建 session 后浏览器轮询首次写入失败；
  // Then: 没有 session 时不创建访问事件，失败访问不进入去重键，重试才能写入访问和标题。
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-browser-fallback-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));console.log(JSON.stringify({type:'event',eventType:'scroll',occurredAt:new Date().toISOString(),application:'Arc',bundleId:'company.thebrowser.Browser'}));setTimeout(()=>process.exit(17),20)}if(command.type==='stop')process.exit(0)});\n`, { mode: 0o700 });
  const callbacks = new Map<number, () => void>();
  const settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), captureDebounceMs: 0 };
  const service = new ActivityRecorderService({
    agentDir: root,
    configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
    inputMonitorPath,
    readFrontmostBundle: async () => "company.thebrowser.Browser",
    hasScreenRecordingPermission: async () => true,
    readBrowser: async (script) => { assert.match(script, /Arc/u); return "https://example.test/fallback\tRecovered tab"; },
    captureDesktopScreen: async () => Buffer.from("fallback-jpeg"),
    encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
    captureTimers: {
      setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval,
      clearInterval: () => undefined
    }
  });
  let database: DatabaseSync | undefined;
  const until = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`browser fallback did not reach ${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await until(() => service.snapshot().state === "error", "monitor exit");
    assert.equal(service.snapshot().currentSessionId, undefined);
    const browserVisits = () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind = 'browser_visit'").get()!.n);
    callbacks.get(settings.browserPollIntervalMs)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(browserVisits(), 0, "browser poll must not start a session");
    callbacks.get(settings.heartbeatMs)!();
    await until(() => Boolean(database!.prepare("SELECT id FROM activity_snapshots LIMIT 1").get())
      && (service.snapshot().error ?? "").includes("仅屏幕截图"), "completed independent screenshot");
    assert.ok(service.snapshot().currentSessionId, "screenshot starts the degraded session");
    database.exec("CREATE TRIGGER fail_browser BEFORE INSERT ON activity_events WHEN NEW.kind = 'browser_visit' BEGIN SELECT RAISE(ABORT, 'injected browser failure'); END");
    callbacks.get(settings.browserPollIntervalMs)!();
    await until(() => (service.snapshot().error ?? "").includes("injected browser failure"), "first browser write failure");
    assert.equal(browserVisits(), 0);
    database.exec("DROP TRIGGER fail_browser");
    callbacks.get(settings.browserPollIntervalMs)!();
    await until(() => browserVisits() === 1, "browser visit retry");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind = 'window_title'").get()!.n, 1);
    callbacks.get(settings.browserPollIntervalMs)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(browserVisits(), 1, "successful visit may be deduplicated");
  } finally {
    await service.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testPermissionDenialBlocksCaptureAfterMonitorExit(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-monitor-denied-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'permission_required',screenRecordingGranted:false,accessibilityGranted:true}));setTimeout(()=>process.exit(17),20)}if(command.type==='stop')process.exit(0)});\n`, { mode: 0o700 });
  const callbacks = new Map<number, () => void>();
  const settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records") };
  const service = new ActivityRecorderService({
    agentDir: root,
    configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
    inputMonitorPath,
    readFrontmostBundle: async () => "test.editor.app",
    hasScreenRecordingPermission: async () => false,
    captureDesktopScreen: async () => Buffer.from("must-not-capture"),
    encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
    captureTimers: {
      setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval,
      clearInterval: () => undefined
    }
  });
  let database: DatabaseSync | undefined;
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await waitFor(async () => service.snapshot().state === "error");
    assert.equal(service.snapshot().screenRecordingGranted, false);
    assert.match(service.snapshot().error ?? "", /等待独立验证/u);
    callbacks.get(settings.heartbeatMs)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n, 0);
  } finally {
    await service.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testCaptureSurvivesInputMonitorExit(): Promise<void> {
  // Given: 输入监听报告屏幕录制可用后异常退出；When: 心跳、锁屏和解锁发生；
  // Then: 错误状态仍如实显示，截图独立继续，但锁屏/暂停期间绝不写入。
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-monitor-exit-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='start'){console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));setTimeout(()=>process.exit(17),20)}if(command.type==='stop')process.exit(0)});\n`, { mode: 0o700 });
  await writeFile(path.join(root, "activity-ocr"), `#!${process.execPath}\nconsole.log('fallback OCR after input monitor exit');\n`, { mode: 0o700 });
  const callbacks = new Map<number, () => void>();
  const activeTimers = new Set<ReturnType<typeof setInterval>>();
  let heartbeatRegistrations = 0;
  let settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), captureDebounceMs: 0, ocrEveryNFrames: 1 };
  const service = new ActivityRecorderService({
    agentDir: root,
    configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
    inputMonitorPath,
    readFrontmostBundle: async () => "test.editor.app",
    hasScreenRecordingPermission: async () => true,
    captureDesktopScreen: async () => Buffer.from("fallback-jpeg"),
    encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
    captureTimers: {
      setInterval: ((callback: () => void, ms: number) => {
        callbacks.set(ms, callback);
        if (ms === settings.heartbeatMs) heartbeatRegistrations++;
        const timer = { unref() {} } as ReturnType<typeof setInterval>;
        activeTimers.add(timer);
        return timer;
      }) as unknown as typeof setInterval,
      clearInterval: (timer) => { activeTimers.delete(timer); }
    }
  });
  let database: DatabaseSync | undefined;
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await waitFor(async () => service.snapshot().state === "error");
    assert.match(service.snapshot().error ?? "", /已退出/u);
    assert.match(service.snapshot().error ?? "", /等待独立验证/u);
    assert.equal(service.snapshot().screenRecordingGranted, false);
    const snapshotCount = () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n);
    const heartbeat = callbacks.get(settings.heartbeatMs)!;
    heartbeat();
    await waitFor(async () => snapshotCount() === 1);
    assert.equal(service.snapshot().screenRecordingGranted, true);
    await waitFor(async () => Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_ocr_frames").get()!.n) === 1);
    assert.equal(service.snapshot().state, "error", "输入故障不能伪装成完整采集运行中");
    const activeBeforeRefresh = activeTimers.size;
    await service.refresh();
    await waitFor(async () => heartbeatRegistrations === 2 && service.snapshot().state === "error");
    assert.equal(activeTimers.size, activeBeforeRefresh, "刷新必须先撤销旧截图计时器");
    assert.equal(service.snapshot().screenRecordingGranted, false, "新进程再次退出后必须重新独立验证权限");
    service.handlePowerEvent("lock-screen");
    await waitFor(async () => service.snapshot().currentSessionId === undefined);
    heartbeat();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(snapshotCount(), 1);
    service.handlePowerEvent("unlock-screen");
    heartbeat();
    await waitFor(async () => snapshotCount() === 2);
    settings = { ...settings, enabled: false };
    await service.refresh();
    assert.equal(service.snapshot().state, "paused");
    heartbeat();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(snapshotCount(), 2);
    await service.stop();
    heartbeat();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(snapshotCount(), 2);
  } finally {
    await service.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testMissingOcrBinaryKeepsCadence(): Promise<void> {
  // Given: OCR 可执行文件暂缺；When: 已保存帧达到 N 后恢复可执行文件；
  // Then: 下一张保存帧立即补做 OCR，不把未运行的 OCR 当成一次完成。
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-ocr-missing-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='stop')process.exit(0);if(command.type==='start')console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));});\n`, {mode:0o700});
  const callbacks = new Map<number, () => void>();
  const settings = { ...defaultActivitySettings, outputDirectory:path.join(root,"records"), captureDebounceMs:1, ocrEveryNFrames:2 };
  const service = new ActivityRecorderService({
    agentDir:root,
    configStore:{load:async()=>({...defaultConfig,activity:settings})} as AgentConfigStore,
    inputMonitorPath,
    captureDesktopScreen:async()=>Buffer.from("jpeg"),
    encodeFrame:async jpeg=>({jpeg,width:1,height:1,pixels:Buffer.from([0,0,0,255])}),
    captureTimers:{
      setInterval:((callback:()=>void,ms:number)=>{callbacks.set(ms,callback);return{unref(){}};}) as unknown as typeof setInterval,
      clearInterval:()=>undefined
    }
  });
  let database:DatabaseSync|undefined;
  try {
    await service.initialize();
    database=new DatabaseSync(path.join(root,"agent.sqlite"));
    await waitFor(async()=>service.snapshot().screenRecordingGranted);
    const snapshots=()=>Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n);
    for (let expected=1;expected<=2;expected++) {
      callbacks.get(settings.heartbeatMs)!();
      await waitFor(async()=>snapshots()===expected);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_ocr_frames").get()!.n,0);
    await writeFile(path.join(root,"activity-ocr"),`#!${process.execPath}\nconsole.log('recovered OCR');\n`,{mode:0o700});
    callbacks.get(settings.heartbeatMs)!();
    await waitFor(async()=>snapshots()===3);
    await waitFor(async()=>Number(database!.prepare("SELECT COUNT(*) AS n FROM activity_ocr_frames").get()!.n)===1);
  } finally {
    await service.stop();
    database?.close();
    await rm(root,{recursive:true,force:true});
  }
}

async function testFailedSnapshotDoesNotAdvanceOcrCadence(): Promise<void> {
  // Given: 首次截图的数据库插入失败；When: 后续两次截图成功；
  // Then: 第 2 张已保存截图才触发 OCR，失败帧不进入计数。
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-ocr-cadence-"));
  const inputMonitorPath = path.join(root, "activity-input-monitor");
  await writeFile(inputMonitorPath, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const command=JSON.parse(line);if(command.type==='stop')process.exit(0);if(command.type==='start')console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));});\n`, { mode: 0o700 });
  await writeFile(path.join(root, "activity-ocr"), `#!${process.execPath}\nconsole.log('cadence OCR result');\n`, { mode: 0o700 });
  const callbacks = new Map<number, () => void>();
  const settings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), captureDebounceMs: 3000, ocrEveryNFrames: 2 };
  const service = new ActivityRecorderService({
    agentDir: root,
    configStore: { load: async () => ({ ...defaultConfig, activity: settings }) } as AgentConfigStore,
    inputMonitorPath,
    captureDesktopScreen: async () => Buffer.from("jpeg"),
    encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
    captureTimers: {
      setInterval: ((callback: () => void, ms: number) => { callbacks.set(ms, callback); return { unref() {} }; }) as unknown as typeof setInterval,
      clearInterval: () => undefined
    }
  });
  let database: DatabaseSync | undefined;
  try {
    await service.initialize();
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    await waitFor(async () => service.snapshot().screenRecordingGranted);
    const snapshots = () => database!.prepare("SELECT id FROM activity_snapshots ORDER BY timestamp, rowid").all() as Array<{ id: string }>;
    database.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON activity_snapshots BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END");
    callbacks.get(settings.heartbeatMs)!();
    await waitFor(async () => service.snapshot().state === "error");
    assert.equal(snapshots().length, 0);
    database.exec("DROP TRIGGER fail_capture");
    // debounce 从 capture 真正开始计时；满载时回调执行可能晚于上面记录的时刻。
    // 持续模拟 heartbeat，直到观察到持久化结果，避免唯一一次触发恰好落在 debounce 内。
    const captureUntilSaved = async (count: number): Promise<void> => {
      await waitFor(async () => {
        if (snapshots().length >= count) return true;
        callbacks.get(settings.heartbeatMs)!();
        return false;
      });
    };
    await captureUntilSaved(1);
    await captureUntilSaved(2);
    await waitFor(async () => Boolean(database!.prepare("SELECT id FROM activity_ocr_frames LIMIT 1").get()));
    const ocr = database.prepare("SELECT snapshot_id FROM activity_ocr_frames").all() as Array<{ snapshot_id: string }>;
    assert.deepEqual(ocr.map(row => row.snapshot_id), [snapshots()[1]!.id]);
  } finally {
    await service.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testRecorderResumesAfterExternalClear(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-external-clear-"));
  const inputMonitorPath = path.join(root, "sidecar.mjs");
  const startsPath = path.join(root, "starts.jsonl");
  const triggerPath = path.join(root, "trigger");
  await writeFile(inputMonitorPath, `#!${process.execPath}
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
  const service = new ActivityRecorderService({ agentDir: root, configStore: { load: async () => config } as AgentConfigStore, inputMonitorPath });
  const externalStore = new ActivityStore();
  let database: DatabaseSync | undefined;
  try {
    await service.initialize();
    await externalStore.open(config.activity.outputDirectory, root);
    database = new DatabaseSync(path.join(root, "agent.sqlite"));
    const applications = (): string[] => (database!.prepare("SELECT app_name AS application FROM activity_events").all() as Array<{ application: string }>).map((row) => row.application);
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

// 主进程收到输入事件后调用独立截图 daemon 与 OCR，落入同一真实 SQLite。
{
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-native-stack-"));
  const input = path.join(root, "activity-input-monitor");
  await writeFile(input, `#!${process.execPath}
import { createInterface } from 'node:readline';
import {existsSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({input: process.stdin}).on('line', line => {
 const command = JSON.parse(line);
 if (command.type === 'stop') process.exit(0);
 if (command.type === 'start') {
  send({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true});
  send({type:'event',eventType:'app_focus',occurredAt:new Date().toISOString(),application:'Editor'});
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(path.join(root,'ocr-started'))})) {
    clearInterval(timer);send({type:'event',eventType:'app_focus',occurredAt:new Date().toISOString(),application:'Browser'});send({type:'status',status:'running',screenRecordingGranted:false,accessibilityGranted:true});
  }},10);
 }
});
`, {mode: 0o700});
  await writeFile(path.join(root, "computer-use"), `#!${process.execPath}
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const server = createServer(socket => {
 socket.on('data', data => {
  const request = JSON.parse(data.toString());
  writeFileSync(request.args.out, 'native-jpeg');
  socket.write(JSON.stringify({id:request.id,ok:true,data:{path:request.args.out}}) + '\\n');
 });
});
server.listen(process.argv[process.argv.indexOf('--socket')+1], () => console.log('ready'));
`, {mode: 0o700});
  await writeFile(path.join(root, "activity-ocr"), `#!${process.execPath}
import {writeFileSync,existsSync} from 'node:fs';
writeFileSync(${JSON.stringify(path.join(root,'ocr-started'))}, 'ready');
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(path.join(root,'ocr-release'))})) {clearInterval(timer);console.log('independent OCR evidence');}},10);
`, {mode:0o700});
  const config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), ocrEveryNFrames: 1 } };
  const service = new ActivityRecorderService({ agentDir: root,
    configStore: { load: async () => config } as AgentConfigStore, inputMonitorPath: input,
    captureDesktopScreen: async () => { throw new Error("native should succeed"); },
    encodeFrame: async jpeg => ({jpeg, width:2, height:1, pixels:Buffer.from([0,0,0,255,255,255,255,255])})
  });
  const store = new ActivityStore();
  try {
    await service.initialize();
    await store.open(config.activity.outputDirectory, root);
    await waitFor(async () => store.snapshot().events === 2);
    await writeFile(path.join(root,"ocr-release"), "release");
    await waitFor(async () => store.search("independent OCR").length === 1);
    assert.equal(store.snapshot().events, 2, "截图不再创建占位事件");
    assert.equal(store.snapshot().fallbackCaptures, 1);
    const sessionId = store.snapshot().recentSessions[0]!.id;
    const detail = await handleActivityHttpRequest(
      {method:"GET",pathname:`/api/activity-recorder/sessions/${sessionId}`},
      {agentDir:root,loadSettings:async()=>config.activity}
    );
    const histogram = (detail.body as {snapshots:Array<{histogram:number[]|null}>}).snapshots[0]?.histogram;
    const expectedHistogram = Array<number>(32).fill(0);
    expectedHistogram[0] = 0.5;
    expectedHistogram[31] = 0.5;
    assert.deepEqual(histogram, expectedHistogram, "采集缩略图的 32 档直方图须穿过 SQLite 到 HTTP 详情");
  } finally { await service.stop(); await store.close(); await rm(root, {recursive:true, force:true}); }
}

// 切换应用和锁屏必须先落盘上一段按键，不能合并跨应用输入或在锁屏后新建 session。
{
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-key-boundary-"));
  const input = path.join(root, "activity-input-monitor");
  await writeFile(input, `#!${process.execPath}
import { createInterface } from 'node:readline';
createInterface({input: process.stdin}).on('line', line => {
 const command = JSON.parse(line);
 if (command.type === 'stop') process.exit(0);
 if (command.type === 'start') {
  for (const [eventType, application] of [['keypress','App A'], ['app_focus','App B'], ['keypress','App B'], ['lock','App B']])
   console.log(JSON.stringify({type:'event',eventType,application,occurredAt:new Date().toISOString(),inputEventCount:1}));
 }
});
`, {mode: 0o700});
  const config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: path.join(root, "records") } };
  const service = new ActivityRecorderService({ agentDir: root,
    configStore: { load: async () => config } as AgentConfigStore, inputMonitorPath: input });
  let db: DatabaseSync | undefined;
  try {
    await service.initialize();
    db = new DatabaseSync(path.join(root, "agent.sqlite"));
    await waitFor(async () => Boolean(db!.prepare("SELECT id FROM activity_events WHERE kind = 'lock'").get()));
    const keys = db.prepare("SELECT app_name, data FROM activity_events WHERE kind = 'keypress' ORDER BY rowid").all();
    assert.deepEqual(keys.map(row => row.app_name), ['App A', 'App B']);
    assert.deepEqual(keys.map(row => JSON.parse(String(row.data)).count), [1, 1]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_sessions").get()!.n, 1);
  } finally { await service.stop(); db?.close(); await rm(root, {recursive:true, force:true}); }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("备用截图协议未到达预期状态");
}

// 原生二进制缺失时 capture 可降级，随后停止不能等待一个永远不会发出 exit 的 spawn。
{
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-missing-native-"));
  const native = new ActivityNativeClient(root, root);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(native.capture(2560, 55), { code: "ENOENT" });
    await Promise.race([
      native.stop(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("停止缺失的 daemon 超时")), 1500); })
    ]);
  } finally { clearTimeout(timeout); await rm(root, {recursive:true, force:true}); }
}

// 连续输入不等待 typing pause：第 40 个键立刻成为一条持久事件。
{
 const root=await mkdtemp(path.join(os.tmpdir(),'biny-key-batch-'));
 const input=path.join(root,'input');
 await writeFile(input, `#!${process.execPath}
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.type==='stop')process.exit(0);if(c.type==='start')for(let i=0;i<45;i++)console.log(JSON.stringify({type:'event',eventType:'keypress',occurredAt:new Date().toISOString(),application:'Editor',inputEventCount:1}));});
`,{mode:0o700});
 const config={...defaultConfig,activity:{...defaultActivitySettings,outputDirectory:path.join(root,'records')}};
 const service=new ActivityRecorderService({agentDir:root,configStore:{load:async()=>config} as AgentConfigStore,inputMonitorPath:input});
 let db:DatabaseSync|undefined;
 try {await service.initialize();db=new DatabaseSync(path.join(root,'agent.sqlite'));
 await waitFor(async()=>Boolean(db!.prepare('SELECT id FROM activity_events LIMIT 1').get()));
 const rows=db.prepare('SELECT data FROM activity_events ORDER BY rowid').all();
 assert.equal(JSON.parse(String(rows[0]!.data)).count,40);
 service.handlePowerEvent('suspend');
 await waitFor(async()=>Boolean(db!.prepare("SELECT id FROM activity_events WHERE kind='lock'").get()));
 assert.equal((JSON.parse(String(db.prepare("SELECT data FROM activity_events WHERE kind='lock'").get()!.data)) as {via?: string}).via,
   'powerMonitor');
 assert.equal(service.snapshot().currentSessionId,undefined);
 service.handlePowerEvent('resume');
 assert.equal(service.snapshot().screenLocked,false);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='unlock'").get()!.n,0,
   'powerMonitor resume does not impersonate an input listener unlock');
 }finally{await service.stop();db?.close();await rm(root,{recursive:true,force:true});}
}
