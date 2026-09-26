/** 本地协议故障必须与服务未运行区分，避免把未知浏览器状态当成事实。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestBrowserRelay } from "../src/browser/relayClient.js";

test("status distinguishes malformed responses, HTTP failure and stopped service", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-relay-client-"));
  const file = path.join(root, "relay.json");
  let status = 200;
  let body = "not json";
  const server = createServer((_request, response) => response.writeHead(status).end(body));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(file, JSON.stringify({ port, token: "a".repeat(64) }));
    await assert.rejects(requestBrowserRelay("status", {}, { file }), { code: "invalid" });
    body = JSON.stringify({ ok: true, result: { connected: "yes" } });
    await assert.rejects(requestBrowserRelay("status", {}, { file }), { code: "invalid" });
    status = 503; body = JSON.stringify({ ok: true, result: { running: true, connected: false, browsers: [] } });
    await assert.rejects(requestBrowserRelay("status", {}, { file }), { code: "invalid" });
    await assert.rejects(requestBrowserRelay("click", { browserId: "00000000-0000-4000-8000-000000000000", tabId: 1, selector: "#go" }, { file }), { code: "unknown" });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(await requestBrowserRelay("status", {}, { file }), { running: false, connected: false, browsers: [] });
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); }
});
