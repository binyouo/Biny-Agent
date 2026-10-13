/** Real edit/admission persistence regressions. External model output is controlled; no live provider is used. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { loadSkills, skillNamesForSelection, skillPromptForSelection } from "../src/extensions/skills.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionMessageMetadata } from "../src/session/messageTree.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

type Entry = "direct" | "runtime";
async function drain(stream: AsyncGenerator<AgentSessionEvent>, observe?: (event: AgentSessionEvent) => void) {
  const events: AgentSessionEvent[] = [];
  for await (const event of stream) { events.push(event); observe?.(event); }
  return events.reverse().find(event => event.type === "done")?.outcome;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-edit-loaded-skills-"));
  const previousRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  const cleanup: { close?: () => Promise<void> } = {};
  t.after(async () => {
    try { await cleanup.close?.(); }
    finally {
      if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  for (const name of ["skill-a", "skill-b"]) {
    const directory = path.join(root, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\nBODY_${name}\n`);
  }
  await ensureAgentDirs(root);
  const bundle = await loadSkills({ workspaceRoot: root, projectPaths: [], globalRoot: path.join(root, "isolated-skills") });
  const requests: string[] = [];
  let finish: "stop" | "length" = "stop";
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({
    workspaceRoot: root, config, recorder, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    skillPrompt: selection => skillPromptForSelection(bundle, selection),
    skillNames: selection => skillNamesForSelection(bundle, selection),
    selectCapabilities: input => preselectCapabilities({ ...input, models: [], tools: [], skills: bundle.skills }),
    model: {
      provider: "fixture", modelId: "edit-loaded-skills", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async (context, options) => {
        const main = options?.requestContext?.operation === "agent";
        if (main) requests.push(context.systemPrompt ?? "");
        const output: ModelStreamEvent[] = [
          { type: "text-delta", text: main ? "Fixture answer" : "Auxiliary answer" },
          { type: "finish", reason: main ? finish : "stop" }
        ];
        return (async function* () { yield* output; })();
      }
    }
  });
  // Same real runtime/admission harness used by retry-preflight-context-retention.
  // Only unrelated CommandRuntime extension hooks are inert.
  const runtime = new InteractiveAgentRuntime({
    agent, persistenceRoot: root, refreshSkills: async () => {},
    setSubagentParentRunId: () => {}, close: async () => await agent.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
  cleanup.close = async () => await runtime.close();
  const live: AgentHostEvent[] = [];
  runtime.subscribe(update => { if (update.event) live.push(update.event); });
  await agent.initialize();
  return {
    agent, runtime, requests, live,
    setFinish(value: typeof finish) { finish = value; },
    async events() { await recorder.flush(); return await readSessionEvents(recorder.filePath); },
    async start(entry: Entry) {
      const outcome = entry === "runtime"
        ? await runtime.submitPrompt("/skills:skill-a original").completion
        : await drain(agent.prompt("/skills:skill-a original", { emotionAnalysis: false }));
      assert.equal(outcome?.status, "completed");
      const events = await readSessionEvents(recorder.filePath);
      const original = events.find((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly);
      assert.ok(original?.messageId);
      assert.deepEqual(sessionMessageMetadata(events, original.messageId).loadedSkills, ["skill-a"], "fixture must establish real prompt-loaded A");
      assert.match(requests.at(-1) ?? "", /BODY_skill-a/u);
      return original;
    }
  };
}

function users(events: SessionEvent[]) {
  return events.filter((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly);
}
function loadedPatches(events: SessionEvent[]) {
  return events.filter((event): event is Extract<SessionEvent, { type: "message_metadata" }> =>
    event.type === "message_metadata" && event.metadata.loadedSkills !== undefined);
}
function assertEditMetadata(events: SessionEvent[], originalId: string, input: string, expected: string[]) {
  const replacement = users(events).find(event => event.content === input);
  assert.ok(replacement?.messageId);
  assert.notEqual(replacement.messageId, originalId);
  assert.equal(users(events).length, 2, "admission and execution must share one replacement user");
  assert.deepEqual(sessionMessageMetadata(events, originalId).loadedSkills, ["skill-a"], "editing must not rewrite the original version's loaded skills");
  assert.deepEqual(sessionMessageMetadata(events, replacement.messageId).loadedSkills, expected, "prepared skills belong to the canonical replacement user");
  const patches = loadedPatches(events).filter(event => event.messageId === replacement.messageId);
  assert.equal(patches.length, 1, "replacement metadata is recorded once");
  assert.ok(events.indexOf(replacement) < events.indexOf(patches[0]!), "canonical user must precede its metadata");
  assert.equal(patches[0]!.runtime?.runId, replacement.runtime?.runId);
  assert.equal(replacement.slotId, users(events).find(event => event.messageId === originalId)?.slotId);
  assert.equal(replacement.parentMessageId, users(events).find(event => event.messageId === originalId)?.parentMessageId);
  return replacement;
}

for (const entry of ["direct", "runtime"] as const) {
  for (const named of [true, false]) {
    test(`${entry} edit persists ${named ? "B" : "empty skills"} on the replacement and preserves A`, async t => {
      const f = await fixture(t);
      const original = await f.start(entry);
      const input = named ? "/skills:skill-b edited" : "edited without a skill";
      const outcome = entry === "runtime"
        ? await f.runtime.submitPrompt(input, [], { retryOfMessageId: original.messageId, replaceUserMessageId: original.messageId }).completion
        : await drain(f.agent.retry(original.messageId!, {
          replaceUserMessageId: original.messageId, replacementInput: input,
          replacementUserMessageId: "direct-edited-user", emotionAnalysis: false
        }));
      assert.equal(outcome?.status, "completed");
      const expected = named ? ["skill-b"] : [];
      const events = await f.events();
      const replacement = assertEditMetadata(events, original.messageId!, input, expected);
      if (entry === "direct") assert.equal(replacement.messageId, "direct-edited-user");
      else assert.ok(f.live.some(event => event.type === "message.user" && event.messageId === replacement.messageId && event.content === input));
      if (named) assert.match(f.requests.at(-1) ?? "", /BODY_skill-b/u);
      assert.doesNotMatch(f.requests.at(-1) ?? "", /BODY_skill-a/u);
      const editedTurn = buildSessionTimeline(events, [])[0];
      assert.equal(editedTurn?.userMessageId, replacement.messageId);
      assert.deepEqual(editedTurn?.skills, expected, "historical projection must match the live prepared list");
      assert.ok(editedTurn?.assistantMessageId);
      await f.agent.switchMessageVersion(editedTurn.assistantMessageId, "prev");
      const oldTurn = buildSessionTimeline(await f.events(), [])[0];
      assert.equal(oldTurn?.userMessageId, original.messageId);
      assert.deepEqual(oldTurn?.skills, ["skill-a"]);
      assert.ok(oldTurn?.assistantMessageId);
      await f.agent.switchMessageVersion(oldTurn.assistantMessageId, "next");
      assert.deepEqual(buildSessionTimeline(await f.events(), [])[0]?.skills, expected);
    });
  }

  test(`${entry} cancellation after edit preparation still records the prepared replacement skills`, async t => {
    const f = await fixture(t);
    const original = await f.start(entry);
    const calls = f.requests.length;
    const input = "/skills:skill-b cancel after preparation";
    let prepared = false;
    let outcome: Awaited<ReturnType<typeof drain>>;
    if (entry === "runtime") {
      const unsubscribe = f.runtime.subscribe(update => {
        if (update.event?.type !== "context.updated" || !update.event.context.loadedSkills?.includes("skill-b")) return;
        prepared = true;
        f.runtime.cancelCurrentRun("cancelled");
      });
      try { outcome = await f.runtime.submitPrompt(input, [], { retryOfMessageId: original.messageId, replaceUserMessageId: original.messageId }).completion; }
      finally { unsubscribe(); }
    } else {
      const controller = new AbortController();
      outcome = await drain(f.agent.retry(original.messageId!, {
        replaceUserMessageId: original.messageId, replacementInput: input,
        abortSignal: controller.signal, emotionAnalysis: false
      }), event => {
        if (event.type === "context.updated" && event.context.loadedSkills?.includes("skill-b")) {
          prepared = true;
          controller.abort(new AgentTurnCancellationError("cancelled"));
        }
      });
    }
    assert.equal(prepared, true, "cancel only after real prompt assembly published B");
    assert.equal(outcome?.status, "cancelled");
    assert.equal(f.requests.length, calls, "the cancelled edit must not call the main model");
    assertEditMetadata(await f.events(), original.messageId!, input, ["skill-b"]);
  });
}

test("ordinary retry still clears its own freshly prepared empty loaded list", async t => {
  const f = await fixture(t);
  const original = await f.start("direct");
  assert.equal((await drain(f.agent.retry(original.messageId!, {
    capabilitySelection: { tools: [], skills: "none" }, emotionAnalysis: false
  })))?.status, "completed");
  const events = await f.events();
  assert.equal(users(events).length, 1);
  assert.deepEqual(sessionMessageMetadata(events, original.messageId!).loadedSkills, []);
  assert.equal(loadedPatches(events).length, 2);
});

test("ordinary continuation without an edit payload preserves the existing loaded list", async t => {
  const f = await fixture(t);
  f.setFinish("length");
  assert.equal((await drain(f.agent.prompt("/skills:skill-a unfinished", { emotionAnalysis: false })))?.status, "incomplete");
  const before = await f.events();
  const user = users(before)[0];
  assert.ok(user?.messageId);
  assert.deepEqual(sessionMessageMetadata(before, user.messageId).loadedSkills, ["skill-a"]);
  f.setFinish("stop");
  assert.equal((await drain(f.agent.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
  const after = await f.events();
  assert.deepEqual(loadedPatches(after), loadedPatches(before), "absence of a fresh edit list must not append an empty patch");
  assert.deepEqual(sessionMessageMetadata(after, user.messageId).loadedSkills, ["skill-a"]);
});
