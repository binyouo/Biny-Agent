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
const server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const reply = JSON.stringify({ id: request.id, ok: true, data: { version: 'test', uptime: 1 } }) + '\\n';
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
  fs.writeFileSync(path.join(dir, 'stopped'), String(process.pid));
  if (!${JSON.stringify(delayStop)}) process.exit(0);
  server.close();
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'release-stop'))) { clearInterval(timer); process.exit(0); } }, 10);
});
try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
server.listen(socketPath, () => console.log('ready'));
`, { mode: 0o700 });
  const drivers: NativeProcessDriver[] = [];
  t.after(async () => { await writeFile(path.join(directory, "release-stop"), ""); await writeFile(path.join(directory, "release-reply"), ""); for (const driver of drivers) await driver.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, driver: (onExit: () => void, idleTimeoutMs?: number) => { const driver = new NativeProcessDriver(onExit, { binaryPath: binary, socketDir: directory, idleTimeoutMs }); drivers.push(driver); return driver; } };
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
  await writeFile(path.join(f.directory, "release-stop"), "");
  await stopping;
  await writeFile(path.join(f.directory, "release-reply"), "");
  assert.equal((await pending).data.version, "test");
  assert.equal(exits, 0);
});
