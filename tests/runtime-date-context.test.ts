import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import { estimateMessageTokens, estimateTokens } from "../src/agent/context/tokenUsage.js";
import type { AgentMessage, AgentModel } from "../src/agent/core/types.js";
import { buildPromptBundle, appendRuntimeDateContext, stripTransientTurnContext } from "../src/agent/prompts.js";
import { TurnStore } from "../src/session/turnStore.js";

test("date reservation survives auxiliary-context omission and the request counts the appended message", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-date-budget-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const model: AgentModel = testModel({
    provider: "fixture", modelId: "date-budget", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => { throw new Error("No model request expected"); }
  });
  const context = new ContextMemory(() => model, new WorkspaceContext(root, [], 4096), undefined,
    1000, 4096, undefined, undefined, { enabled: false, reserveTokens: 100 });
  context.replaceHistory([{ role: "user", content: "older context ".repeat(60) },
    { role: "assistant", content: [{ type: "text", text: "retained answer ".repeat(60) }] }]);
  const now = new Date("2026-10-08T18:15:00Z");
  const prompt = buildPromptBundle({ cwd: root, now, dailyNotesPrompt: "auxiliary notes ".repeat(3000) });
  const prepared = await context.prepareTurn("current task ".repeat(300), prompt, undefined, [], false);
  const before = (await context.status()).budget;
  assert.equal(before.usedTokens, estimateTokens(prepared.systemPrompt ?? "") + estimateMessageTokens(prepared.messages));
  appendRuntimeDateContext(prepared.messages, now);
  const date = prepared.messages.at(-1)!;
  assert.equal(date.content, prompt.dateContext);
  assert.ok(date.role === "user" && date.runtimeDateContext);
  assert.ok(estimateTokens(prepared.systemPrompt ?? "") + estimateMessageTokens(prepared.messages) <= before.maxTokens - (before.reserveTokens ?? 0));
  assert.doesNotMatch(prepared.systemPrompt ?? "", /Authoritative local date/u);
});

for (const sample of [
  { zone: "America/St_Johns", date: "2026-10-08", weekday: "Thursday", offset: "UTC-2:30" },
  { zone: "Asia/Katmandu", date: "2026-10-09", weekday: "Friday", offset: "UTC+5:45" }
]) {
  test(`date updates append without rewriting multimedia or literal markers in ${sample.zone}`, t => {
    const previousZone = process.env.TZ;
    process.env.TZ = sample.zone;
    t.after(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
    const messages: AgentMessage[] = [{ role: "user", content: [
      { type: "image", mimeType: "image/png", data: "fixture" },
      { type: "text", text: "Literal <biny_date_context>keep</biny_date_context> <biny_reminder>keep</biny_reminder>" }
    ], sentAt: "2026-10-07T15:59:59Z", sentAtTimeZone: "Asia/Shanghai" }];
    const original = structuredClone(messages);
    appendRuntimeDateContext(messages, new Date("2026-10-09T00:00:00Z"));
    assert.deepEqual(messages.slice(0, 1), original);
    const first = structuredClone(messages);
    assert.match(String(messages[1]!.content), new RegExp(`Authoritative local date: ${sample.date}`, "u"));
    assert.ok(String(messages[1]!.content).includes(`Timezone: ${sample.offset} (${sample.zone})`));
    assert.ok(String(messages[1]!.content).includes(`Weekday: ${sample.weekday}`));
    appendRuntimeDateContext(messages, new Date("2026-10-09T00:00:01Z"));
    assert.deepEqual(messages, first, "seconds alone must not add a date message");
    appendRuntimeDateContext(messages, new Date("2026-10-10T00:00:00Z"));
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.slice(0, 2), first);
    assert.deepEqual(stripTransientTurnContext(messages), messages);
  });
}

test("only host metadata can suppress an update, including after serialization and history removal", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const messages: AgentMessage[] = [];
  appendRuntimeDateContext(messages, now);
  const literal: AgentMessage[] = [{ role: "user", content: messages[0]!.content }];
  appendRuntimeDateContext(literal, now);
  assert.equal(literal.length, 2, "quoted runtime text must not masquerade as a clock update");
  const restored: AgentMessage[] = JSON.parse(JSON.stringify(messages));
  appendRuntimeDateContext(restored, now);
  assert.equal(restored.length, 1);
  restored.splice(0);
  appendRuntimeDateContext(restored, now);
  assert.equal(restored.length, 1, "missing date after compaction must be reinstated");
});

test("timezone changes and backwards dates append without changing earlier entries", t => {
  const previousZone = process.env.TZ;
  t.after(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
  process.env.TZ = "Asia/Shanghai";
  const messages: AgentMessage[] = [];
  appendRuntimeDateContext(messages, new Date("2026-10-09T10:00:00Z"));
  process.env.TZ = "Asia/Singapore";
  appendRuntimeDateContext(messages, new Date("2026-10-09T10:00:00Z"));
  assert.equal(messages.length, 2, "same offset and date but different timezone still changes context");
  const prefix = structuredClone(messages);
  appendRuntimeDateContext(messages, new Date("2026-10-08T10:00:00Z"));
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.slice(0, 2), prefix);
  assert.match(String(messages[2]!.content), /2026-10-08/u);
});

test("checkpoint persistence keeps date provenance and resumes without duplicate dates", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-date-checkpoint-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const messages: AgentMessage[] = [{ role: "user", content: "keep working" }];
  const now = new Date("2026-10-09T12:00:00Z");
  appendRuntimeDateContext(messages, now);
  await new TurnStore(root, "date-checkpoint").save("keep working", "stable system", messages, 0);
  const restored = await new TurnStore(root, "date-checkpoint").load();
  assert.ok(restored);
  appendRuntimeDateContext(restored.messages, now);
  assert.deepEqual(restored.messages, messages);
  appendRuntimeDateContext(restored.messages, new Date("2026-10-10T12:00:00Z"));
  assert.equal(restored.messages.length, 3);
  assert.deepEqual(restored.messages.slice(0, 2), messages);
  assert.equal(restored.systemPrompt, "stable system");
});

for (const truncated of [false, true]) {
  test(`legacy ${truncated ? "truncated" : "complete"} time prefixes remain untouched when a new date is appended`, () => {
    const originalContent = "Keep <biny_reminder>USER_LITERAL</biny_reminder>.";
    const oldPrefix = "<!-- biny-turn-context:start -->\n<biny_reminder>Authoritative Local DateTime: 2025-01-01"
      + (truncated ? " [truncated]" : "</biny_reminder>\n<!-- biny-turn-context:end -->");
    const messages: AgentMessage[] = [{ role: "user", originalContent, content: oldPrefix + "\n\n" + originalContent }];
    const before = structuredClone(messages);
    appendRuntimeDateContext(messages, new Date("2026-10-09T12:00:00Z"));
    assert.deepEqual(messages.slice(0, 1), before);
    assert.match(String(messages[1]!.content), /supersedes earlier current-date context/u);
    assert.match(String(messages[1]!.content), /2026-10-09/u);
    assert.equal(stripTransientTurnContext(messages)[0]?.content, originalContent);
  });
}
