/** 真实子进程与 SQLite 验证备用截图协议；不访问用户屏幕，也不申请系统权限。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityNativeClient } from "../src/desktop/electron/main/ActivityNativeClient.js";
import { ActivityStore } from "../src/activity/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

await testRecorderResumesAfterExternalClear();

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
 assert.equal(service.snapshot().currentSessionId,undefined);
 service.handlePowerEvent('resume');
 await waitFor(async()=>Boolean(db!.prepare("SELECT id FROM activity_events WHERE kind='unlock'").get()));
 }finally{await service.stop();db?.close();await rm(root,{recursive:true,force:true});}
}
