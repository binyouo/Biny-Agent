import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP shutdown test exceeded 5 seconds")), 5_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-startup-cleanup-"));
const fixture = path.join(root, "server.mjs");
await writeFile(fixture, `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [stage, entered, closed] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === stage) {
    writeFileSync(entered, String(process.pid));
    return;
  }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "shutdown-fixture", version: "1" }
    } }) + "\\n");
  }
});
input.on("close", () => {
  writeFileSync(closed, "closed");
  process.exit(0);
});
`);

try {
  for (const stage of ["initialize", "tools/list"]) {
    const suffix = stage.replace("/", "-");
    const entered = path.join(root, `${suffix}-entered`);
    const closed = path.join(root, `${suffix}-closed`);
    const host = new McpToolHost();
    const config = configSchema.parse({
      ...defaultConfig,
      extensions: { ...defaultConfig.extensions, mcp: {
        stalled: { enabled: true, command: process.execPath, args: [fixture, stage, entered, closed], stderr: "ignore", timeoutMs: 30_000 }
      } }
    });
    const starting = host.connectConfiguredServers(root, config);
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(entered) && Date.now() < deadline) await delay(10);
      assert.equal(existsSync(entered), true, `fixture must reach ${stage}`);
      pid = Number(await readFile(entered, "utf8"));
      assert.equal(host.listServers()[0]?.connecting, true);
      assert.equal(host.listServers()[0]?.connected, false);
      await withinDeadline(host.close());
      assert.equal(existsSync(closed), true, `close must release the stdio child while ${stage} is pending`);
      await withinDeadline(starting);
      assert.equal(host.listServers()[0]?.connecting, false);
      assert.equal(host.listServers()[0]?.connected, false);
      assert.deepEqual(host.createTools(), []);
      await withinDeadline(host.close());
    } finally {
      if (pid !== undefined && !existsSync(closed)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* The fixture may have already exited. */ }
      }
      await withinDeadline(starting);
      await host.close();
    }
  }

  for (const transportProtocol of [undefined, "sse"] as const) {
    // Close both HTTP initialization and SSE's earlier, pre-endpoint startup wait.
    const requests: string[] = [];
    let initialized!: () => void;
    const initializing = new Promise<void>((resolve) => { initialized = resolve; });
    let requestClosed: Promise<unknown> | undefined;
    const server = createServer((request, response) => {
      requests.push(request.method ?? "");
      if (request.method === "POST" || transportProtocol === "sse" && request.method === "GET") {
        requestClosed = once(response, "close");
        request.resume();
        if (transportProtocol === "sse") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": waiting for endpoint\n\n");
        }
        initialized();
      } else {
        response.writeHead(405).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const host = new McpToolHost();
    const starting = host.connectConfiguredServers(root, configSchema.parse({
      ...defaultConfig,
      extensions: { ...defaultConfig.extensions, mcp: {
        stalled: { enabled: true, type: "http", url: `http://127.0.0.1:${address.port}/mcp`, transportProtocol, timeoutMs: 30_000 }
      } }
    }));
    try {
      await withinDeadline(initializing);
      await withinDeadline(host.close());
      await withinDeadline(starting);
      assert.ok(requestClosed);
      await withinDeadline(requestClosed);
      assert.deepEqual(requests, [transportProtocol === "sse" ? "GET" : "POST"], "shutdown must abort startup without initiating another transport");
      assert.equal(host.listServers()[0]?.connected, false);
      assert.deepEqual(host.createTools(), []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await withinDeadline(starting);
      await host.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("MCP startup cleanup tests passed");
