/** Real completed conversations supply the material; only model and local tool I/O are fixtures. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

type AgentSession = import("../src/agent/AgentSession.js").AgentSession;
type AgentModel = import("../src/agent/core/types.js").AgentModel;
type ModelStreamEvent = import("../src/agent/core/types.js").ModelStreamEvent;
type CrystalMaterial = import("../src/agent/context/crystalTypes.js").CrystalMaterial;
type CrystalHttpRequest = import("../src/agent/context/crystalHttp.js").CrystalHttpRequest;

const middleText = "The intermediate evidence names the project Cedar.";
const finalText = "The inspection is complete.";
const question = "Inspect the fixture and summarize the result.";
const reasoningMarker = "PRIVATE_REASONING_NOT_A_MATERIAL";
const argumentMarker = "TOOL_ARGUMENT_NOT_A_MATERIAL";
const resultMarker = "TOOL_RESULT_NOT_A_MATERIAL";

async function fixture(t: TestContext, text = middleText) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-crystal-canonical-")));
  const previous = process.env.BINY_AGENT_DIR;
  const credentialEnv = "BINY_CRYSTAL_CANONICAL_TEST_API_KEY";
  const previousCredential = process.env[credentialEnv];
  const globalRoot = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  process.env.BINY_AGENT_DIR = globalRoot;
  delete process.env[credentialEnv];
  const sessions = new Set<AgentSession>();
  t.after(async () => {
    try {
      for (const session of sessions) await session.close();
    } finally {
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      if (previousCredential === undefined) delete process.env[credentialEnv];
      else process.env[credentialEnv] = previousCredential;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in crystal material fixture"); });
  await mkdir(workspace, { recursive: true });
  // Product modules load only after the temporary configuration/storage root and network guard exist.
  const [{ AgentSession }, { defaultConfig }, { PermissionManager }, { SessionRecorder },
    { ensureAgentDirs }, { ToolRegistry }, { z }, { readSessionEvents },
    { sessionMessageTree, activeSessionMessageIds }, { DesktopCrystalService },
    { CrystalStorage }, { handleCrystalHttpRequest }] = await Promise.all([
    import("../src/agent/AgentSession.js"), import("../src/config/schema.js"),
    import("../src/permission/PermissionManager.js"), import("../src/session/recorder.js"),
    import("../src/session/store.js"), import("../src/tools/registry.js"), import("zod"),
    import("../src/session/events.js"), import("../src/session/messageTree.js"),
    import("../src/desktop/electron/main/DesktopCrystalService.js"),
    import("../src/agent/context/crystalStorage.js"), import("../src/agent/context/crystalHttp.js")
  ]);
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  // Keep resolvable model metadata for public retry/getInfo, but no available auxiliary provider.
  config.providers = { deepseek: { type: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyEnv: credentialEnv } };
  config.toolModel = undefined;
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  config.agent.toolExecutionMode = "direct";
  config.permission.mode = "full-access";
  const registry = new ToolRegistry();
  let toolCalls = 0;
  registry.register({
    name: "inspect_fixture", description: "Read a synthetic local value", risk: "read",
    parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
    schema: z.object({ marker: z.string() }),
    resolveExecution: () => ({ approvalRule: "inspect_fixture", retrySafety: "safe", accesses: [], execute: async () => {
      toolCalls += 1;
      return { marker: resultMarker };
    } })
  });
  let agentCalls = 0;
  let reply: Record<string, { value: string; sources: string[] }> = {};
  const prefills: string[] = [];
  const model: AgentModel = {
    provider: "fixture", modelId: "crystal-canonical", runtime: "builtin-llama.cpp", dataResidency: "local", supportsTools: true,
    stream: async (request, options) => {
      let events: ModelStreamEvent[];
      if (request.systemPrompt?.startsWith("你是一个资料整理员。")) {
        prefills.push(JSON.stringify(request.messages));
        events = [{ type: "text-delta", text: JSON.stringify(reply) }, { type: "finish", reason: "stop" }];
      } else {
        assert.equal(options?.requestContext?.operation, "agent", "no other auxiliary model is permitted");
        agentCalls += 1;
        events = agentCalls === 1 ? [
          { type: "reasoning-start", id: "fixture-reasoning" },
          { type: "reasoning-delta", id: "fixture-reasoning", text: reasoningMarker },
          { type: "reasoning-end", id: "fixture-reasoning" },
          ...(text ? [{ type: "text-delta" as const, text }] : []),
          { type: "tool-call", id: "canonical-inspection", name: "inspect_fixture", arguments: { marker: argumentMarker } },
          { type: "finish", reason: "tool-calls" }
        ] : [{ type: "text-delta", text: finalText }, { type: "finish", reason: "stop" }];
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield* events; })();
    }
  };
  const recorder = new SessionRecorder(workspace);
  const session = new AgentSession({ workspaceRoot: workspace, config, model, recorder, toolRegistry: registry,
    permissionManager: new PermissionManager(config.permission) });
  sessions.add(session);
  await session.initialize();
  let completed = false;
  for await (const event of session.prompt(question, { emotionAnalysis: false })) {
    assert.notEqual(event.type, "error");
    if (event.type === "done") { assert.equal(event.outcome.status, "completed"); completed = true; }
  }
  assert.equal(completed, true);
  assert.equal(agentCalls, 2);
  assert.equal(toolCalls, 1);
  await recorder.flush();
  const events = await readSessionEvents(recorder.filePath);
  const nodes = sessionMessageTree(events);
  const middle = nodes.find(node => node.message.role === "assistant"
    && node.message.content.some(part => part.type === "toolCall" && part.id === "canonical-inspection"));
  const user = nodes.find(node => node.message.role === "user");
  const final = nodes.filter(node => node.message.role === "assistant").at(-1);
  const tool = nodes.find(node => node.message.role === "toolResult");
  assert.ok(middle && user && final && tool);
  assert.equal(activeSessionMessageIds(events).has(middle.id), true, "the regression source is on the current active path");
  assert.equal(events.some(event => (event.type === "user_message" || event.type === "assistant_message")
    && event.messageId === middle.id), false, "the real intermediate source has no same-ID flat audit");
  assert.equal(events.some(event => event.type === "assistant_message" && event.messageId === final.id), true);
  const desktop = new DesktopCrystalService({ load: async () => config, save: async () => undefined },
    async () => [workspace], () => new CrystalStorage({ agentDir: globalRoot }));
  const core = session.getCrystalService();
  async function request(input: CrystalHttpRequest) {
    const response = await handleCrystalHttpRequest(input, { service: core, getConfig: () => config.crystal });
    assert.ok(response);
    return response;
  }
  async function seed() {
    const snapshot = await desktop.request({ action: "seed", name: "Cedar", sessionId: recorder.sessionId });
    assert.ok(snapshot.detail);
    const material = snapshot.detail.materials.find(material => material.kind === "turn"
      && (material.ref as { anchorId?: string }).anchorId === middle.id);
    assert.ok(material);
    assert.equal(snapshot.detail.materials.some(material => (material.ref as { anchorId?: string }).anchorId === tool.id), false);
    assert.equal(snapshot.detail.materialPreviews[material.id], text || undefined);
    await desktop.request({ action: "type", id: snapshot.detail.crystal.id, type: "concept" });
    return { id: snapshot.detail.crystal.id, material, snapshot };
  }
  async function singleMaterial(kind: "turn" | "bundle", ref: unknown) {
    const created = await request({ method: "POST", pathname: "/api/crystal/seeds", body: { name: "Single source" } });
    assert.equal(created.status, 200);
    const id = (created.body as { id: string }).id;
    assert.equal((await request({ method: "POST", pathname: `/api/crystal/${id}/type`, body: { type: "concept" } })).status, 200);
    assert.equal((await request({ method: "POST", pathname: `/api/crystal/${id}/material`, body: { kind, ref } })).status, 200);
    return { id, material: core.storage.listMaterials(id)[0]! };
  }
  async function savedDefinition(id: string) {
    const storage = new CrystalStorage({ agentDir: globalRoot });
    try { await storage.initialize(); return storage.getCrystal(id)?.checklist.definition; }
    finally { storage.close(); }
  }
  return { session, recorder, core, desktop, seed, singleMaterial, request, savedDefinition, prefills, middle, user, final, tool,
    readSessionEvents, activeSessionMessageIds,
    replyFrom(tag: string) { reply = { definition: { value: "Cedar is the project named in the intermediate evidence.", sources: [tag] } }; },
    async closeSourceAndOpenReader() {
      await session.close();
      sessions.delete(session);
      const reader = new AgentSession({ workspaceRoot: workspace, config, model, recorder: new SessionRecorder(workspace),
        toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
      sessions.add(reader);
      await reader.initialize();
      return reader.getCrystalService();
    }
  };
}

test("Desktop-selected active canonical assistant evidence reaches the real runtime prefill request", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { id, material } = await f.seed();
  const tag = `turn:${f.middle.id}`;
  f.replyFrom(tag);
  const result = await f.core.prefill(id);
  assert.equal(f.prefills.length, 1);
  assert.equal(f.prefills[0]!.includes(middleText), true, "runtime prefill must include the material Desktop actually previews");
  assert.equal(f.prefills[0]!.includes(`[${tag}]`), true);
  assert.equal(f.prefills[0]!.includes(reasoningMarker), false);
  assert.equal(f.prefills[0]!.includes(argumentMarker), false);
  assert.equal(f.prefills[0]!.includes(resultMarker), false);
  assert.deepEqual(result.checklist.definition?.sources, [tag]);
  assert.deepEqual(await f.savedDefinition(id), result.checklist.definition);
  assert.equal(await f.core.readMaterialText(material), middleText);
});

test("runtime direct material reading matches Desktop's current canonical preview", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { material } = await f.seed();
  assert.equal(await f.core.readMaterialText(material), middleText);
});

for (const kind of ["turn", "bundle"] as const) {
  test(`HTTP prefill accepts a ${kind} whose only readable evidence is an active canonical assistant`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const ref = kind === "turn" ? { threadId: f.recorder.sessionId, anchorId: f.middle.id }
      : { bundleId: f.core.storage.insertBundle({ threadId: f.recorder.sessionId, anchorIds: [f.middle.id] }).id };
    const { id, material } = await f.singleMaterial(kind, ref);
    const tag = kind === "turn" ? `turn:${f.middle.id}` : `bundle:${material.id}`;
    const preview = await f.desktop.request({ action: "detail", id });
    assert.equal(preview.detail?.materialPreviews[material.id], middleText);
    f.replyFrom(tag);
    const response = await f.request({ method: "POST", pathname: `/api/crystal/${id}/prefill` });
    assert.equal(response.status, 200, "a real saved canonical source is not an unreadable-material conflict");
    assert.equal(f.prefills.length, 1);
    assert.equal(f.prefills[0]!.includes(`[${tag}] ${middleText}`), true);
    assert.deepEqual((await f.savedDefinition(id))?.sources, [tag]);
  });
}

test("ordinary user and final audit material retain their existing text", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { snapshot } = await f.seed();
  for (const [anchorId, expected] of [[f.user.id, question], [f.final.id, finalText]]) {
    const material = snapshot.detail!.materials.find(material => (material.ref as { anchorId?: string }).anchorId === anchorId);
    assert.ok(material);
    assert.equal(await f.core.readMaterialText(material), expected);
  }
});

test("an existing flat audit remains preferred over canonical fallback", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { material } = await f.seed();
  await f.recorder.recordAndFlush({ type: "assistant_message", messageId: f.middle.id, content: "  Legacy audit text stays exact.  " });
  assert.equal(await f.core.readMaterialText(material), "  Legacy audit text stays exact.  ");
});

test("canonical tool results cannot become source text or trigger prefill", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { id, material } = await f.singleMaterial("turn", { threadId: f.recorder.sessionId, anchorId: f.tool.id });
  assert.equal(await f.core.readMaterialText(material), undefined);
  assert.equal((await f.request({ method: "POST", pathname: `/api/crystal/${id}/prefill` })).status, 409);
  assert.deepEqual(f.prefills, []);
});

test("reasoning and tool-call-only canonical assistants do not supply readable material", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "");
  const { id, material } = await f.singleMaterial("turn", { threadId: f.recorder.sessionId, anchorId: f.middle.id });
  assert.equal(Boolean(await f.core.readMaterialText(material)), false);
  const preview = await f.desktop.request({ action: "detail", id });
  assert.equal(preview.detail?.materialPreviews[material.id], undefined);
  assert.equal((await f.request({ method: "POST", pathname: `/api/crystal/${id}/prefill` })).status, 409);
  assert.deepEqual(f.prefills, []);
});

test("wrong thread, prefix, traversal and absent anchors remain unreadable", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { material } = await f.seed();
  for (const ref of [
    { threadId: "missing-session", anchorId: f.middle.id },
    { threadId: f.recorder.sessionId.slice(0, -1), anchorId: f.middle.id },
    { threadId: "../outside", anchorId: f.middle.id },
    { threadId: f.recorder.sessionId, anchorId: "missing-anchor" }
  ]) assert.equal(await f.core.readMaterialText({ ...material, ref }), undefined);
});

test("a deleted source file remains unavailable in a different live runtime", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { id, material } = await f.seed();
  const reader = await f.closeSourceAndOpenReader();
  await rm(f.recorder.filePath);
  assert.equal(await reader.readMaterialText(material), undefined);
  const preview = await f.desktop.request({ action: "detail", id });
  assert.equal(preview.detail?.materialPreviews[material.id], undefined);
  assert.equal(preview.detail?.materials.some(candidate => candidate.id === material.id), true, "unavailable original text does not erase its stored reference");
  await assert.rejects(reader.prefill(id), /Materials have no readable text/u);
  assert.deepEqual(f.prefills, []);
});

test("editing the source branch does not open an inactive canonical-only anchor", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const { id, material } = await f.seed();
  let completed = false;
  for await (const event of f.session.retry(f.user.id, {
    replaceUserMessageId: f.user.id, replacementInput: "Use the replacement question instead.", emotionAnalysis: false
  })) {
    assert.notEqual(event.type, "error");
    if (event.type === "done") { assert.equal(event.outcome.status, "completed"); completed = true; }
  }
  assert.equal(completed, true);
  await f.recorder.flush();
  const events = await f.readSessionEvents(f.recorder.filePath);
  assert.equal(f.activeSessionMessageIds(events).has(f.middle.id), false, "the public edit operation moved the source off the active path");
  assert.equal(events.some(event => event.type === "agent_message" && event.messageId === f.middle.id), true);
  assert.equal(await f.core.readMaterialText(material), undefined);
  const preview = await f.desktop.request({ action: "detail", id });
  assert.equal(preview.detail?.materialPreviews[material.id], undefined);
  const oldUser = { ...material, ref: { threadId: f.recorder.sessionId, anchorId: f.user.id } } satisfies CrystalMaterial;
  assert.equal(await f.core.readMaterialText(oldUser), question, "the existing legacy reader policy is unchanged");
});
