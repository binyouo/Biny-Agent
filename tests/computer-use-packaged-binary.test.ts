import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

test("packaged computer control starts its external helper and never falls back to a development copy", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bcu-pack-"));
  const resources = path.join(root, "Biny.app", "Contents", "Resources");
  const binary = path.join(resources, "native", "computer-use.app", "Contents", "MacOS", "computer-use");
  const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  let driver: NativeProcessDriver | undefined;
  try {
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(path.join(resources, "app.asar"), "archive fixture");
    await writeFile(binary, `#!/usr/bin/env node
const net = require('node:net');
const socketPath = process.argv[process.argv.indexOf('--socket') + 1];
net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      socket.write(JSON.stringify({ id: request.id, ok: true, data: { version: 'packaged-fixture' } }) + '\\n');
    }
  });
}).listen(socketPath, () => process.stdout.write('ready\\n'));
`, { mode: 0o755 });
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });
    driver = new NativeProcessDriver(() => undefined, { socketDir: root, requestTimeoutMs: 2_000 });
    assert.equal(driver.workerPath(), binary, "the app must select its external executable before any source-tree or archive candidate");
    await driver.start();
    assert.equal((await driver.diagnostics()).data.version, "packaged-fixture");
    await driver.dispose();
    driver = undefined;
    await rm(binary);
    assert.equal(NativeProcessDriver.resolveBinary(), binary, "a broken installation must not execute a development helper instead");
  } finally {
    await driver?.dispose();
    if (original) Object.defineProperty(process, "resourcesPath", original);
    else Reflect.deleteProperty(process, "resourcesPath");
    await rm(root, { recursive: true, force: true });
  }
});
