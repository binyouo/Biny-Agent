/** Recalled facts must fit as complete user-message envelopes, never raw-body estimates. */
import assert from "node:assert/strict";
import test from "node:test";
import { ContextMemory, type PreparedAgentContext } from "../src/agent/context/ContextMemory.js";
import type { HybridMemoryRetriever } from "../src/agent/context/HybridMemoryRetriever.js";
import { formatMemoryMatches, type LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntry, MemoryMatch } from "../src/agent/context/memoryTypes.js";
import { estimateContextBreakdown, messageTokenCost } from "../src/agent/context/tokenUsage.js";
import type { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";
import type { AgentMessage, AgentModel, AgentUserMessage } from "../src/agent/core/types.js";
import { stripTransientTurnContext, type PromptBundle } from "../src/agent/prompts.js";
import type { AgentAttachment } from "../src/attachments/store.js";

const input = "Draft release notes";
const model: AgentModel = {
  provider: "context-envelope-test", modelId: "context-envelope-test",
  stream: async () => { throw new Error("Context assembly must not request a model"); }
};
const first = match("first", "Prefer concise release notes.");

function match(id: string, content: string): MemoryMatch {
  const entry: MemoryEntry = {
    id, content, source: "manual", tags: [], importance: 0.5, durability: "permanent",
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
    revision: 1, accessCount: 0
  };
  return { entry, excerpt: content, path: `memory://${id}`, score: 0.9 };
}

function fixture(maxTokens: number, matches: MemoryMatch[], reserveTokens?: number, history: AgentMessage[] = []) {
  const workspace: Pick<WorkspaceContext, "initialize" | "prepareTurn" | "status"> = {
    initialize: async () => undefined,
    prepareTurn: async () => ({
      instructions: [], explicitPaths: [], recentActivity: { paths: [], summaries: [] }, repoMapCandidates: [],
      snapshot: { refreshedAt: "2026-10-05T00:00:00.000Z", revision: 1,
        context: { cwd: "/synthetic", packageManager: "unknown", srcTree: [], gitStatus: "" } }
    }),
    status: () => ({
      loadedInstructions: [], instructionBytes: 0, snapshotDirty: false, repoMapDirty: false,
      repoMapEntries: 0, activePaths: [], recentActivity: { paths: [], summaries: [] }
    })
  };
  const retriever: Pick<HybridMemoryRetriever, "retrieve"> = {
    retrieve: async () => ({ matches, storeRevision: 1, report: { omitted: [] } })
  };
  const memory = new ContextMemory(
    () => model, workspace as WorkspaceContext, { recallLimit: 3 } as LocalMemory, maxTokens, 32_768,
    undefined, undefined, { enabled: false, reserveTokens }, undefined, undefined, retriever as HybridMemoryRetriever
  );
  memory.replaceHistory(history);
  return memory;
}

function requestTokens(prepared: PreparedAgentContext): number {
  return Object.values(estimateContextBreakdown({ ...prepared, tools: [], toolSources: new Map() }))
    .reduce((total, tokens) => total + tokens, 0);
}

function originalUser(attachments: AgentAttachment[]): AgentUserMessage {
  return { role: "user", content: attachments.length ? [
    { type: "text", text: input }, ...attachments.map((attachment) => ({
      type: attachment.mimeType.startsWith("audio/") ? "audio" as const : "image" as const,
      mimeType: attachment.mimeType, data: attachment.data
    }))
  ] : input };
}

function expectedUser(attachments: AgentAttachment[], turnContext: string, matches: MemoryMatch[]): AgentUserMessage {
  const original = originalUser(attachments);
  const memory = matches.length ? [
    "<!-- biny-recalled-memory:start -->", formatMemoryMatches(matches), "<!-- biny-recalled-memory:end -->"
  ].join("\n") : "";
  const prefix = [turnContext, memory].filter(Boolean).join("\n\n");
  if (!prefix) return original;
  return {
    role: "user", originalContent: original.content,
    content: typeof original.content === "string" ? `${prefix}\n\n${original.content}`
      : original.content.map((part) => part.type === "text" ? { ...part, text: `${prefix}\n\n${part.text}` } : part)
  };
}

function assertFits(memory: ContextMemory, prepared: PreparedAgentContext): void {
  const budget = memory.getBudget();
  const usable = budget.maxTokens - (budget.reserveTokens ?? 0);
  assert.ok(requestTokens(prepared) <= usable, `complete request ${requestTokens(prepared)} must fit usable ${usable}`);
  assert.ok(budget.usedTokens <= usable, "reported assembled usage must preserve the reserve");
  assert.ok(budget.components?.every((component) => component.requestedTokens >= component.usedTokens));
}

test("recalled-memory delimiters cannot spend the configured compaction reserve", async () => {
  const memory = fixture(488, [first]);
  const prepared = await memory.prepareTurn(input, "system");
  assertFits(memory, prepared);
  assert.deepEqual(prepared.messages, [originalUser([])]);
  assert.equal((await memory.status()).memoryInjectedCount, 0);
  assert.equal(memory.getBudget().components?.find((component) => component.id === "stable memory")?.disposition, "omitted");
});

const history: AgentMessage[] = [
  { role: "user", content: "Read the release checklist" },
  { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "Read", arguments: { path: "checklist" } }] },
  { role: "toolResult", toolName: "Read", toolCallId: "read-1", content: [{ type: "text", text: "The checklist is ready" }] }
];
const turnContext = "<!-- biny-turn-context:start -->\nCurrent date: 2026-10-05\n<!-- biny-turn-context:end -->";
for (const shape of [
  { name: "plain text", attachments: [], turnContext: "", history: [] },
  { name: "existing turn separators and tool pairs", attachments: [], turnContext, history },
  { name: "image", attachments: [{ name: "fixture.png", mimeType: "image/png", data: "synthetic-image" }], turnContext: "", history: [] },
  { name: "audio with turn context", attachments: [{ name: "fixture.wav", mimeType: "audio/wav", data: "synthetic-audio" }], turnContext, history: [] }
] satisfies Array<{ name: string; attachments: AgentAttachment[]; turnContext: string; history: AgentMessage[] }>) {
  test(`complete envelope uses exact-fit and one-token-under boundaries for ${shape.name}`, async () => {
    const reserve = 37;
    const prompt: PromptBundle = { systemPrompt: "system", turnContext: shape.turnContext };
    const roomy = fixture(20_000, [], reserve, shape.history);
    await roomy.prepareTurn(input, prompt, undefined, shape.attachments);
    const baseCharge = roomy.getBudget().components!.reduce((total, component) => total + component.usedTokens, 0);
    const expectedWithoutMemory = expectedUser(shape.attachments, shape.turnContext, []);
    const expectedWithMemory = expectedUser(shape.attachments, shape.turnContext, [first]);
    const memoryCharge = messageTokenCost(expectedWithMemory) - messageTokenCost(expectedWithoutMemory);
    for (const extra of [-1, 0, 1]) {
      const memory = fixture(baseCharge + memoryCharge + reserve + extra, [first], reserve, shape.history);
      const prepared = await memory.prepareTurn(input, prompt, undefined, shape.attachments);
      assertFits(memory, prepared);
      const included = extra >= 0;
      assert.deepEqual(prepared.messages, [...shape.history, included ? expectedWithMemory : expectedWithoutMemory]);
      assert.deepEqual(stripTransientTurnContext(prepared.messages), [...shape.history, originalUser(shape.attachments)],
        "original user text, media and tool-call/result pairs remain unchanged");
      const component = memory.getBudget().components!.find((item) => item.id === "stable memory")!;
      assert.equal(component.requestedTokens, memoryCharge, "requested memory counts its complete rendered user-message delta");
      assert.equal(component.usedTokens, included ? memoryCharge : 0);
      assert.equal(component.disposition, included ? "included" : "omitted");
      assert.equal((await memory.status()).memoryInjectedCount, included ? 1 : 0);
      assert.deepEqual((await memory.status()).memoryInjectedSummaries, included ? [first.excerpt] : []);
    }
  });
}

test("ranked memory facts remain intact and selection stops when the next complete fact cannot fit", async () => {
  const huge = match("second", "Large lower-ranked fact. ".repeat(500));
  const lower = match("third", "A tiny third fact.");
  const reserve = 37;
  const roomy = fixture(20_000, [], reserve);
  await roomy.prepareTurn(input, "system");
  const baseCharge = roomy.getBudget().components!.reduce((total, component) => total + component.usedTokens, 0);
  const memoryCharge = messageTokenCost(expectedUser([], "", [first, lower])) - messageTokenCost(originalUser([]));
  const memory = fixture(baseCharge + memoryCharge + reserve, [first, huge, lower], reserve);
  const prepared = await memory.prepareTurn(input, "system");
  assertFits(memory, prepared);
  assert.deepEqual(prepared.messages, [expectedUser([], "", [first])]);
  assert.deepEqual((await memory.status()).memoryInjectedSummaries, [first.excerpt]);
  assert.equal(memory.getBudget().components!.find((component) => component.id === "stable memory")?.disposition, "trimmed");
  assert.deepEqual(memory.getBudget().omitted, ["stable memory (trimmed)"]);
});

test("no recalled facts and zero remaining budget add no envelope", async () => {
  const reserve = 37;
  const roomy = fixture(20_000, [], reserve);
  const prepared = await roomy.prepareTurn(input, "system");
  assert.deepEqual(prepared.messages, [originalUser([])]);
  assert.equal(roomy.getBudget().components!.some((component) => component.id === "stable memory"), false);
  assert.equal((await roomy.status()).memoryInjectedCount, 0);
  const disabled = fixture(20_000, [first], reserve);
  const disabledPrepared = await disabled.prepareTurn(input, "system", undefined, [], false);
  assert.deepEqual(disabledPrepared.messages, [originalUser([])]);
  assert.equal(disabled.getBudget().components!.some((component) => component.id === "stable memory"), false);
  assert.equal((await disabled.status()).memoryInjectedCount, 0);
  const baseCharge = roomy.getBudget().components!.reduce((total, component) => total + component.usedTokens, 0);
  const exhausted = fixture(baseCharge + reserve, [first], reserve);
  const exhaustedPrepared = await exhausted.prepareTurn(input, "system");
  assertFits(exhausted, exhaustedPrepared);
  assert.deepEqual(exhaustedPrepared.messages, [originalUser([])]);
  assert.equal(exhausted.getBudget().components!.find((component) => component.id === "stable memory")?.usedTokens, 0);
});

test("empty-turn continuation does not inject recalled facts or a new user message", async () => {
  const memory = fixture(20_000, [first], 37, history);
  const progress = memory.prepareTurnProgress("", { systemPrompt: "system", turnContext }, undefined, [], true, false);
  let next = await progress.next();
  while (!next.done) next = await progress.next();
  assertFits(memory, next.value);
  assert.deepEqual(next.value.messages, history);
  assert.equal(memory.getBudget().components!.some((component) => component.id === "stable memory"), false);
  assert.equal((await memory.status()).memoryInjectedCount, 0);
});
