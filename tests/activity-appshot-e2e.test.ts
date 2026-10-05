import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { AgentConfigStore } from "../src/config/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-appshot-e2e-"));
const input = path.join(root, "activity-input-monitor");
await writeFile(input, `#!${process.execPath}
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
 const command=JSON.parse(line); if(command.type==='stop')process.exit(0);
 if(command.type==='start')console.log(JSON.stringify({type:'status',status:'running',screenRecordingGranted:true,accessibilityGranted:true}));
});
`, { mode: 0o700 });
await writeFile(path.join(root, "computer-use"), `#!${process.execPath}
import {createServer} from 'node:net';import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
const server=createServer(socket=>createInterface({input:socket}).on('line', line=>{
 const q=JSON.parse(line);if(q.cmd!=='appshot_capture')throw new Error('expected window capture');
 const file=${JSON.stringify(path.join(root, "frame.jpg"))};writeFileSync(file,'window-frame');
 socket.write(JSON.stringify({id:q.id,ok:true,data:{path:file,bundleId:q.args.expected_bundle}})+'\\n');
}));server.listen(process.argv[process.argv.indexOf('--socket')+1],()=>console.log('ready'));
`, { mode: 0o700 });
let frontmost = "com.example.editor";
const service = new ActivityRecorderService({
  agentDir: root, inputMonitorPath: input, readFrontmostBundle: async () => frontmost,
  configStore: { load: async () => ({ ...defaultConfig, activity: { ...defaultActivitySettings, appshotHotkey: "Control+Alt+C", ocrEnabled: false, outputDirectory: path.join(root, "records"), sensitiveApplications: ["com.example.private"] } }) } as AgentConfigStore,
  captureDesktopScreen: async () => { throw new Error("manual capture must not reach desktop fallback"); },
  encodeFrame: async jpeg => ({ jpeg, width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }),
  captureTimers: { setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval, clearInterval: () => undefined }
});
let database: DatabaseSync | undefined;
try {
  await service.initialize();
  const deadline = Date.now() + 5000;
  while (!service.snapshot().screenRecordingGranted) {
    assert.ok(Date.now() < deadline, "input fixture did not report permissions");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  await service.captureAppshot();
  const captureDeadline = Date.now() + 5000;
  while (database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n === 0) {
    assert.ok(Date.now() < captureDeadline, "registered manual capture did not persist");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n, 1);
  frontmost = "com.example.private";
  await service.captureAppshot();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n, 1, "excluded apps must not reach the daemon or storage");
  await service.stop();
  await service.captureAppshot();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()!.n, 1, "stopped recording cannot be restarted by a manual capture");
} finally { await service.stop(); database?.close(); await rm(root, { recursive: true, force: true }); }
