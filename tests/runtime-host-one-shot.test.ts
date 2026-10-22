import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createRuntimeHostFactory } from "../src/runtime/host/runtimeFactory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { readSessionEvents } from "../src/session/events.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

function response(text: string) {
  return new Response([
    { id: "response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "response", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("one-shot Host runs isolate overrides, persist one terminal and support verification", { timeout: 45_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-one-shot-")));
  const config = structuredClone(defaultConfig);
  config.defaultModel = "normal";
  // This positive verification fixture permits its Node command; sandbox denial has separate coverage.
  config.permission.denyPaths = [];
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", requiresApiKey: false } };
  config.models = { normal: { provider: "fixture", model: "normal" }, alternate: { provider: "fixture", model: "alternate" } };
  config.context.memory.enabled = false; config.context.identity.enabled = false; config.heartbeat.enabled = false;
  config.crystal.passiveEnabled = false; config.crystal.semanticScanEnabled = false; config.computer.enabled = false; config.checkpoints.enabled = false;
  const store = createFileConfigStore(root, { globalDir: root });
  await store.save(config, root);
  const models: string[] = [];
  let pendingRequest: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    models.push(JSON.parse(String(init?.body)).model);
    if (pendingRequest) {
      pendingRequest.resolve();
      const signal = init?.signal;
      assert.ok(signal);
      return await new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return response("finished");
  });
  const factory = createRuntimeHostFactory(root, () => ({ persistenceRoot: root, configStore: store }));
  const server = await startRuntimeHost(root, registry => factory("primary", { fresh: true, resourceRegistry: registry }), { createRuntime: factory, configDir: root });
  const client = await connectRuntimeHost(root, { surface: "cli", configDir: root });
  assert.ok(client);
  try {
    const options = { model: "alternate", headless: true, maxSteps: 3 };
    const { sessionId } = await client.ensureSession({ runOptions: options, writeIntent: true });
    const result = await client.executeRun(sessionId, "finish", [], options, "one-shot");
    assert.equal(result.status, "completed"); assert.equal(result.output, "finished");
    assert.equal(result.modelAlias, "alternate"); assert.equal(result.verificationStatus, "not_run");
    assert.equal(models.filter(model => model === "alternate").length, 1);
    assert.equal((await store.load(root)).defaultModel, "normal");
    assert.equal((await store.load(root)).permission.mode, config.permission.mode);
    assert.equal(client.getSnapshot("primary").info.modelAlias, "normal");
    const facts = await readSessionEvents(result.sessionFile);
    assert.equal(facts.filter(event => event.type === "turn_status").length, 1);
    assert.equal((await RuntimeEventAuthority.readLatestSessionRuns(root, [sessionId])).get(sessionId)?.status, "completed");
    const resumed = await client.ensureSession({ sessionId });
    assert.equal(resumed.snapshot.info.modelAlias, "normal", "resuming reloads persistent configuration");
    await writeFile(path.join(root, "result.txt"), "finished");
    const verification = JSON.stringify({ objective: "Produce a response", checks: [{ id: "ok", command: "node -e \"process.exit(0)\"", cwd: "." }], artifactPaths: ["result.txt"], allowedRepairPaths: ["result.txt"], maxAttempts: 1 });
    const verifiedOptions = { headless: true, verification };
    const next = await client.ensureSession({ runOptions: verifiedOptions, writeIntent: true });
    const verified = await client.executeRun(next.sessionId, "finish", [], verifiedOptions, "verified-shot");
    assert.equal(verified.verificationStatus, "completed");
    assert.equal(verified.deliveryStatus, "verified"); assert.ok(verified.taskRunId);
    for (const mode of ["cancel", "deadline"] as const) {
      const runOptions = mode === "deadline" ? { headless: true, deadlineAtMs: Date.now() + 2_000 } : { headless: true };
      const prepared = await client.ensureSession({ runOptions, writeIntent: true });
      pendingRequest = Promise.withResolvers<void>();
      const completed = client.executeRun(prepared.sessionId, "Wait for cancellation", [], runOptions, mode);
      await pendingRequest.promise;
      if (mode === "cancel") await client.cancelRunRequest(mode, "cancelled", prepared.sessionId);
      const cancelled = await completed;
      assert.equal(cancelled.status, "cancelled");
      const events = await readSessionEvents(cancelled.sessionFile);
      assert.equal(events.filter(event => event.type === "turn_status").length, 1);
      assert.equal((await RuntimeEventAuthority.readLatestSessionRuns(root, [prepared.sessionId])).get(prepared.sessionId)?.status, "cancelled");
      pendingRequest = undefined;
    }
    const prepared = await client.ensureSession({ runOptions: options, writeIntent: true });
    await assert.rejects(client.executeRun(prepared.sessionId, "finish", [], { ...options, model: "normal" }, "mismatch"), /options differ/u);
    const submit = await client.request<{ accepted: boolean }>("run.submit", { sessionId: prepared.sessionId, input: "finish", runId: "bypass" }).catch(error => String(error));
    assert.match(String(submit), /require run.execute/u);
    const other = await connectRuntimeHost(root, { surface: "cli", configDir: root });
    assert.ok(other);
    let abandoned: string;
    try {
      await assert.rejects(other.executeRun(prepared.sessionId, "finish", [], options, "foreign"), /fresh prepared session/u);
      abandoned = (await other.ensureSession({ runOptions: options, writeIntent: true })).sessionId;
    } finally { await other.close(); }
    const expiry = Date.now() + 5_000;
    while ((await client.request<Array<{ sessionId: string }>>("session.list")).some(entry => entry.sessionId === abandoned)) {
      assert.ok(Date.now() < expiry, "abandoned overrides must release their runtime");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await client.ensureSession({ sessionId: abandoned })).snapshot.info.modelAlias, "normal");
    assert.equal((await client.executeRun(prepared.sessionId, "finish", [], options, "bound-options")).status, "completed");

  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
