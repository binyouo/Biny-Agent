import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { CapabilityStore, CapabilityIdempotencyConflictError, CapabilityOutcomeUnknownError, CapabilityInvocationAlreadySettledError } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

const oldSchema = { type: "object", properties: { old: { type: "string" } }, required: ["old"] };
const nextSchema = { type: "object", properties: { current: { type: "string" } }, required: ["current"] };
const looseSchema = { type: "object", properties: {} };
const capabilityName = "host:mcp:fixture";

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); } finally { f.store.close(); f.authority.close(); await rm(f.root, { recursive: true, force: true }); }
}
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-capability-schema-"));
  let authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  let store = await CapabilityStore.open(root, authority);
  return {
    root, get authority() { return authority; }, get store() { return store; },
    async reopen() {
      store.close(); authority.close();
      authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
      store = await CapabilityStore.open(root, authority);
    }
  };
}

for (const source of ["mcp", "plugin"]) {
  test(`${source}: refreshed required fields admit the new request`, async () => fixture(async f => {
    const name = `host:${source}:fixture`;
    const initial = f.store.ensureHostCapability(name, oldSchema);
    const refreshed = f.store.ensureHostCapability(name, nextSchema);
    let calls = 0;
    const result = await f.store.executeHostCapability({ capabilityName: name, schema: nextSchema, request: { current: "yes" }, offerId: "fresh" }, async () => { calls += 1; return { ok: true }; });
    assert.deepEqual(result, { ok: true }); assert.equal(calls, 1);
    assert.equal(refreshed.registrationId, initial.registrationId);
    assert.equal(refreshed.revision, initial.revision + 1);
    assert.deepEqual(refreshed.schema, nextSchema);
  }));
}

test("execution admission refreshes without an earlier catalog registration call", async () => fixture(async f => {
  f.store.ensureHostCapability(capabilityName, oldSchema);
  let calls = 0;
  await f.store.executeHostCapability({ capabilityName, schema: looseSchema, request: {}, offerId: "fresh" }, async () => { calls += 1; return "ok"; });
  assert.equal(calls, 1); assert.deepEqual(f.store.list("host")[0]!.schema, looseSchema);
}));

test("new required fields reject a fresh operation before executor admission", async () => fixture(async f => {
  f.store.ensureHostCapability(capabilityName, looseSchema);
  let calls = 0;
  await assert.rejects(f.store.executeHostCapability({ capabilityName, schema: nextSchema, request: {}, offerId: "fresh" }, async () => { calls += 1; }), /missing required field current/u);
  assert.equal(calls, 0);
  assert.equal(f.authority.databaseHandle().prepare("SELECT COUNT(*) AS n FROM capability_invocations").get()!.n, 0);
}));

test("unchanged schema and reordered object keys do not churn registration revisions", async () => fixture(async f => {
  const first = f.store.ensureHostCapability(capabilityName, oldSchema);
  const second = f.store.ensureHostCapability(capabilityName, { required: ["old"], properties: { old: { type: "string" } }, type: "object" });
  assert.equal(second.revision, first.revision); assert.equal(second.registrationId, first.registrationId);
}));

test("changed schema survives real SQLite close and reopen", async () => fixture(async f => {
  const original = f.store.ensureHostCapability(capabilityName, oldSchema);
  f.store.ensureHostCapability(capabilityName, nextSchema);
  await f.reopen();
  const restored = f.store.get(original.registrationId)!;
  assert.deepEqual(restored.schema, nextSchema); assert.equal(restored.revision, 1);
}));

test("old completed offer returns its original result under a changed schema without re-execution", async () => fixture(async f => {
  const input = { capabilityName, schema: oldSchema, request: { old: "before" }, offerId: "same", sessionId: "session", turnId: "turn", toolCallId: "call" };
  let calls = 0;
  const first = await f.store.executeHostCapability(input, async () => { calls += 1; return { receipt: "original" }; });
  const id = f.store.list("host")[0]!.registrationId;
  f.store.ensureHostCapability(capabilityName, nextSchema);
  await f.reopen();
  const second = await f.store.executeHostCapability({ ...input, schema: nextSchema }, async () => { calls += 1; return { receipt: "duplicate" }; });
  assert.deepEqual(second, first); assert.equal(calls, 1); assert.equal(f.store.list("host")[0]!.registrationId, id);
  assert.deepEqual(f.store.list("host")[0]!.schema, nextSchema);
  assert.equal(f.authority.databaseHandle().prepare("SELECT COUNT(*) AS n FROM capability_invocations").get()!.n, 1);
}));

test("old operation identity conflict remains a conflict after schema changes", async () => fixture(async f => {
  const input = { capabilityName, schema: oldSchema, request: { old: "before" }, offerId: "same" };
  let calls = 0;
  await f.store.executeHostCapability(input, async () => { calls += 1; return "ok"; });
  f.store.ensureHostCapability(capabilityName, nextSchema);
  await assert.rejects(f.store.executeHostCapability({ ...input, schema: nextSchema, request: { old: "different" } }, async () => { calls += 1; }), CapabilityIdempotencyConflictError);
  assert.equal(calls, 1);
}));

test("a previous unknown operation stays unknown under new required fields", async () => fixture(async f => {
  const registration = f.store.ensureHostCapability(capabilityName, oldSchema);
  const invocation = f.store.invoke({ registrationId: registration.registrationId, offerId: "unknown", request: { old: "before" } });
  f.store.unknown(invocation.invocationId, "transport_error");
  f.store.ensureHostCapability(capabilityName, nextSchema);
  let calls = 0;
  await assert.rejects(f.store.executeHostCapability({ capabilityName, schema: nextSchema, offerId: "unknown", request: { old: "before" } }, async () => { calls += 1; }), CapabilityOutcomeUnknownError);
  assert.equal(calls, 0); assert.equal(f.store.getInvocation(invocation.invocationId)!.status, "unknown");
}));

for (const status of ["failed", "cancelled"] as const) {
  test(`previous ${status} offer is not re-executed after a schema change`, async () => fixture(async f => {
    const registration = f.store.ensureHostCapability(capabilityName, oldSchema);
    const invocation = f.store.invoke({ registrationId: registration.registrationId, offerId: "settled", request: { old: "before" } });
    if (status === "failed") f.store.fail(invocation.invocationId, "failure");
    else f.store.cancel(invocation.invocationId);
    f.store.ensureHostCapability(capabilityName, nextSchema);
    await f.reopen();
    let calls = 0;
    await assert.rejects(f.store.executeHostCapability({ capabilityName, schema: nextSchema, offerId: "settled", request: { old: "before" } }, async () => { calls += 1; }), CapabilityInvocationAlreadySettledError);
    assert.equal(calls, 0); assert.equal(f.store.getInvocation(invocation.invocationId)!.status, status);
  }));
}

test("refresh does not cancel an active invocation and duplicate caller joins it", async () => fixture(async f => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const input = { capabilityName, schema: oldSchema, request: { old: "before" }, offerId: "active" };
  let calls = 0;
  const pending = f.store.executeHostCapability(input, async () => { calls += 1; await gate; return "finished"; });
  f.store.ensureHostCapability(capabilityName, nextSchema);
  const joined = f.store.executeHostCapability({ ...input, schema: nextSchema }, async () => { calls += 1; return "duplicate"; });
  release();
  assert.deepEqual(await Promise.all([pending, joined]), ["finished", "finished"]); assert.equal(calls, 1);
  assert.deepEqual(f.store.list("host")[0]!.schema, nextSchema);
}));

test("released host registration reuses its identity with the new schema", async () => fixture(async f => {
  const first = f.store.ensureHostCapability(capabilityName, oldSchema);
  f.store.release(first.registrationId);
  const next = f.store.ensureHostCapability(capabilityName, nextSchema);
  assert.equal(next.registrationId, first.registrationId); assert.equal(next.status, "admitted"); assert.deepEqual(next.schema, nextSchema);
}));

test("client-owned registration is not changed by refreshing a host tool", async () => fixture(async f => {
  const client = f.store.register({ ownerType: "client", ownerId: "client", capabilityName, schema: oldSchema });
  f.store.ensureHostCapability(capabilityName, nextSchema);
  assert.deepEqual(f.store.get(client.registrationId), client);
}));

test("invalid replacement schema does not mutate durable registration", async () => fixture(async f => {
  const first = f.store.ensureHostCapability(capabilityName, oldSchema);
  assert.throws(() => f.store.ensureHostCapability(capabilityName, {}), /schema cannot be empty/u);
  assert.deepEqual(f.store.get(first.registrationId), first);
}));

test("real SDK catalog refresh admits a freshly discovered proxy through the durable ledger", { timeout: 10_000 }, async () => fixture(async f => {
  let definition: McpTool = { name: "lookup", inputSchema: oldSchema as McpTool["inputSchema"], annotations: { readOnlyHint: true } };
  const requests: unknown[] = [];
  const server = new Server({ name: "schema-refresh-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [definition] }));
  server.setRequestHandler(CallToolRequestSchema, async request => { requests.push(request.params.arguments); return { content: [{ type: "text", text: "accepted" }] }; });
  const host = new McpToolHost();
  try {
    await host.attachLocalServer("fixture", "endpoint", undefined, async () => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      return { transport: client, close: () => server.close() };
    });
    const before = host.createTools()[0]!;
    const name = `host:mcp:${before.name}`;
    const registered = f.store.ensureHostCapability(name, before.parameters);
    definition = { ...definition, inputSchema: nextSchema as McpTool["inputSchema"] };
    const changed = new Promise<void>(resolve => { const unsubscribe = host.subscribe(() => { unsubscribe(); resolve(); }); });
    await server.notification({ method: "notifications/tools/list_changed" }); await changed;
    const fresh = host.createTools()[0]!;
    assert.notEqual(fresh, before);
    f.store.ensureHostCapability(name, fresh.parameters);
    const args = { current: "yes" };
    const execution = await fresh.resolveExecution(args);
    assert.ok("execute" in execution);
    // Same schema/request/dispatch-boundary mapping as the coordinator; this
    // test exercises real SDK + Host + Store, not a full Runtime Host turn.
    const result = await f.store.executeHostCapability({ capabilityName: name, schema: fresh.parameters, request: args, offerId: "fresh", toolCallId: "call", dispatchBoundary: "reported" },
      (signal, onDispatched) => execution.execute({ signal, onDispatched, toolCallId: "call", operationId: "fresh", mcpResultMode: "envelope" }));
    assert.deepEqual(result, { content: [{ type: "text", text: "accepted" }] });
    assert.deepEqual(requests, [args]);
    assert.equal(f.store.list("host")[0]!.registrationId, registered.registrationId);
  } finally { await host.close(); await server.close(); }
}));
