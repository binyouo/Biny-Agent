import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

async function fixture(t: TestContext, delayStop = false, selfIdle?: "normal" | "crash" | "disconnect") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bcu-"));
  const binary = path.join(directory, "helper.cjs");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const dir = ${JSON.stringify(directory)};
const socketPath = process.argv[process.argv.indexOf('--socket') + 1];
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
let connectionNumber = 0;
const server = net.createServer(socket => {
  const connection = ++connectionNumber, held = new Map();
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({ ...request, connection }) + '\\n');
      if (request.cmd === 'cancel') {
        const requestID = request.args.request_id;
        fs.appendFileSync(path.join(dir, 'cancelled.jsonl'), JSON.stringify({ requestID, connection, active: held.has(requestID) }) + '\\n');
        held.delete(requestID); continue;
      }
      const reply = JSON.stringify({ id: request.id, ok: true, data: { version: 'test', uptime: 1 } }) + '\\n';
      if (request.args?.hold === true) { held.set(request.id, reply); continue; }
      if (request.cmd === 'test_release') {
        const pending = held.get(request.args.request_id);
        if (pending) { held.delete(request.args.request_id); socket.write(pending); }
      }
      if (${JSON.stringify(selfIdle ?? null)} && request.cmd === 'doctor') {
        setTimeout(() => { fs.writeFileSync(path.join(dir, 'self-idle'), String(process.pid)); ${selfIdle === "disconnect" ? "socket.destroy();" : `process.exit(${selfIdle === "crash" ? 9 : 0});`} }, 500);
        setTimeout(() => socket.write(reply), 150); continue;
      }
      if (fs.existsSync(path.join(dir, 'hold-request'))) {
        fs.writeFileSync(path.join(dir, 'request-waiting'), String(process.pid));
        const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'release-reply'))) { clearInterval(timer); socket.write(reply); } }, 10);
      } else socket.write(reply);
    }
  });
});
process.on('SIGTERM', () => {
  if (!${JSON.stringify(delayStop)}) {
    fs.writeFileSync(path.join(dir, 'stopped'), String(process.pid));
    process.exit(0);
  }
  server.close();
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 关闭标记也是替换进程的准入点，不能让新连接重新采用正在退出的旧 socket。
  fs.writeFileSync(path.join(dir, 'stopped'), String(process.pid));
  const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'release-stop'))) { clearInterval(timer); process.exit(0); } }, 10);
});
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
server.listen(socketPath, () => console.log('ready'));
`, { mode: 0o700 });
  const drivers: NativeProcessDriver[] = [];
  t.after(async () => { await writeFile(path.join(directory, "release-stop"), ""); await writeFile(path.join(directory, "release-reply"), ""); for (const driver of drivers) await driver.dispose(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    requests: async (): Promise<{ id?: string; cmd: string; args: Record<string, unknown>; connection: number }[]> => (await readFile(path.join(directory, "requests.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    cancellations: async (): Promise<{ requestID: string; connection: number; active: boolean }[]> => (await readFile(path.join(directory, "cancelled.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    driver: (onExit: () => void, idleTimeoutMs?: number, requestTimeoutMs?: number) => { const driver = new NativeProcessDriver(onExit, { binaryPath: binary, socketDir: directory, idleTimeoutMs, requestTimeoutMs }); drivers.push(driver); return driver; }
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "native fixture did not reach the expected state");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("an unexpected helper exit notifies each connected owner once", { timeout: 8_000 }, async t => {
  const f = await fixture(t); let first = 0, second = 0;
  const one = f.driver(() => { first++; }), two = f.driver(() => { second++; });
  await one.start(); await two.start();
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  process.kill(pid, "SIGKILL");
  await waitFor(() => first === 1 && second === 1);
  await one.stop(); await two.stop();
  assert.deepEqual([first, second], [1, 1]);
});

test("idle helper shutdown is not a crash and a later unexpected exit still notifies", { timeout: 8_000 }, async t => {
  const f = await fixture(t); let exits = 0;
  const driver = f.driver(() => { exits++; }, 500);
  await driver.start();
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  await waitFor(async () => (await readFile(path.join(f.directory, "stopped"), "utf8").catch(() => "")) === String(pid));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal(exits, 0);
  await driver.diagnostics();
  const next = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  assert.notEqual(next, pid);
  process.kill(next, "SIGKILL");
  await waitFor(() => exits === 1);
  await driver.stop();
  assert.equal(exits, 1);
});

test("a helper's own idle exit before the driver timer is not reported as a crash", { timeout: 8_000 }, async t => {
  const f = await fixture(t, false, "normal"); let exits = 0;
  const driver = f.driver(() => { exits++; }, 500);
  await driver.start(); await driver.diagnostics();
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  await waitFor(async () => (await readFile(path.join(f.directory, "self-idle"), "utf8").catch(() => "")) === String(pid));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.equal((await readFile(path.join(f.directory, "stopped"), "utf8").catch(() => "")), "");
  await driver.diagnostics();
  assert.equal(exits, 0);
  const next = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  process.kill(next, "SIGKILL");
  await waitFor(() => exits === 1);
});

test("a nonzero helper exit at the idle boundary is still reported", { timeout: 8_000 }, async t => {
  const f = await fixture(t, false, "crash"); let exits = 0;
  const driver = f.driver(() => { exits++; }, 500);
  await driver.start(); await driver.diagnostics();
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  await waitFor(async () => (await readFile(path.join(f.directory, "self-idle"), "utf8").catch(() => "")) === String(pid));
  await waitFor(() => exits === 1);
});

test("stopping after an idle-boundary disconnect releases the owned helper", { timeout: 8_000 }, async t => {
  const f = await fixture(t, false, "disconnect");
  const driver = f.driver(() => {}, 500);
  await driver.start(); await driver.diagnostics();
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  try {
    await waitFor(async () => (await readFile(path.join(f.directory, "self-idle"), "utf8").catch(() => "")) === String(pid));
    await waitFor(() => !driver["host"] || driver["host"].closed);
    await driver.stop();
    assert.equal(await readFile(path.join(f.directory, "stopped"), "utf8").catch(() => ""), String(pid));
  } finally {
    try { process.kill(pid, "SIGTERM"); } catch { /* fixture already exited */ }
  }
});

test("a retired helper exit cannot reject a replacement helper's pending request", { timeout: 8_000 }, async t => {
  const f = await fixture(t, true); let exits = 0;
  const driver = f.driver(() => { exits++; });
  await driver.start();
  const oldPid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  const stopping = driver.stop();
  await waitFor(async () => (await readFile(path.join(f.directory, "stopped"), "utf8").catch(() => "")) === String(oldPid));
  await writeFile(path.join(f.directory, "hold-request"), "");
  const pending = driver.diagnostics();
  await waitFor(async () => (await readFile(path.join(f.directory, "request-waiting"), "utf8").catch(() => "")) !== "");
  assert.notEqual(await readFile(path.join(f.directory, "request-waiting"), "utf8"), String(oldPid), "the pending request must belong to the replacement helper");
  await writeFile(path.join(f.directory, "release-stop"), "");
  await stopping;
  await writeFile(path.join(f.directory, "release-reply"), "");
  assert.equal((await pending).data.version, "test");
  assert.equal(exits, 0);
});

for (const route of ["same-socket", "separate-sockets"] as const) test(`aborted native input cancels only its original request: ${route}`, { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const firstDriver = f.driver(() => undefined), secondDriver = route === "same-socket" ? firstDriver : f.driver(() => undefined);
  await firstDriver.start(); await secondDriver.start();
  const abort = new AbortController();
  const first = firstDriver.actRaw("type_text", { hold: true, label: "first", text: "abc" }, 42, abort.signal).then(reply => ({ reply, error: undefined }), error => ({ reply: undefined, error: error as Error }));
  const second = secondDriver.actRaw("type_text", { hold: true, label: "second", text: "def" }, 42);
  void second.catch(() => undefined);
  await waitFor(async () => (await f.requests()).filter(request => request.cmd === "type_text").length === 2);
  const requests = await f.requests();
  const one = requests.find(request => request.args.label === "first")!, two = requests.find(request => request.args.label === "second")!;
  assert.ok(one.id); assert.ok(two.id); assert.notEqual(one.id, two.id);
  abort.abort();
  assert.match(String((await first).error), /driver_request_aborted/u);
  await waitFor(async () => (await f.cancellations()).length === 1);
  assert.deepEqual(await f.cancellations(), [{ requestID: one.id, connection: one.connection, active: true }]);
  const controls = (await f.requests()).filter(request => request.cmd === "cancel");
  assert.equal(controls[0]?.id, undefined, "cancel control frames must not create another pending request");
  assert.deepEqual(controls[0]?.args, { request_id: one.id });
  await secondDriver.daemonCommand("test_release", { request_id: two.id });
  assert.equal((await second).data.version, "test");
  assert.equal((await f.cancellations()).some(cancel => cancel.requestID === two.id), false);
});

test("a timed out native request notifies its owning socket before returning", { timeout: 8_000 }, async t => {
  const f = await fixture(t), driver = f.driver(() => undefined, undefined, 250);
  await driver.start();
  const pending = driver.actRaw("type_text", { hold: true, label: "timeout", text: "abc" }, 42).then(reply => ({ reply, error: undefined }), error => ({ reply: undefined, error: error as Error }));
  await waitFor(async () => (await f.requests()).some(request => request.args.label === "timeout"));
  const input = (await f.requests()).find(request => request.args.label === "timeout")!;
  assert.ok(input.id);
  await waitFor(async () => (await f.cancellations()).length === 1);
  assert.deepEqual(await f.cancellations(), [{ requestID: input.id, connection: input.connection, active: true }]);
  assert.match(String((await pending).error), /driver_request_timeout/u);
  assert.equal((await driver.diagnostics()).data.version, "test");
});

test("input cancelled before native dispatch sends neither input nor cancel frame", { timeout: 8_000 }, async t => {
  const f = await fixture(t), driver = f.driver(() => undefined);
  await driver.start();
  const abort = new AbortController(); abort.abort();
  const reply = await driver.actRaw("type_text", { text: "abc" }, 42, abort.signal);
  assert.equal(reply.data.effect, "refused");
  assert.equal((await f.requests()).some(request => ["type_text", "cancel"].includes(request.cmd)), false);
});
