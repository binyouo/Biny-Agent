/** 真实 daemon/socket 验证持久连接、共享连接地址和并发请求 ID 路由。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ActivityNativeClient } from '../src/desktop/electron/main/ActivityNativeClient.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'biny-native-client-'));
await writeFile(path.join(root, 'computer-use'), `#!${process.execPath}
import {createServer} from 'node:net';import {createInterface} from 'node:readline';import {appendFileSync,writeFileSync} from 'node:fs';
const server=createServer(socket=>{appendFileSync(${JSON.stringify(path.join(root, 'connections'))},'connected\\n');createInterface({input:socket}).on('line',line=>{const q=JSON.parse(line);if(q.cmd!=='shot_display')throw new Error('protocol');writeFileSync(q.args.out,String(q.args.max_width));socket.write(JSON.stringify({id:q.id,ok:true,data:{path:q.args.out}})+'\\n');});});
server.listen(process.argv[process.argv.indexOf('--socket')+1],()=>console.log('ready'));
`, { mode: 0o700 });
const first = new ActivityNativeClient(root, path.join(root, 'tmp'));
const second = new ActivityNativeClient(root, path.join(root, 'tmp'));
try {
  assert.equal((await first.capture(160, 40)).toString(), '160');
  const frames = await Promise.all([first.capture(100, 40), first.capture(200, 40)]);
  assert.deepEqual(frames.map(b => b.toString()), ['100', '200']);
  assert.equal((await readFile(path.join(root, 'connections'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await second.capture(2560, 55)).toString(), '2560');
  await second.stop();
  assert.equal((await first.capture(300, 40)).toString(), '300', '关闭借用方不杀死共享 daemon');
} finally { await second.stop(); await first.stop(); await rm(root, { recursive: true, force: true }); }
