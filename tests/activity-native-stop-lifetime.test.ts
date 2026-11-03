import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ActivityNativeClient } from "../src/desktop/electron/main/ActivityNativeClient.js";

for (const waitForSpawn of [false, true]) test(`stopping ${waitForSpawn ? "after spawn" : "before spawn"} closes the owned daemon`, { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-native-stop-"));
  const pidFile = path.join(root, "pid");
  const binary = path.join(root, "computer-use");
  const client = new ActivityNativeClient(root, path.join(root, "temp"));
  try {
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const net = require('node:net');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const socket = process.argv[process.argv.indexOf('--socket') + 1];
const server = net.createServer(c => c.on('data', bytes => { const request = JSON.parse(String(bytes)); c.write(JSON.stringify({id:request.id,ok:true,data:{apps:[]}})+'\\n'); }));
setTimeout(() => server.listen(socket, () => console.log('ready')), 200);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o755 });
    const request = client.applications([]).catch(() => undefined);
    if (waitForSpawn) {
      const deadline = Date.now() + 5_000;
      while (await readFile(pidFile, "utf8").then(() => false, () => true)) {
        assert.ok(Date.now() < deadline, "daemon did not spawn");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await client.stop();
    await request;
    const pid = await readFile(pidFile, "utf8").then(Number, () => undefined);
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await client.stop(); await rm(root, { recursive: true, force: true }); }
});
