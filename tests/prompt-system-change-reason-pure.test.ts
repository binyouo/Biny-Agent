import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only source declarations with synthetic data are evaluated. No product module,
// AgentSession, ContextMemory, SDK, provider, storage or application is imported.
// TypeScript parses source only; native Node strips types without transformation.
const root = process.env.BINY_PROMPT_REASON_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
const parse = (file: string) => ts.createSourceFile(file,
  readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
const prompt = parse("src/llm/promptCache.ts");
const prompts = parse("src/agent/prompts.ts");
const schema = parse("src/tools/schema.ts");
function declaration(file: ts.SourceFile, name: string): string {
  const found = file.statements.filter(node =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(file) === name));
  assert.equal(found.length, 1, `${file.fileName}: unique ${name}`);
  return found[0]!.getText(file).replace(/^export /u, "");
}
const promptNames = [
  "stableTextHashCache", "stableTextHashCacheLimit", "toolIdentityIds", "toolSchemaCache",
  "messageShapeCache", "messageProjectionCache", "nextToolIdentityId", "LocalPromptProjectionCache",
  "defaultLocalPromptProjectionCache", "computePromptShapeDiagnostic", "canonicalToolSchemaHash",
  "getToolSchemaCache", "stableHash", "prefixReason", "requestReason", "epochReasonFromPrefixChange",
  "messageShape", "createMessageShape", "messageProjectionHash", "toolFingerprint", "toolSetFingerprint",
  "toolIdentityId", "stableStringify", "stableTextHash", "stableCompare", "canonicalize"
];
const promptHelperNames = ["dynamicPromptStart", "dynamicPromptEnd", "dateAwarenessStart",
  "sessionGoalStart", "sessionGoalEnd", "stableSystemPromptForCache", "refreshSessionGoalPrompt", "replacePromptBlock"];
const source = [
  ...promptNames.map(name => declaration(prompt, name)),
  ...promptHelperNames.map(name => declaration(prompts, name)),
  ...["normalizeToolParameters", "normalizeSchemaNode"].map(name => declaration(schema, name)),
  "({ computePromptShapeDiagnostic, stableSystemPromptForCache, refreshSessionGoalPrompt })"
].join("\n");

interface Message { role: "user"; content: string }
interface Tool { name: string; description: string; parameters: { type: "object" } }
interface Input {
  provider: string;
  providerAlias?: string;
  modelId: string;
  stableSystemPrompt: string;
  systemPrompt?: string;
  tools: Tool[];
  messages: Message[];
  providerOptions?: Record<string, unknown>;
  promptEpoch: number;
  promptEpochReason: string;
  promptEpochCreatedAt: string;
}
interface Shape {
  stablePrefixHash: string;
  requestShapeHash: string;
  stableSystemHash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  providerOptionsHash: string;
  historyProjectionHash: string;
  prefixChangeReason: string;
  requestShapeChangeReason: string;
  epochId: string;
  epochReason: string;
  epochCreatedAt: string;
}
interface Goal {
  goalId: string; revision: number; status: "active"; objective: string;
  tokenBudget: number; tokensUsed: number; usageKnown: boolean;
}
interface Api {
  computePromptShapeDiagnostic(input: Input, previous?: Shape): Shape;
  stableSystemPromptForCache(prompt: string | undefined): string;
  refreshSessionGoalPrompt(prompt: string | undefined, goal: Goal | undefined): string | undefined;
}
function load(): Api {
  return runInNewContext(stripTypeScriptTypes(source, { mode: "strip" }), { createHash },
    { timeout: 1000, filename: "prompt-system-change-source.js" }) as Api;
}
const date = (day: string) => `stable rules\n\n<!-- biny-runtime-context:start -->\nDATE AWARENESS (CRITICAL):\n- Authoritative local date: ${day}\n<!-- biny-runtime-context:end -->`;
const todo = (label: string) => `${date("2026-10-24")}\n\n<!-- biny-todos:start -->\n${label}\n<!-- biny-todos:end -->`;
function input(api: Api, systemPrompt: string | undefined = date("2026-10-24")): Input {
  return { provider: "fixture", providerAlias: "fixture-alias", modelId: "fixture-model",
    stableSystemPrompt: api.stableSystemPromptForCache(systemPrompt), systemPrompt,
    tools: [{ name: "Read", description: "Read synthetic data", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "synthetic task" }], providerOptions: { temperature: 0 },
    promptEpoch: 7, promptEpochReason: "initial", promptEpochCreatedAt: "2026-10-24T00:00:00.000Z" };
}
function pair(api: Api, before: Input, after: Input): [Shape, Shape] {
  const first = api.computePromptShapeDiagnostic(before);
  return [first, api.computePromptShapeDiagnostic(after, first)];
}
function stableEpoch(first: Shape, second: Shape): void {
  assert.equal(second.stablePrefixHash, first.stablePrefixHash);
  assert.equal(second.stableSystemHash, first.stableSystemHash);
  assert.equal(second.prefixChangeReason, "unchanged");
  assert.equal(second.epochId, first.epochId);
  assert.equal(second.epochReason, first.epochReason);
  assert.equal(second.epochCreatedAt, first.epochCreatedAt);
}
function systemChanged(first: Shape, second: Shape): void {
  stableEpoch(first, second);
  assert.notEqual(second.systemPromptHash, first.systemPromptHash);
  assert.notEqual(second.requestShapeHash, first.requestShapeHash);
  assert.equal(second.requestShapeChangeReason, "system_changed");
}

test("initial diagnostics remain initial", () => {
  const api = load();
  const result = api.computePromptShapeDiagnostic(input(api));
  assert.equal(result.prefixChangeReason, "initial");
  assert.equal(result.requestShapeChangeReason, "initial");
});
test("equal inputs preserve both hashes and report unchanged", () => {
  const api = load(); const before = input(api);
  const [first, second] = pair(api, before, { ...before });
  stableEpoch(first, second);
  assert.equal(second.requestShapeHash, first.requestShapeHash);
  assert.equal(second.requestShapeChangeReason, "unchanged");
});
test("date-only full system change is not called unchanged", () => {
  const api = load(); const before = input(api);
  const [first, second] = pair(api, before, { ...before, systemPrompt: date("2026-10-25") });
  assert.equal(second.historyProjectionHash, first.historyProjectionHash);
  systemChanged(first, second);
});
test("todo suffix-only change reports system while preserving prefix", () => {
  const api = load(); const before = input(api, todo("pending"));
  systemChanged(...pair(api, before, { ...before, systemPrompt: todo("completed") }));
});
test("actual goal prompt formatter changes only the full system diagnostic", () => {
  const api = load();
  const goal: Goal = { goalId: "synthetic-goal", revision: 1, status: "active", objective: "synthetic task",
    tokenBudget: 5000, tokensUsed: 100, usageKnown: true };
  const oldPrompt = api.refreshSessionGoalPrompt(date("2026-10-24"), goal);
  const newPrompt = api.refreshSessionGoalPrompt(oldPrompt, { ...goal, revision: 2, tokensUsed: 200 });
  const before = input(api, oldPrompt);
  systemChanged(...pair(api, before, { ...before, systemPrompt: newPrompt }));
});
test("system and history changes retain system-before-history priority", () => {
  const api = load(); const before = input(api, todo("pending"));
  const [first, second] = pair(api, before, { ...before, systemPrompt: todo("completed"),
    messages: [...before.messages, { role: "user", content: "synthetic follow-up" }] });
  assert.notEqual(second.historyProjectionHash, first.historyProjectionHash);
  systemChanged(first, second);
});
test("system and provider options changes retain system-before-options priority", () => {
  const api = load(); const before = input(api);
  const [first, second] = pair(api, before, { ...before, systemPrompt: date("2026-10-25"), providerOptions: { temperature: 1 } });
  assert.notEqual(second.providerOptionsHash, first.providerOptionsHash);
  systemChanged(first, second);
});
test("stable system changes retain existing system reason and epoch identity behavior", () => {
  const api = load(); const before = input(api);
  const systemPrompt = date("2026-10-24").replace("stable rules", "new stable rules");
  const [first, second] = pair(api, before, { ...before, systemPrompt, stableSystemPrompt: api.stableSystemPromptForCache(systemPrompt) });
  assert.notEqual(second.stablePrefixHash, first.stablePrefixHash);
  assert.notEqual(second.epochId, first.epochId);
  assert.equal(second.prefixChangeReason, "system_changed");
  assert.equal(second.requestShapeChangeReason, "system_changed");
  assert.equal(second.epochReason, first.epochReason);
  assert.equal(second.epochCreatedAt, first.epochCreatedAt);
});
for (const field of ["provider", "providerAlias", "modelId"] as const) {
  test(`${field} change retains priority over dynamic system`, () => {
    const api = load(); const before = input(api);
    const [, second] = pair(api, before, { ...before, [field]: "changed", systemPrompt: date("2026-10-25") });
    const reason = field === "modelId" ? "model_changed" : "provider_changed";
    assert.equal(second.prefixChangeReason, reason);
    assert.equal(second.requestShapeChangeReason, reason);
  });
}
test("tool schema change retains prefix priority over dynamic system", () => {
  const api = load(); const before = input(api);
  const [, second] = pair(api, before, { ...before, systemPrompt: date("2026-10-25"),
    tools: [{ name: "Write", description: "Synthetic write schema, never executed", parameters: { type: "object" } }] });
  assert.equal(second.prefixChangeReason, "tool_schema_changed");
  assert.equal(second.requestShapeChangeReason, "tool_schema_changed");
});
test("provider options-only changes retain existing reason", () => {
  const api = load(); const before = input(api);
  const [first, second] = pair(api, before, { ...before, providerOptions: { temperature: 1 } });
  stableEpoch(first, second);
  assert.equal(second.requestShapeChangeReason, "provider_options_changed");
});
test("history-only changes retain existing reason", () => {
  const api = load(); const before = input(api);
  const [first, second] = pair(api, before, { ...before, messages: [{ role: "user", content: "new synthetic task" }] });
  stableEpoch(first, second);
  assert.equal(second.requestShapeChangeReason, "history_projection_changed");
});
test("provider options retain priority over simultaneous history changes", () => {
  const api = load(); const before = input(api);
  const [, second] = pair(api, before, { ...before, providerOptions: { temperature: 1 },
    messages: [{ role: "user", content: "new synthetic task" }] });
  assert.equal(second.requestShapeChangeReason, "provider_options_changed");
});
for (const fromAbsent of [true, false]) {
  test(`${fromAbsent ? "absent to empty" : "empty to absent"} full system remains normalized unchanged`, () => {
    const api = load(); const before = { ...input(api), systemPrompt: fromAbsent ? undefined : "" };
    const [first, second] = pair(api, before, { ...before, systemPrompt: fromAbsent ? "" : undefined });
    stableEpoch(first, second);
    assert.equal(second.systemPromptHash, first.systemPromptHash);
    assert.equal(second.requestShapeHash, first.requestShapeHash);
    assert.equal(second.requestShapeChangeReason, "unchanged");
  });
}
test("absent to nonempty full system is detected without inventing a prefix change", () => {
  const api = load(); const before = { ...input(api), systemPrompt: undefined };
  systemChanged(...pair(api, before, { ...before, systemPrompt: "synthetic full instructions" }));
});
