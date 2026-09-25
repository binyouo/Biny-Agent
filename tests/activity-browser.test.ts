import assert from "node:assert/strict";
import { activityBrowserScript, parseActivityBrowserOutput } from "../src/desktop/electron/main/ActivityRecorderService.js";
for (const bundle of ['com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'com.google.Chrome', 'com.google.Chrome.canary', 'com.google.Chrome.beta', 'com.microsoft.edgemac', 'com.brave.Browser', 'com.brave.Browser.beta', 'company.thebrowser.Browser', 'com.thebrowser.dia', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera']) assert.ok(activityBrowserScript(bundle), bundle);
assert.equal(activityBrowserScript('unknown'), undefined);
assert.deepEqual(parseActivityBrowserOutput('https://example.test/page\tPage title\n'), { url: 'https://example.test/page', title: 'Page title' });
assert.equal(parseActivityBrowserOutput('file:///private/file\tPrivate'), undefined);

// 真实输入进程 + SQLite，浏览器 OS 边界和轮询时钟可控；同一 URL 改标题必须写两类事件。
const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
const os=await import('node:os');const path=await import('node:path');
const {DatabaseSync}=await import('node:sqlite');
const {ActivityRecorderService}=await import('../src/desktop/electron/main/ActivityRecorderService.js');
const {defaultConfig}=await import('../src/config/schema.js');
const root=await mkdtemp(path.join(os.tmpdir(),'biny-browser-record-'));
const input=path.join(root,'input');
await writeFile(input,`#!${process.execPath}
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.type==='stop')process.exit(0);if(c.type==='start')console.log(JSON.stringify({type:'event',eventType:'app_focus',occurredAt:new Date().toISOString(),bundleId:'company.thebrowser.Browser',application:'Arc'}));});
`,{mode:0o700});
const callbacks=new Map<number,()=>void>();
let output='https://example.test/page\tTitle 1';
const config={...defaultConfig,activity:{...defaultConfig.activity,enabled:true,outputDirectory:path.join(root,'records')}};
const service=new ActivityRecorderService({agentDir:root,inputMonitorPath:input,
 configStore:{load:async()=>config} as import('../src/config/store.js').AgentConfigStore,
 readBrowser:async script=>{assert.match(script,/Arc/u);return output;},
 captureTimers:{setInterval:((callback:()=>void,ms:number)=>{callbacks.set(ms,callback);return {unref(){}};}) as unknown as typeof setInterval,clearInterval:()=>{}}
});
let db:InstanceType<typeof DatabaseSync>|undefined;
async function until(predicate:()=>boolean):Promise<void>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)assert.fail('browser event timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
try{
 await service.initialize();db=new DatabaseSync(path.join(root,'agent.sqlite'));
 await until(()=>Boolean(db!.prepare('SELECT id FROM activity_events LIMIT 1').get()));
 const count=()=>Number(db!.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='browser_visit'").get()!.n);
 callbacks.get(config.activity.browserPollIntervalMs)!();await until(()=>count()===1);
 output='https://example.test/page\tTitle 2';
 callbacks.get(config.activity.browserPollIntervalMs)!();await until(()=>count()===2);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='window_title'").get()!.n,2);
 assert.deepEqual(db.prepare("SELECT data FROM activity_events WHERE kind='window_title' ORDER BY rowid").all().map(row=>JSON.parse(String(row.data)).title),['Title 1','Title 2']);
}finally{await service.stop();db?.close();await rm(root,{recursive:true,force:true});}
