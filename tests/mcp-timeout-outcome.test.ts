import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { CapabilityOutcomeUnknownError, CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); } finally { await f.host.close(); f.store.close(); f.authority.close(); await rm(f.root, { recursive: true, force: true }); }
}
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-timeout-outcome-"));
  const marker = path.join(root, "owned-side-effect.txt");
  let authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  let store = await CapabilityStore.open(root, authority);
  const host = new McpToolHost();
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { fixture: {
    enabled: true, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/mcp-timeout-server.mjs", import.meta.url)), marker],
    stderr: "ignore", timeoutMs: 1_000, startupTimeoutMs: 10_000, exposure: "direct"
  } } } });
  try {
    await host.connectConfiguredServers(root, config);
    const proxy = host.createTools()[0]; assert.ok(proxy, "owned stdio server should connect");
    async function prepare(mode: string) {
      const execution = await proxy!.resolveExecution({ mode }); assert.ok("execute" in execution); return execution;
    }
    return {
      root, host, get authority() { return authority; }, get store() { return store; }, proxy,
      prepare,
      async marker() { try { return await readFile(marker, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } },
      async invoke(mode: string, offerId = mode, signal?: AbortSignal) {
        const execution = await prepare(mode);
        return await store.executeHostCapability({ capabilityName: `host:mcp:${proxy.name}`, schema: proxy.parameters,
          request: { mode }, offerId, sessionId: "session", turnId: "turn", toolCallId: offerId, dispatchBoundary: "reported" },
        (rpcSignal, onDispatched) => execution.execute({ signal: rpcSignal, onDispatched, toolCallId: offerId, operationId: offerId, mcpResultMode: "envelope" }), signal);
      },
      invocation(offerId: string) {
        return authority.databaseHandle().prepare("SELECT status, dispatch_state, outcome_unknown_reason FROM capability_invocations WHERE offer_id = ?").get(offerId);
      },
      async reopen() {
        store.close(); authority.close();
        authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
        store = await CapabilityStore.open(root, authority);
      }
    };
  } catch (error) { await host.close(); store.close(); authority.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "owned server marker did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("SDK timeout after real remote mutation is durable unknown and never replayed", { timeout: 20_000 }, async () => fixture(async f => {
  const failure = await f.invoke("slow", "operation").then(() => undefined, (error: unknown) => error);
  assert.match(await f.marker(), /committed:slow/u);
  assert.equal(f.invocation("operation")!.dispatch_state, "dispatched");
  assert.ok(failure instanceof CapabilityOutcomeUnknownError && failure.reason === "timeout");
  assert.deepEqual({ ...f.invocation("operation") }, { status: "unknown", dispatch_state: "dispatched", outcome_unknown_reason: "timeout" });
  await until(async () => (await f.marker()).includes("late-response-ready"));
  assert.equal(f.invocation("operation")!.status, "unknown", "late server completion must not rewrite the settled unknown outcome");
  await f.reopen();
  await assert.rejects(f.invoke("slow", "operation"), error => error instanceof CapabilityOutcomeUnknownError && error.reason === "timeout");
  assert.equal((await f.marker()).match(/called:slow/gu)?.length, 1, "same operation must not be dispatched again after reopening SQLite");
}));

test("direct proxy timeout is typed unknown without disconnecting a healthy connection", { timeout: 20_000 }, async () => fixture(async f => {
  const execution = await f.prepare("slow"); let dispatched = 0;
  const failure = await execution.execute({ toolCallId: "direct", operationId: "direct", onDispatched: () => { dispatched += 1; } })
    .then(() => undefined, (error: unknown) => error);
  assert.equal(dispatched, 1); assert.match(await f.marker(), /committed:slow/u);
  assert.ok(failure instanceof ToolOutcomeUnknownError && failure.reason === "timeout");
  assert.equal(f.host.listServers()[0]!.connected, true);
  const fast = await f.prepare("fast");
  assert.equal(await fast.execute({ toolCallId: "next", operationId: "next" }), "committed");
  assert.equal((await f.marker()).match(/called:slow/gu)?.length, 1);
  assert.equal((await f.marker()).match(/called:fast/gu)?.length, 1);
}));

test("normal response remains a successful durable result", { timeout: 20_000 }, async () => fixture(async f => {
  assert.deepEqual(await f.invoke("fast"), { content: [{ type: "text", text: "committed" }] });
  assert.deepEqual({ ...f.invocation("fast") }, { status: "result", dispatch_state: "dispatched", outcome_unknown_reason: null });
  assert.match(await f.marker(), /committed:fast/u);
}));

test("business RPC error mentioning timeout is not reclassified by message text", { timeout: 20_000 }, async () => fixture(async f => {
  await assert.rejects(f.invoke("rpc-error"), error => error instanceof McpError && error.code === ErrorCode.InternalError);
  assert.deepEqual({ ...f.invocation("rpc-error") }, { status: "failed", dispatch_state: "dispatched", outcome_unknown_reason: null });
  assert.doesNotMatch(await f.marker(), /committed:/u);
}));

test("MCP isError envelope retains its existing result handling", { timeout: 20_000 }, async () => fixture(async f => {
  const result = await f.invoke("business-error") as { isError?: boolean };
  assert.equal(result.isError, true); assert.equal(f.invocation("business-error")!.status, "result");
  assert.equal(f.invocation("business-error")!.outcome_unknown_reason, null);
}));

test("pre-aborted admission has no RPC or durable invocation", { timeout: 20_000 }, async () => fixture(async f => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.invoke("slow", "pre-abort", controller.signal), { name: "AbortError" });
  assert.equal(await f.marker(), ""); assert.equal(f.invocation("pre-abort"), undefined);
}));

test("pre-request dispatch-callback error is not mistaken for an SDK request timeout", { timeout: 20_000 }, async () => fixture(async f => {
  const execution = await f.prepare("slow");
  const error = new McpError(ErrorCode.RequestTimeout, "synthetic callback failure before RPC");
  await assert.rejects(execution.execute({ toolCallId: "callback", operationId: "callback", onDispatched: () => { throw error; } }), received => received === error);
  assert.equal(await f.marker(), "");
}));

test("caller cancellation after dispatch keeps cancellation reason instead of SDK timeout", { timeout: 20_000 }, async () => fixture(async f => {
  const controller = new AbortController();
  const pending = f.invoke("slow", "cancel", controller.signal);
  const rejected = assert.rejects(pending, error => error instanceof CapabilityOutcomeUnknownError && error.reason === "cancelled");
  await until(async () => (await f.marker()).includes("committed:slow")); controller.abort(); await rejected;
  assert.deepEqual({ ...f.invocation("cancel") }, { status: "unknown", dispatch_state: "dispatched", outcome_unknown_reason: "cancelled" });
}));

test("connection close after mutation keeps transport-error unknown classification", { timeout: 20_000 }, async () => fixture(async f => {
  await assert.rejects(f.invoke("disconnect"), error => error instanceof CapabilityOutcomeUnknownError && error.reason === "transport_error");
  assert.match(await f.marker(), /committed:disconnect/u);
  assert.deepEqual({ ...f.invocation("disconnect") }, { status: "unknown", dispatch_state: "dispatched", outcome_unknown_reason: "transport_error" });
}));
