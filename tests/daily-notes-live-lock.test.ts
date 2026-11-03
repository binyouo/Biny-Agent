import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

import * as api from "../src/activity/dailyNotes.js";
import { withLocalFileWriteLock } from "../src/utils/localFileLock.js";
const date='2026-10-30';
if (process.argv[2] === "--daily-note-legacy-worker") {
  const root = process.argv[3]!;
  const directory = path.join(root, "memory");
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `${date}.md.lock`);
  const handle = await fs.open(lockPath, "wx", 0o600);
  const gate = new Promise<void>(resolve => process.once("message", () => resolve()));
  process.send!("locked-and-read");
  await gate;
  await fs.writeFile(path.join(directory, `${date}.md`), `# ${date}\n\n## 聊天摘要\n\nLegacy committed\n`);
  await handle.close();
  await fs.rm(lockPath, { force: true });
  process.disconnect!();
} else if(process.argv[2]==='--daily-note-lock-worker') {
  let checks=0;
  const gate=new Promise<void>(resolve=>process.once('message',()=>resolve()));
  await api.writeDailyActivityNote(date,'Activity A committed',{
    configDir:process.argv[3]!,checkpoint:async()=>{
      if(++checks===2){process.send!('locked-and-read');await gate;}
    }
  });
  process.send!('written');process.disconnect!();
} else {
  const children = new Map<string, ChildProcess[]>();
  async function fixture(t: TestContext) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'biny-daily-owner-'));
    children.set(root, []);
    t.after(async () => {
      for (const child of children.get(root) ?? []) {
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise(resolve => child.once("exit", resolve));
          child.kill();
          await done;
        }
      }
      await fs.rm(root, { recursive: true, force: true });
      children.delete(root);
    });
    return root;
  }
  async function writer(root: string, legacy = false) {
    const child=fork(fileURLToPath(import.meta.url),[legacy ? '--daily-note-legacy-worker' : '--daily-note-lock-worker',root],{stdio:['ignore','inherit','inherit','ipc']});
    children.get(root)!.push(child);
    await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('early exit '+code)));});
    return child;
  }
  async function release(child: ChildProcess) {
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    child.send("release");
    assert.equal(await exited, 0);
  }
  test('live aged lock is not stolen; timeout leaves note intact; retry preserves both sections',{timeout:20000},async t=>{
    const root=await fixture(t);
    await api.appendDailyMemoryEntry(date,'聊天摘要','existing','Existing chat',{configDir:root});
    const original=await api.readDailyMemoryNote(date,{configDir:root});
    const child=await writer(root);
    // Real marker metadata only; no product clocks, filesystem functions or locks mocked.
    await fs.utimes(path.join(root,'memory',date+'.md.lock'),new Date(0),new Date(0));
    await assert.rejects(api.appendDailyMemoryEntry(date,'聊天摘要','turn-B','Chat B committed',{configDir:root}),/Timed out/);
    assert.equal(await api.readDailyMemoryNote(date,{configDir:root}),original);
    await release(child);
    await api.appendDailyMemoryEntry(date,'聊天摘要','turn-B','Chat B committed',{configDir:root});
    const final=await api.readDailyMemoryNote(date,{configDir:root});
    for(const text of ['Existing chat','Chat B committed','Activity A committed']) assert.ok(final?.includes(text),text);
  });
  test('independent days do not contend and killed owner is recoverable',{timeout:10000},async t=>{
    const root=await fixture(t);const child=await writer(root);
    await api.writeDailyActivityNote('2026-10-29','Other day',{configDir:root});
    assert.match((await api.readDailyMemoryNote('2026-10-29',{configDir:root}))!,/Other day/);
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
    await api.appendDailyMemoryEntry(date,'聊天摘要','recovery','Recovered',{configDir:root});
    assert.match((await api.readDailyMemoryNote(date,{configDir:root}))!,/Recovered/);
  });
  test('failed checkpoint releases ownership and preserves prior bytes',async t=>{
    const root=await fixture(t);await api.writeDailyActivityNote(date,'Original',{configDir:root});
    const original=await api.readDailyMemoryNote(date,{configDir:root});let checks=0;
    await assert.rejects(api.writeDailyActivityNote(date,'Rejected',{configDir:root,checkpoint:async()=>{if(++checks===3)throw new Error('cancelled');}}),/cancelled/);
    assert.equal(await api.readDailyMemoryNote(date,{configDir:root}),original);
    await api.appendDailyMemoryEntry(date,'聊天摘要','next','Next',{configDir:root});
    const names=await fs.readdir(path.join(root,'memory'));assert.ok(!names.some(n=>n.endsWith('.lock')||n.includes('.tmp-')));
  });
  test("fresh legacy empty marker is allowed to finish before the new writer", { timeout: 10000 }, async t => {
    const root = await fixture(t);
    const child = await writer(root, true);
    const marker = path.join(root, "memory", `${date}.md.lock`);
    const initialMtime = (await fs.stat(marker)).mtimeMs;
    const pending = api.writeDailyActivityNote(date, "New activity", { configDir: root });
    // Keep the real legacy owner alive briefly; the final contents detect early takeover.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fs.stat(marker)).mtimeMs, initialMtime);
    await release(child);
    await pending;
    const content = await api.readDailyMemoryNote(date, { configDir: root });
    assert.match(content!, /Legacy committed/);
    assert.match(content!, /New activity/);
  });
  test("abandoned aged empty marker is recovered", async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, "memory"));
    const marker = path.join(root, "memory", `${date}.md.lock`);
    await fs.writeFile(marker, "");
    await fs.utimes(marker, new Date(0), new Date(0));
    await api.writeDailyActivityNote(date, "Recovered legacy", { configDir: root });
    assert.match((await api.readDailyMemoryNote(date, { configDir: root }))!, /Recovered legacy/);
  });
  test("other helper callers retain immediate unowned-marker recovery", async t => {
    const root = await fixture(t);
    const marker = path.join(root, "other.lock");
    await fs.writeFile(marker, "");
    // Even a future timestamp must not activate a grace policy for default callers.
    await fs.utimes(marker, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    let called = false;
    await withLocalFileWriteLock(root, "other.lock", async () => { called = true; });
    assert.equal(called, true);
  });
  test('existing memory directory aliases still work',async t=>{
    const root=await fixture(t);await fs.mkdir(path.join(root,'actual'));await fs.symlink(path.join(root,'actual'),path.join(root,'memory'),process.platform === 'win32' ? 'junction' : 'dir');
    await api.writeDailyActivityNote(date,'Aliased',{configDir:root});
    assert.match(await fs.readFile(path.join(root,'actual',date+'.md'),'utf8'),/Aliased/);
  });
}
