import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { startComputerUseHttpServer } from "../src/computer/httpMcpServer.js";

test("loopback MCP authenticates before dispatch, isolates client targets, and removes its token on shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-http-mcp-"));
  let created = 0;
  let detached = 0;
  class Driver extends NativeProcessDriver {
    private target?: number;
    override async observeRaw(args: Record<string, unknown>) { this.target = Number(args.pid); return { data: { pid: this.target, elements: [] }, images: [] }; }
    override async actRaw(_action: string, _params: Record<string, unknown>, pid?: number) { return { data: { pid: pid ?? this.target }, images: [] }; }
    override async captureWindow() { return { data: {}, images: [] }; }
    override detach() { detached++; }
  }
  const server = await startComputerUseHttpServer({ tokenPath: path.join(directory, "token"), createPolicy: () => ({ run: async (_tool, _args, operation) => await operation() }), createDriver: () => { created++; return new Driver(() => undefined); } });
  const clients: Client[] = [];
  const transports: StreamableHTTPClientTransport[] = [];
  try {
    assert.equal((await stat(server.tokenPath)).mode & 0o777, 0o600);
    assert.equal((await fetch(server.url, { method: "POST", body: "{}" })).status, 401);
    const secret = await readFile(server.tokenPath, "utf8");
    const headers = { Authorization: `Bearer ${secret}` };
    assert.equal((await fetch(server.url, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
    const badHost = await new Promise<number>((resolve, reject) => {
      const call = request(server.url, { headers: { ...headers, Host: "example.com" } }, response => { response.resume(); resolve(response.statusCode!); });
      call.once("error", reject); call.end();
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(server.url, { method: "POST", headers, body: "invalid" })).status, 400);
    assert.equal(created, 0);
    for (const pid of [12, 13]) {
      const client = new Client({ name: `client-${pid}`, version: "1" }); clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }); transports.push(transport);
      await client.connect(transport);
      await client.callTool({ name: "get_app_state", arguments: { pid } });
    }
    const tools = await clients[0]!.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "pip_open"));
    for (const [index, client] of clients.entries()) {
      const reply = await client.callTool({ name: "press_key", arguments: { key: "Return" } });
      const content = reply.content as { type: string; text?: string }[];
      assert.equal(JSON.parse(content.find(block => block.type === "text")!.text!).pid, 12 + index);
    }
    await assert.rejects(startComputerUseHttpServer({ tokenPath: server.tokenPath }), /EEXIST/);
    assert.equal(await readFile(server.tokenPath, "utf8"), secret);
    for (const transport of transports) await transport.terminateSession();
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await server.close();
    await assert.rejects(stat(server.tokenPath), /ENOENT/);
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(created, 2); assert.equal(detached, 2);
});

test("HTTP MCP reaches the real native daemon without capturing or changing the desktop", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-http-cu-"));
  const drivers: NativeProcessDriver[] = [];
  const server = await startComputerUseHttpServer({ tokenPath: path.join(directory, "token"), createPolicy: () => ({ run: async (_tool, _args, operation) => await operation() }), createDriver: () => {
    const driver = new NativeProcessDriver(() => undefined, { socketDir: directory }); drivers.push(driver); return driver;
  } });
  const client = new Client({ name: "native-contract", version: "1" });
  try {
    const secret = await readFile(server.tokenPath, "utf8");
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    const reply = await client.callTool({ name: "pip_list", arguments: {} });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    const content = reply.content as { type: string; text?: string }[];
    assert.deepEqual(JSON.parse(content.find(block => block.type === "text")!.text!), { sessions: [], armed: [] });
    const closed = await client.callTool({ name: "pip_close", arguments: { all: true } });
    assert.notEqual(closed.isError, true, JSON.stringify(closed.content));
  } finally {
    await client.close();
    await Promise.all(drivers.map(driver => driver.dispose()));
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
