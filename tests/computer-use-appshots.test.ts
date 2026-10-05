import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Appshots } from "../src/computer/appshots.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { AppshotEvent } from "../src/computer/appshotsProtocol.js";

test("an explicit Appshot works with history disabled, retains source context and consumes its private capture once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshots-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const config = structuredClone(defaultConfig); config.activity.enabled = false; config.appshots.target = "new";
  const store = { load: async () => config } as AgentConfigStore;
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async (cmd, args) => { assert.equal(cmd, "appshot_capture"); assert.equal(args?.include_ax, true); return { data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, axText: "selected source text" }, images: [] }; };
  const events: AppshotEvent[] = []; const appshots = new Appshots(driver, store, event => events.push(event));
  try {
    const state = await appshots.capture(); assert.equal(state.error, undefined);
    const fired = events.find(event => event.type === "captured"); assert.ok(fired && fired.type === "captured");
    assert.equal(fired.target, "new"); assert.equal(fired.source.bundleId, "test.notes");
    const attachment = await appshots.take(fired.id);
    assert.equal(attachment.bytes.toString(), "pixels"); assert.match(attachment.context, /selected source text/); assert.match(attachment.context, /test.notes/);
    await assert.rejects(stat(image), { code: "ENOENT" });
    await assert.rejects(appshots.take(fired.id), /appshot_capture_expired/);
  } finally { await appshots.close(); await rm(dir, { recursive: true, force: true }); }
});

test("application context rehydrates with the image and is absent from attachment references", async () => {
  const { saveAttachment, saveAttachmentContext, readAttachment, attachmentRoot, attachmentMessageParts } = await import("../src/attachments/store.js");
  const { configSchema } = await import("../src/config/schema.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-appshot-context-"));
  try {
    const reference = await saveAttachment(root, "Notes.jpg", "image/jpeg", Buffer.from("pixels"));
    await saveAttachmentContext(attachmentRoot(root), reference.path, "private application context");
    assert.doesNotMatch(JSON.stringify(reference), /private application context/);
    const hydrated = await readAttachment(root, reference); assert.ok(hydrated);
    assert.match(JSON.stringify(attachmentMessageParts([hydrated])), /untrusted source data.*private application context/s);
    const migrated = configSchema.parse({ ...defaultConfig, appshots: undefined, activity: { ...defaultConfig.activity, appshotHotkey: "Control+Alt+C" } });
    assert.equal(migrated.appshots.hotkey, "Control+Alt+C");
    assert.equal("appshotHotkey" in migrated.activity, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native monitor events deliver a chat attachment through the actual process protocol", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { createFileConfigStore, updateConfig } = await import("../src/config/store.js");
  const root = await mkdtemp("/tmp/biny-appshot-events-");
  const binary = path.join(root, "native-fixture.mjs");
  const capturePath = path.join(root, "capture.jpg");
  const eventId = "12345678-1234-4234-8234-123456789abc";
  await writeFile(binary, `#!/usr/bin/env node
import {createServer} from 'node:net'; import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
const server=createServer(socket=>createInterface({input:socket}).on('line',line=>{
  const q=JSON.parse(line); socket.write(JSON.stringify({id:q.id,ok:true,data:{armed:true,live:true}})+'\\n');
  if(q.cmd==='appshot_monitor_start') {
    writeFileSync(${JSON.stringify(capturePath)},'private pixels',{mode:0o600});
    for(const event of [{type:'starting',id:${JSON.stringify(eventId)}},{type:'captured',id:${JSON.stringify(eventId)},data:{path:${JSON.stringify(capturePath)},bundleId:'test.notes',appName:'Notes',pid:12,windowId:42,axText:'native hidden context'}}]) socket.write(JSON.stringify({event:'appshot',data:event})+'\\n');
  }
})); server.listen(process.argv[process.argv.indexOf('--socket')+1],()=>console.log('ready'));
`, { mode: 0o700 });
  const driver = new NativeProcessDriver(() => undefined, { binaryPath: binary, socketDir: root });
  const store = createFileConfigStore(root, { globalDir: root });
  await updateConfig(store, undefined, config => ({ ...config, appshots: { hotkey: "double-cmd", target: "current" } }));
  let complete!: (value: AppshotEvent) => void;
  const event = new Promise<AppshotEvent>(resolve => { complete = resolve; });
  const appshots = new Appshots(driver, store, value => { if (value.type === "captured" || value.type === "failed") complete(value); });
  try {
    const ready = await appshots.prewarm(); assert.equal(ready.active, true, JSON.stringify(ready)); const timeout = setTimeout(() => complete({ type: "failed", id: eventId, error: "fixture_timeout" }), 3000);
    const captured = await event; clearTimeout(timeout); assert.equal(captured.type, "captured", JSON.stringify(captured));
    const attachment = await appshots.take(eventId); assert.equal(attachment.bytes.toString(), "private pixels"); assert.match(attachment.context, /native hidden context/);
    await assert.rejects(readFile(capturePath), { code: "ENOENT" });
  } finally { await appshots.close(); await driver.dispose(); await rm(root, { recursive: true, force: true }); }
});
