/**
 * Public Runtime steering must survive Claude export/import as one delivered input.
 * These are real AgentSession/Recorder/Runtime, transfer, persistence, replay and
 * timeline paths. Only model transport and unrelated CommandRuntime services are
 * fixture adapters. This is not a socket Host or rendered Electron UI fixture.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { ExportedSessionFile } from "../src/session/transfer.js";

// Install isolation before loading any production module, including SDK adapters.
const suiteRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-export-steering-")));
const previousAgentDir = process.env.BINY_AGENT_DIR;
const previousFetch = globalThis.fetch;
const unexpectedNetwork: string[] = [];
const workspaces = new Set<string>();
const catalogCleanup: { refresh?: (workspace: string) => Promise<void> } = {};
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
globalThis.fetch = async (input: string | URL | Request) => {
  unexpectedNetwork.push(input instanceof Request ? input.url : String(input));
  throw new Error("Unexpected network request");
};
after(async () => {
  try {
    if (catalogCleanup.refresh) await Promise.all([...workspaces].map(workspace => catalogCleanup.refresh!(workspace)));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(suiteRoot, { recursive: true, force: true });
  }
  assert.deepEqual(unexpectedNetwork, [], "background code must not swallow attempted network access");
});
const [agentModule, configModule, timelineModule, permissionModule, runtimeModule,
  eventsModule, recorderModule, replayModule, storeModule, transferModule, toolsModule, catalogModule] = await Promise.all([
  import("../src/agent/AgentSession.js"), import("../src/config/schema.js"),
  import("../src/desktop/renderer/src/sessionTimeline.js"), import("../src/permission/PermissionManager.js"),
  import("../src/runtime/InteractiveAgentRuntime.js"), import("../src/session/events.js"),
  import("../src/session/recorder.js"), import("../src/session/replay.js"),
  import("../src/session/store.js"), import("../src/session/transfer.js"),
  import("../src/tools/registry.js"), import("../src/session/catalog.js")
]);
const { AgentSession } = agentModule;
const { defaultConfig } = configModule;
const { buildSessionTimeline } = timelineModule;
const { PermissionManager } = permissionModule;
const { InteractiveAgentRuntime } = runtimeModule;
const { readStoredSessionEvents } = eventsModule;
const { SessionRecorder } = recorderModule;
const { replaySessionEvents } = replayModule;
const { ensureAgentDirs } = storeModule;
const { exportSessionBundle, exportSessionClaudeCode, importSessionFile } = transferModule;
const { ToolRegistry } = toolsModule;
const { refreshSessionIndex } = catalogModule;
catalogCleanup.refresh = refreshSessionIndex;
type Session = InstanceType<typeof AgentSession>;
type Runtime = InstanceType<typeof InteractiveAgentRuntime>;

const originalInput = "Start the source conversation";
const steeringInput = "Use the revised requirement";
const steeringId = "public-steering-input";

interface ClaudeLine {
  type: string;
  message: { role: string; content: string | Array<{
    type: string; id?: string; name?: string; tool_use_id?: string;
    text?: string; content?: string;
  }> };
}

function claudeLines(content: string): ClaudeLine[] {
  return content.trim().split("\n").map(line => JSON.parse(line) as ClaudeLine);
}

function claudeUserTexts(content: string): string[] {
  return claudeLines(content).flatMap(line => line.type === "user" && line.message.role === "user"
    && typeof line.message.content === "string" ? [line.message.content] : []);
}

function userText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string" ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function visibleInputs(events: SessionEvent[], sessionId: string): string[] {
  return replaySessionEvents(events, { sessionId }).messages
    .filter(message => message.role === "user").map(userText);
}

function receipt(event: SessionEvent): boolean {
  return event.type === "user_message" && event.auditOnly === true
    && (event.metadata?.queuedDelivery === "steer" || event.metadata?.queuedDelivery === "queue");
}

async function fixture(t: TestContext, steer = true) {
  const root = await mkdtemp(path.join(suiteRoot, "case-"));
  const workspace = path.join(root, "workspace");
  workspaces.add(workspace);
  const resources: { agent?: Session; runtime?: Runtime } = {};
  t.after(async () => {
    try {
      if (resources.runtime) await resources.runtime.close();
      else await resources.agent?.close();
    } finally {
      try { await refreshSessionIndex(workspace); }
      finally {
        workspaces.delete(workspace);
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  await mkdir(workspace);
  await ensureAgentDirs(workspace);
  const config = structuredClone(defaultConfig);
  config.agent.toolExecutionMode = "direct";
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.diagnostics.enabled = false;
  config.chat.skillExtraction.enabled = false;
  const requests: AgentMessage[][] = [];
  let acceptedSteering: Awaited<ReturnType<Runtime["steer"]>> | undefined;
  const model: AgentModel = {
    provider: "fixture", modelId: "export-steering", runtime: "builtin-llama.cpp",
    dataResidency: "local", supportsTools: true,
    async stream(context, options) {
      const primary = options?.requestContext?.operation === "agent";
      if (primary) {
        requests.push(structuredClone(context.messages));
        if (steer && requests.length === 1) {
          assert.ok(resources.runtime);
          acceptedSteering = await resources.runtime.steer(steeringInput, [], { messageId: steeringId });
        }
      }
      const response: ModelStreamEvent[] = [
        { type: "text-delta", text: primary ? `Source answer ${String(requests.length)}` : "Auxiliary title" },
        { type: "finish", reason: "stop" }
      ];
      return (async function* () { yield* response; })();
    }
  };
  const recorder = new SessionRecorder(workspace);
  const agent = new AgentSession({ workspaceRoot: workspace, config, model, recorder,
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission) });
  resources.agent = agent;
  await agent.initialize();
  // Same minimal surrounding-service adapter as retry-visible-root.test.ts.
  // Steering, delivery, message identities and persistence remain production code.
  const session = agent;
  const runtime = new InteractiveAgentRuntime({ agent: session, persistenceRoot: workspace,
    refreshSkills: async () => {}, setSubagentParentRunId: () => {},
    close: async () => await session.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
  resources.runtime = runtime;
  const liveRuntime = runtime;
  const submitted = liveRuntime.submitPrompt(originalInput);
  const outcome = await submitted.completion;
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  await liveRuntime.waitForIdle();
  await recorder.flush();
  // Closing joins auxiliary title/memory work before byte-preservation checks.
  // The ordinary-input/hosted controls close only after their extra public action.
  if (steer) await liveRuntime.close();
  const sessionId = session.getInfo().sessionId;
  const source = await readStoredSessionEvents(workspace, sessionId);
  if (steer) {
    assert.equal(acceptedSteering?.messageId, steeringId);
    assert.equal(acceptedSteering?.runId, submitted.runId);
    assert.equal(acceptedSteering?.delivery, "steer");
    assert.equal(requests.length, 2, "a real second model request must consume the delivered steering");
    assert.equal(requests[1]!.filter(message => message.role === "user"
      && userText(message).endsWith(steeringInput)).length, 1);
    const facts = source.events.filter(event => event.type === "user_message" && event.messageId === steeringId);
    assert.equal(facts.length, 2, "real producer must persist receipt and delivery, not a hand-written history");
    assert.equal(facts.filter(receipt).length, 1);
    assert.equal(facts.filter(event => event.type === "user_message" && !event.auditOnly).length, 1);
    assert.deepEqual(visibleInputs(source.events, sessionId), [originalInput, steeringInput]);
    assert.equal(buildSessionTimeline(source.events, []).filter(turn => turn.user === steeringInput).length, 1);
  }
  const sourceBytes = await readFile(source.filePath);
  return { root, workspace, session, runtime: liveRuntime, recorder, sessionId, source, sourceBytes,
    async finish() {
      await liveRuntime.close();
      return await readStoredSessionEvents(workspace, sessionId);
    },
    async importFile(exported: ExportedSessionFile, format: "biny" | "claude") {
      const file = path.join(root, `roundtrip-${format}.${exported.extension}`);
      await writeFile(file, exported.content);
      const imported = await importSessionFile(workspace, file, { format });
      // Import deliberately schedules this refresh; join its coalesced worker.
      await refreshSessionIndex(workspace);
      assert.notEqual(imported.sessionId, sessionId);
      assert.equal(imported.format, format);
      const stored = await readStoredSessionEvents(workspace, imported.sessionId);
      assert.equal(await readFile(file, "utf8"), exported.content, "import must not alter its source");
      return { imported, stored };
    }
  };
}

test("Claude export writes one user input for publicly delivered steering", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const exported = await exportSessionClaudeCode(f.workspace, f.sessionId);
  assert.deepEqual(claudeUserTexts(exported.content), [originalInput, steeringInput]);
  assert.deepEqual(await readFile(f.source.filePath), f.sourceBytes);
});

test("Claude import persists and displays publicly delivered steering only once", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const exported = await exportSessionClaudeCode(f.workspace, f.sessionId);
  const { imported, stored } = await f.importFile(exported, "claude");
  // Deliberately do not assert export cardinality first: this target reaches the
  // importer, new session file and actual read/replay/timeline consumer on Red.
  const users = stored.events.filter(event => event.type === "user_message");
  assert.equal(new Set(users.map(event => event.messageId)).size, users.length);
  assert.deepEqual({
    persisted: users.map(event => event.content),
    replayed: visibleInputs(stored.events, imported.sessionId),
    displayed: buildSessionTimeline(stored.events, []).map(turn => turn.user)
  }, {
    persisted: [originalInput, steeringInput],
    replayed: [originalInput, steeringInput],
    displayed: [originalInput, steeringInput]
  });
  assert.deepEqual(await readFile(f.source.filePath), f.sourceBytes);
});

test("Biny archival roundtrip keeps receipt facts while replaying one delivery", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const exported = await exportSessionBundle(f.workspace, f.sessionId);
  const bundle = JSON.parse(exported.content) as { events: SessionEvent[] };
  assert.deepEqual(bundle.events, f.source.events, "native bundle is still the physical audit archive");
  assert.equal(bundle.events.filter(receipt).length, 1);
  const { imported, stored } = await f.importFile(exported, "biny");
  assert.equal(stored.events.filter(receipt).length, 1);
  assert.equal(stored.events.filter(event => event.type === "user_message" && event.messageId === steeringId).length, 2);
  assert.deepEqual(visibleInputs(stored.events, imported.sessionId), [originalInput, steeringInput]);
  assert.deepEqual(buildSessionTimeline(stored.events, []).map(turn => turn.user), [originalInput, steeringInput]);
  assert.deepEqual(await readFile(f.source.filePath), f.sourceBytes);
});

test("two genuine public inputs with the same text remain separate after Claude roundtrip", { timeout: 20_000 }, async t => {
  const f = await fixture(t, false);
  const second = f.runtime.submitPrompt(originalInput);
  assert.equal((await second.completion).status, "completed");
  await f.runtime.waitForIdle();
  const source = await f.finish();
  const users = source.events.filter((event): event is Extract<SessionEvent, { type: "user_message" }> =>
    event.type === "user_message" && !event.auditOnly);
  assert.equal(users.length, 2);
  assert.notEqual(users[0]!.messageId, users[1]!.messageId);
  const exported = await exportSessionClaudeCode(f.workspace, f.sessionId);
  assert.deepEqual(claudeUserTexts(exported.content), [originalInput, originalInput]);
  const { imported, stored } = await f.importFile(exported, "claude");
  assert.deepEqual(visibleInputs(stored.events, imported.sessionId), [originalInput, originalInput]);
  assert.deepEqual(buildSessionTimeline(stored.events, []).map(turn => turn.user), [originalInput, originalInput]);
});

test("hosted audit conversation and tool facts remain in compatible export", { timeout: 20_000 }, async t => {
  const f = await fixture(t, false);
  f.session.recordHostedUserMessage("HOSTED_USER_INPUT");
  const sequence = f.session.recordHostedToolCall("Read", { path: "hosted.txt" }, "hosted-call");
  f.session.recordHostedToolResult("Read", "HOSTED_TOOL_RESULT", "hosted-call", sequence);
  f.session.recordHostedAssistantMessage("HOSTED_ASSISTANT_REPLY");
  const source = await f.finish();
  const hostedUser = source.events.find(event => event.type === "user_message" && event.content === "HOSTED_USER_INPUT");
  assert.ok(hostedUser?.type === "user_message" && hostedUser.auditOnly);
  assert.equal(hostedUser.metadata?.queuedDelivery, undefined);
  assert.equal(source.events.filter(receipt).length, 0);
  const exported = await exportSessionClaudeCode(f.workspace, f.sessionId);
  assert.deepEqual(claudeUserTexts(exported.content), [originalInput, "HOSTED_USER_INPUT"]);
  const blocks = claudeLines(exported.content).flatMap(line => Array.isArray(line.message.content) ? line.message.content : []);
  assert.equal(blocks.filter(block => block.type === "tool_use" && block.id === "hosted-call" && block.name === "Read").length, 1);
  assert.equal(blocks.filter(block => block.type === "tool_result" && block.tool_use_id === "hosted-call"
    && block.content === "HOSTED_TOOL_RESULT").length, 1);
  assert.equal(blocks.filter(block => block.type === "text" && block.text === "HOSTED_ASSISTANT_REPLY").length, 1);
  const bundle = JSON.parse((await exportSessionBundle(f.workspace, f.sessionId)).content) as { events: SessionEvent[] };
  assert.deepEqual(bundle.events, source.events);
});
