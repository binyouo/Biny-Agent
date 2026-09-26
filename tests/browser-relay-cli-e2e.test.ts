/** 发行 CLI 与服务走真实本机协议；扩展用协议 fake，不访问用户数据。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserRelay } from "../src/browser/BrowserRelay.js";

const exec = promisify(execFile);
test("built CLI reports status, reads connected tabs and installs credential-free assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-cli-"));
  const relay = new BrowserRelay(path.join(root, "browser-relay.json"));
  const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [path.resolve("dist/cli/index.js"), "browser", ...args, "--json"], { cwd: root, env: { ...process.env, BINY_AGENT_DIR: root }, timeout: 10000 })).stdout);
  try {
    assert.deepEqual(await run("status"), { running: false, connected: false, browsers: [] });
    await relay.start();
    const socket = new WebSocket(relay.pairingUrl(), { origin: `chrome-extension://${"a".repeat(32)}` });
    await once(socket, "open"); const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "hello", version: 2, browserName: "Chrome CLI" })); await ready;
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: command.id, ok: true, result: command.method === "tabs" ? [{ id: 4, windowId: 1, url: "https://example.com/", title: "Page", active: true }] : command.method === "screenshot" ? { mimeType: "image/png", data: "iVBORw0KGgo=" } : { url: "https://example.com/", title: "Page", text: "Hello CLI", interactive: [] } }));
    });
    const { browsers: [tabs] } = await run("tabs");
    assert.equal(tabs.tabs[0].id, 4);
    assert.equal((await run("read", tabs.browserId, "4")).text, "Hello CLI");
    const screenshot = await run("act", "screenshot", "--args", JSON.stringify({ browserId: tabs.browserId, tabId: 4, path: "screen.png" }));
    assert.equal(screenshot.bytes, 8);
    assert.equal((await readFile(path.join(root, "screen.png"))).toString("hex"), "89504e470d0a1a0a");
    const setup = await run("setup");
    assert.equal(setup.extensionPath, path.join(root, "browser-extension"));
    const manifest = JSON.parse(await readFile(path.join(setup.extensionPath, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(!JSON.stringify(setup).includes(new URL(relay.pairingUrl()).searchParams.get("token")!));
  } finally { await relay.close(); await rm(root, { recursive: true, force: true }); }
});

test("CLI JSON failures have a code and do not expose raw validation details", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-cli-error-"));
  try {
    for (const [args, expected] of [[['tabs'], 'unavailable'], [['read', 'bad-id', '1'], 'invalid']] as const) {
      let failure: { code?: number; stdout?: string; stderr?: string } | undefined;
      try { await exec(process.execPath, [path.resolve("dist/cli/index.js"), "browser", ...args, "--json"], { env: { ...process.env, BINY_AGENT_DIR: root }, timeout: 10000 }); }
      catch (error) { failure = error as typeof failure; }
      assert.equal(failure?.code, 1);
      assert.equal(failure?.stderr, "");
      const result = JSON.parse(failure?.stdout ?? "");
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(typeof result.error, "string");
      assert.ok(!result.error.includes('"validation"'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
