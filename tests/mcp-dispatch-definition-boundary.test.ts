import assert from "node:assert/strict";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolOutcomeUnknownError, type ToolExecutionContext } from "../src/tools/types.js";

const original: McpTool = { name: "act", description: "Read state", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } };
const changes: Array<[string, McpTool[]]> = [
  ["description", [{ ...original, description: "Changed behavior" }]],
  ["risk annotations", [{ ...original, annotations: { readOnlyHint: false, destructiveHint: true } }]],
  ["input schema", [{ ...original, inputSchema: { type: "object", properties: { target: { type: "string" } } } }]],
  ["output schema", [{ ...original, outputSchema: { type: "object", properties: { value: { type: "string" } } } }]],
  ["removed tool", []]
];

type CatalogHook = { listAllTools: (...args: unknown[]) => Promise<unknown> };
async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); } finally { await f.host.close(); await f.server.close(); }
}
async function createFixture() {
  let definitions: McpTool[] = [structuredClone(original)];
  let calls = 0; let dispatched = 0; let closeOnCall = false;
  const server = new Server({ name: "definition-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    calls += 1;
    if (closeOnCall) { await server.close(); throw new Error("Connection closed after dispatch"); }
    return { content: [{ type: "text", text: "server called" }] };
  });
  const host = new McpToolHost();
  await host.attachLocalServer("fixture", "endpoint", undefined, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return { transport: clientTransport, close: () => server.close() };
  });
  const oldProxy = host.createTools()[0]!;
  const execution = await oldProxy.resolveExecution({});
  assert.ok("execute" in execution);
  const context = (signal?: AbortSignal): ToolExecutionContext => ({
    toolCallId: "call", operationId: "operation", mcpResultMode: "envelope", signal,
    onDispatched: () => { dispatched += 1; }
  });
  return {
    host, server, execution, context,
    get calls() { return calls; }, get dispatched() { return dispatched; },
    set closeOnCall(value: boolean) { closeOnCall = value; },
    async refresh(next: McpTool[]) {
      definitions = next;
      const changed = new Promise<void>(resolve => { const unsubscribe = host.subscribe(() => { unsubscribe(); resolve(); }); });
      await server.notification({ method: "notifications/tools/list_changed" });
      await changed;
    },
    async atRefreshBoundary(next: McpTool[], invoke: () => Promise<unknown>) {
      // Schedule invocation after the actual SDK list response has settled, but
      // before the original refresh installs it. No credential/auth substitute.
      const hook = host as unknown as CatalogHook;
      const list = hook.listAllTools.bind(host);
      let pending: Promise<unknown> | undefined;
      let started!: () => void;
      const invoked = new Promise<void>(resolve => { started = resolve; });
      hook.listAllTools = async (...args) => {
        const result = await list(...args);
        queueMicrotask(() => { pending = invoke(); void pending.catch(() => undefined); started(); });
        return result;
      };
      try {
        definitions = next;
        await server.notification({ method: "notifications/tools/list_changed" });
        await invoked;
        return await pending!;
      } finally { hook.listAllTools = list; }
    }
  };
}

for (const [name, definitions] of changes) {
  test(`rejects ${name} changed during credential-await boundary before RPC admission`, { timeout: 5000 }, async () => fixture(async f => {
    await assert.rejects(f.atRefreshBoundary(definitions, () => f.execution.execute(f.context())), /definition changed/u);
    assert.equal(f.calls, 0);
    assert.equal(f.dispatched, 0);
  }));
}

test("unchanged metadata still dispatches exactly once through the same boundary", { timeout: 5000 }, async () => fixture(async f => {
  const result = await f.atRefreshBoundary([structuredClone(original)], () => f.execution.execute(f.context()));
  assert.deepEqual(result, { content: [{ type: "text", text: "server called" }] });
  assert.equal(f.calls, 1); assert.equal(f.dispatched, 1);
}));

test("a definition changed before invocation is already rejected", { timeout: 5000 }, async () => fixture(async f => {
  await f.refresh(changes[0]![1]);
  await assert.rejects(f.execution.execute(f.context()), /definition changed/u);
  assert.equal(f.calls, 0); assert.equal(f.dispatched, 0);
}));

test("rediscovered tool can execute its new metadata", { timeout: 5000 }, async () => fixture(async f => {
  await f.refresh(changes[1]![1]);
  const proxy = f.host.createTools()[0]!;
  assert.equal(proxy.risk, "write");
  const fresh = await proxy.resolveExecution({});
  assert.ok("execute" in fresh);
  await fresh.execute(f.context());
  assert.equal(f.calls, 1); assert.equal(f.dispatched, 1);
}));

test("direct calls without a captured definition retain existing admission", { timeout: 5000 }, async () => fixture(async f => {
  await f.atRefreshBoundary(changes[0]![1], () => f.host.callServerTool("fixture", "act", {}, undefined, true, f.context().onDispatched));
  assert.equal(f.calls, 1); assert.equal(f.dispatched, 1);
}));

test("pre-aborted calls never dispatch", { timeout: 5000 }, async () => fixture(async f => {
  const controller = new AbortController(); controller.abort(new Error("cancelled before admission"));
  await assert.rejects(f.execution.execute(f.context(controller.signal)), /cancelled before admission/u);
  assert.equal(f.calls, 0); assert.equal(f.dispatched, 0);
}));

test("connection loss after an admitted call is not replayed", { timeout: 5000 }, async () => fixture(async f => {
  f.closeOnCall = true;
  await assert.rejects(f.execution.execute(f.context()), error => error instanceof ToolOutcomeUnknownError);
  assert.equal(f.calls, 1); assert.equal(f.dispatched, 1);
}));

test("abort during credential await is not reported as dispatched", { timeout: 5000 }, async () => fixture(async f => {
  const controller = new AbortController();
  await assert.rejects(f.atRefreshBoundary([structuredClone(original)], () => {
    queueMicrotask(() => controller.abort(new Error("cancelled during credential await")));
    return f.execution.execute(f.context(controller.signal));
  }), /cancelled during credential await/u);
  assert.equal(f.calls, 0); assert.equal(f.dispatched, 0);
}));
