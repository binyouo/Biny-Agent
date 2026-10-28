import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Appshots } from "../src/computer/appshots.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { AppshotEvent } from "../src/computer/appshotsProtocol.js";

test("a native context event delivered before the manual capture reply stays with its image", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshot-early-event-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const driver = new NativeProcessDriver(() => undefined);
  let receive: ((event: string, raw: unknown) => void) | undefined;
  driver.onNativeEvent = listener => { receive = listener; return () => { receive = undefined; }; };
  driver.daemonCommand = async (cmd, args) => {
    assert.equal(cmd, "appshot_capture"); assert.equal(args?.async_context, true);
    receive?.("appshot", { type: "context", id: args?.appshot_id, data: { axText: "early private text" } });
    return { data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, axPending: true }, images: [] };
  };
  const events: AppshotEvent[] = [];
  const appshots = new Appshots(driver, { load: async () => structuredClone(defaultConfig) } as AgentConfigStore, event => events.push(event));
  try {
    assert.equal((await appshots.capture()).error, undefined);
    const captured = events.find(event => event.type === "captured"); assert.ok(captured && captured.type === "captured");
    const attachment = await appshots.take(captured.id);
    assert.equal(JSON.parse(attachment.context).accessibility, "early private text");
    assert.equal(JSON.stringify(events).includes("early private text"), false);
    attachment.bytes.fill(0);
  } finally { await appshots.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an explicit Appshot works with history disabled, retains source context and consumes its private capture once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshots-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const config = structuredClone(defaultConfig); config.activity.enabled = false; config.appshots.target = "new";
  const store = { load: async () => config } as AgentConfigStore;
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async (cmd, args) => { assert.equal(cmd, "appshot_capture"); assert.equal(args?.include_ax, true); return { data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, axText: "selected source text", frame: { x: 10, y: 20, w: 300, h: 200 }, appIcon: "data:image/png;base64,aWNvbg==" }, images: [] }; };
  const events: AppshotEvent[] = []; let visual: { bytes: string; frame: unknown; icon?: string } | undefined;
  const appshots = new Appshots(driver, store, (event, feedback) => { events.push(event); if (feedback?.type === "captured") visual = { bytes: feedback.bytes.toString(), frame: feedback.frame, icon: feedback.icon }; });
  try {
    const state = await appshots.capture(); assert.equal(state.error, undefined);
    const fired = events.find(event => event.type === "captured"); assert.ok(fired && fired.type === "captured");
    assert.deepEqual(visual, { bytes: "pixels", frame: { x: 10, y: 20, w: 300, h: 200 }, icon: "data:image/png;base64,aWNvbg==" });
    assert.equal("frame" in fired.source, false, "animation geometry stays out of the renderer event");
    assert.equal(fired.target, "new"); assert.equal(fired.source.bundleId, "test.notes");
    const attachment = await appshots.take(fired.id);
    assert.equal(attachment.bytes.toString(), "pixels"); assert.match(attachment.context, /selected source text/); assert.match(attachment.context, /test.notes/);
    await assert.rejects(stat(image), { code: "ENOENT" });
    await assert.rejects(appshots.take(fired.id), /appshot_capture_expired/);
  } finally { await appshots.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an Appshot keeps an accessibility timeout in its private context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshots-timeout-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const store = { load: async () => structuredClone(defaultConfig) } as AgentConfigStore;
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, axError: "accessibility_timeout" }, images: [] });
  const events: AppshotEvent[] = []; const appshots = new Appshots(driver, store, event => events.push(event));
  try {
    const state = await appshots.capture(); assert.equal(state.error, undefined);
    const fired = events.find(event => event.type === "captured"); assert.ok(fired && fired.type === "captured");
    const attachment = await appshots.take(fired.id);
    assert.equal(attachment.bytes.toString(), "pixels");
    assert.equal(JSON.parse(attachment.context).accessibilityError, "accessibility_timeout");
    assert.equal(JSON.parse(attachment.context).accessibility, "");
  } finally { await appshots.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an invalid source icon is omitted without losing the screenshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshot-icon-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, frame: { x: 10, y: 20, w: 300, h: 200 }, appIcon: "javascript:untrusted" }, images: [] });
  const events: AppshotEvent[] = []; let icon: string | undefined = "not delivered";
  const appshots = new Appshots(driver, { load: async () => structuredClone(defaultConfig) } as never, (event, feedback) => { events.push(event); if (feedback?.type === "captured") icon = feedback.icon; });
  try {
    assert.equal((await appshots.capture()).error, undefined);
    assert.equal(icon, undefined);
    const captured = events.find(event => event.type === "captured"); assert.ok(captured && captured.type === "captured");
    const attachment = await appshots.take(captured.id); assert.equal(attachment.bytes.toString(), "pixels"); attachment.bytes.fill(0);
  } finally { await appshots.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an Appshot retains partial accessibility text and its warning together", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-appshots-partial-"));
  const image = path.join(dir, "appshot.jpg"); await writeFile(image, "pixels", { mode: 0o600 });
  const store = { load: async () => structuredClone(defaultConfig) } as AgentConfigStore;
  const driver = new NativeProcessDriver(() => undefined);
  driver.daemonCommand = async () => ({ data: { path: image, appName: "Notes", bundleId: "test.notes", pid: 12, windowId: 42, axText: "known branch", axError: "accessibility_tree_incomplete: 1 个分支读取失败" }, images: [] });
  const events: AppshotEvent[] = []; const appshots = new Appshots(driver, store, event => events.push(event));
  try {
    const state = await appshots.capture(); assert.equal(state.error, undefined);
    const fired = events.find(event => event.type === "captured"); assert.ok(fired && fired.type === "captured");
    const attachment = await appshots.take(fired.id);
    const context = JSON.parse(attachment.context);
    assert.equal(attachment.bytes.toString(), "pixels");
    assert.equal(context.accessibility, "known branch");
    assert.match(context.accessibilityError, /accessibility_tree_incomplete/);
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

test("native monitor events deliver an attachment and resume after a helper restart", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { createFileConfigStore, updateConfig } = await import("../src/config/store.js");
  const root = await mkdtemp("/tmp/biny-appshot-events-");
  const binary = path.join(root, "native-fixture.mjs");
  const capturePath = path.join(root, "capture.jpg");
  const eventId = "12345678-1234-4234-8234-123456789abc";
  await writeFile(binary, `#!/usr/bin/env node
import {createServer} from 'node:net'; import {createInterface} from 'node:readline'; import {writeFileSync,unlinkSync} from 'node:fs';
let armed=false;
const server=createServer(socket=>createInterface({input:socket}).on('line',line=>{
  const q=JSON.parse(line);
  if(q.cmd==='appshot_monitor_start') armed=true;
  if(q.cmd==='appshot_monitor_stop') armed=false;
  socket.write(JSON.stringify({id:q.id,ok:true,data:{armed,live:armed,owned:armed,hotkey:armed?'double-cmd':''}})+'\\n');
  if(q.cmd==='appshot_monitor_start') {
    writeFileSync(${JSON.stringify(capturePath)},'private pixels',{mode:0o600});
    for(const event of [{type:'starting',id:${JSON.stringify(eventId)}},{type:'captured',id:${JSON.stringify(eventId)},data:{path:${JSON.stringify(capturePath)},bundleId:'test.notes',appName:'Notes',pid:12,windowId:42,axText:'native hidden context'}}]) socket.write(JSON.stringify({event:'appshot',data:event})+'\\n');
  }
}));
const socketPath=process.argv[process.argv.indexOf('--socket')+1];
try { unlinkSync(socketPath); } catch(error) { if(error.code!=='ENOENT') throw error; }
server.listen(socketPath,()=>console.log('ready'));
`, { mode: 0o700 });
  const driver = new NativeProcessDriver(() => undefined, { binaryPath: binary, socketDir: root });
  const store = createFileConfigStore(root, { globalDir: root });
  await updateConfig(store, undefined, config => ({ ...config, appshots: { hotkey: "double-cmd", target: "current" } }));
  let complete!: (value: AppshotEvent) => void;
  const event = new Promise<AppshotEvent>(resolve => { complete = resolve; });
  let hotkeyCues = 0;
  const appshots = new Appshots(driver, store, (value, cue) => { if (cue?.type === "hotkey") hotkeyCues++; if (value.type === "captured" || value.type === "failed") complete(value); });
  // Appshots.close intentionally detaches a shared daemon. This private fixture
  // retains its own child handle so teardown never relies on the job runner.
  type Exit = { code: number | null; signal: NodeJS.Signals | null } | { spawnError: Error };
  const owned: Array<{ child: ChildProcess; exit: Promise<Exit>; result?: Exit }> = [];
  const originalSpawn = childProcess.spawn;
  const spawnObserver = mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args);
    if (args[0] === binary) {
      let settle!: (result: Exit) => void;
      const entry: (typeof owned)[number] = { child, exit: new Promise(resolve => { settle = resolve; }) };
      owned.push(entry);
      child.once("exit", (code, signal) => { entry.result = { code, signal }; settle(entry.result); });
      child.once("error", error => {
        // A failed spawn has no process and is not guaranteed to emit exit.
        if (child.pid === undefined) { entry.result = { spawnError: error }; settle(entry.result); }
      });
    }
    return child;
  });
  syncBuiltinESMExports();
  const waitForExit = async (entry: (typeof owned)[number]): Promise<Exit | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.exit,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const finishOwnedFixture = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const entry of owned) {
      try {
        if (entry.result) continue;
        // Use the actual ChildProcess, never a remembered numeric PID. killed
        // means a signal was requested; only observed exit completes teardown.
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGTERM");
        if (!await waitForExit(entry)) {
          if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
          assert.ok(await waitForExit(entry), "private Appshots fixture did not exit after owner cleanup");
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Private Appshots fixture cleanup failed");
  };
  const errors: unknown[] = [];
  let heartbeat: (() => void) | undefined;
  const originalInterval = globalThis.setInterval;
  const heartbeatObserver = mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
    if (args[1] === 60_000) heartbeat = () => args[0](...args.slice(2));
    return originalInterval(...args);
  });
  try {
    const ready = await appshots.prewarm(); assert.equal(ready.active, true, JSON.stringify(ready)); const timeout = setTimeout(() => complete({ type: "failed", id: eventId, error: "fixture_timeout" }), 3000);
    const captured = await event; clearTimeout(timeout); assert.equal(captured.type, "captured", JSON.stringify(captured));
    const attachment = await appshots.take(eventId); assert.equal(attachment.bytes.toString(), "private pixels"); assert.match(attachment.context, /native hidden context/);
    await assert.rejects(readFile(capturePath), { code: "ENOENT" });
    const afterRestart = new Promise<AppshotEvent>(resolve => { complete = resolve; });
    assert.equal(owned.length, 1);
    owned[0]!.child.kill("SIGTERM");
    assert.ok(await waitForExit(owned[0]!), "the original helper did not exit");
    const deadline = Date.now() + 4_000;
    let status: Awaited<ReturnType<typeof driver.daemonCommand>> | undefined;
    while (!status) {
      try { status = await driver.daemonCommand("appshot_status"); }
      catch (error) { if (Date.now() >= deadline) throw error; await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    assert.equal(status.data.live, false);
    assert.ok(heartbeat, "the active monitor must schedule its health check");
    heartbeat();
    const recoveryTimeout = setTimeout(() => complete({ type: "failed", id: eventId, error: "recovery_timeout" }), 4_000);
    const recovered = await afterRestart; clearTimeout(recoveryTimeout);
    assert.equal(recovered.type, "captured", JSON.stringify(recovered));
    assert.equal(hotkeyCues, 2, "each native hotkey capture announces its start once");
    const restored = await appshots.take(eventId);
    assert.equal(restored.bytes.toString(), "private pixels");
    assert.match(restored.context, /native hidden context/);
    await assert.rejects(readFile(capturePath), { code: "ENOENT" });
  } catch (error) { errors.push(error); }
  finally {
    try {
      await appshots.close();
      await driver.dispose();
      await finishOwnedFixture();
      assert.equal(owned.length, 2, "the real driver must spawn one replacement fixture after the crash");
      for (const entry of owned) {
        const exited = await waitForExit(entry);
        assert.ok(exited, "private Appshots fixture remains alive after teardown");
        assert.ok(!("spawnError" in exited), "the fixture must have actually started");
        assert.ok(entry.child.exitCode !== null || entry.child.signalCode !== null,
          "teardown must observe physical child exit, not merely signal dispatch");
      }
    } catch (error) { errors.push(error); }
    finally {
      try { await finishOwnedFixture(); } catch (error) { errors.push(error); }
      finally {
        spawnObserver.mock.restore();
        syncBuiltinESMExports();
        heartbeatObserver.mock.restore();
        try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Appshots fixture failed");
});
