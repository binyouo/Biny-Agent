/** 握手异常在子进程中验证，确保错误输入不会终止宿主进程。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
test("malformed upgrade URL is rejected and Relay stays alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-handshake-"));
  const script = `
    import { BrowserRelay } from ${JSON.stringify(new URL("../src/browser/BrowserRelay.ts", import.meta.url).href)};
    import { connect } from 'node:net';
    import assert from 'node:assert/strict';
    const relay = new BrowserRelay(process.env.RELAY_TEST_FILE);
    try {
      await relay.start();
      const port = Number(new URL(relay.pairingUrl()).port);
      const response = await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        let body = '';
        socket.on('data', chunk => { body += chunk; });
        socket.on('error', reject);
        socket.on('close', () => resolve(body));
        socket.on('connect', () => socket.write('GET //[ HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nOrigin: chrome-extension://${"a".repeat(32)}\\r\\n\\r\\n'));
      });
      assert.match(response, /403 Forbidden/);
      assert.equal(relay.status().running, true);
    } finally { await relay.close(); }
  `;
  try {
    const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { env: { ...process.env, RELAY_TEST_FILE: path.join(root, "relay.json") }, timeout: 5000 });
    assert.equal(result.stderr, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
