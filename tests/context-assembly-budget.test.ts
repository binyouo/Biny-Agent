import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute only the actual final assembly statements and three pure cost helpers.
// Already-assembled inputs avoid importing ContextMemory or its service graph.
const root = process.env.BINY_ASSEMBLY_SOURCE_ROOT ?? process.cwd();
const contextPath = process.env.BINY_ASSEMBLY_BASELINE ?? path.join(root, "src/agent/context/ContextMemory.ts");
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
const context = parse(contextPath);
const tokens = parse(path.join(root, "src/agent/context/tokenUsage.ts"));
const assembly = one(context.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "assembleContext"), "assembleContext");
assert.ok(assembly.body);
const start = one(assembly.body.statements.map((node, index) => ({ node, index })).filter(({ node }) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "assembledSystemPrompt")), "tail start").index;
const tail = assembly.body.statements.slice(start);
assert.ok(ts.isReturnStatement(tail.at(-1)!));
assert.equal(tail.filter(ts.isReturnStatement).length, 1);
for (const node of tail.slice(0, -1)) {
  assert.ok(ts.isVariableStatement(node));
  assert.equal(node.declarationList.declarations.length, 1);
  const name = node.declarationList.declarations[0]!.name;
  assert.ok(ts.isIdentifier(name) && ["assembledSystemPrompt", "usedTokens"].includes(name.text));
  assert.ok(node.declarationList.flags & ts.NodeFlags.Const);
}
const helpers = ["estimateTokens", "messageTokenCost", "estimateMessageTokens"].map(name => one(
  tokens.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name), name));
const allowedCalls = new Set(["systemParts.join", "estimateTokens", "estimateMessageTokens", "messageTokenCost", "Math.ceil", "Buffer.byteLength", "JSON.stringify", "messages.reduce"]);
for (const [nodes, source] of [[tail, context], [helpers, tokens]] as const) {
  for (const node of nodes) {
    const visit = (child: ts.Node): void => {
      assert.ok(!ts.isImportDeclaration(child) && !ts.isAwaitExpression(child) && !ts.isNewExpression(child));
      if (ts.isCallExpression(child)) assert.ok(allowedCalls.has(child.expression.getText(source)), `unreviewed call: ${child.expression.getText(source)}`);
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
}
const source = `${helpers.map(node => node.getText(tokens).replace(/^export /u, "")).join("\n")}
let costCalls = 0;
let systemCalls = 0;
let stringifyCalls = 0;
let inMessage = false;
const originalCost = messageTokenCost;
const originalEstimate = estimateTokens;
const originalStringify = JSON.stringify;
messageTokenCost = message => { costCalls += 1; inMessage = true; try { return originalCost(message); } finally { inMessage = false; } };
estimateTokens = value => { if (!inMessage) systemCalls += 1; return originalEstimate(value); };
JSON.stringify = value => { stringifyCalls += 1; return originalStringify(value); };
({
  assemble({ messages, systemParts, includedMemoryMatches, maxTokens, requestedTokens, usedCheckpointTokens, reserveTokens, omitted, components, autoCompacted }) {
    ${tail.map(node => node.getText(context)).join("\n")}
  },
  estimate: estimateMessageTokens,
  tokens: estimateTokens,
  reset() { costCalls = 0; systemCalls = 0; stringifyCalls = 0; },
  counts() { return { costCalls, systemCalls, stringifyCalls }; }
});`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
interface Part { type: string; text?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string }
interface Message { role: "user" | "assistant" | "toolResult"; content: string | Part[]; originalContent?: string; toolName?: string; toolCallId?: string }
interface Inputs {
  messages: Message[]; systemParts: string[]; includedMemoryMatches: unknown[];
  maxTokens: number; requestedTokens: number; usedCheckpointTokens: number;
  reserveTokens: number; omitted: string[]; components: unknown[]; autoCompacted: boolean;
}
interface Output { systemPrompt?: string; messages: Message[]; includedMemoryMatches: unknown[]; budget: Record<string, unknown> }
interface Pure {
  assemble(input: Inputs): Output; estimate(messages: Message[]): number; tokens(value: string): number;
  reset(): void; counts(): { costCalls: number; systemCalls: number; stringifyCalls: number };
}
const api = runInNewContext(compiled.outputText, { Buffer: { byteLength: Buffer.byteLength } },
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Pure;
function inputs(messages: Message[] = []): Inputs {
  return { messages, systemParts: ["system rules", "project instructions"], includedMemoryMatches: [{ excerpt: "remember" }],
    maxTokens: 2048, requestedTokens: 2500, usedCheckpointTokens: 17, reserveTokens: 256,
    omitted: ["older conversation messages"], components: [{ id: "history", usedTokens: 42 }], autoCompacted: false };
}
function fixedMessages(): Message[] {
  const messages: Message[] = [{ role: "user", content: "Inspect five files" }];
  for (let index = 0; index < 5; index++) {
    const id = `call-${index}`;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "Read", arguments: { path: `f${index}.ts` } }] });
    messages.push({ role: "toolResult", toolName: "Read", toolCallId: id, content: [{ type: "text", text: "file content ".repeat(20) }] });
  }
  return [...messages, { role: "assistant", content: [{ type: "text", text: "Done" }] }, { role: "user", content: "Explain the results" }];
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function verify(input: Inputs): Output {
  const before = JSON.stringify(input);
  const systemPrompt = input.systemParts.join("\n\n") || undefined;
  const usedTokens = api.estimate(input.messages) + api.tokens(systemPrompt ?? "") + input.usedCheckpointTokens;
  const output = api.assemble(input);
  assert.deepEqual({ ...output, budget: { ...output.budget } }, {
    systemPrompt, messages: input.messages, includedMemoryMatches: input.includedMemoryMatches,
    budget: { maxTokens: input.maxTokens, usedTokens, requestedTokens: input.requestedTokens, estimatedTokens: usedTokens,
      providerInputTokens: undefined, reserveTokens: input.reserveTokens, omitted: input.omitted,
      components: input.components, autoCompacted: input.autoCompacted, source: "estimated", measuredAt: undefined }
  });
  assert.equal(output.messages, input.messages);
  input.messages.forEach((message, index) => assert.equal(output.messages[index], message));
  assert.equal(output.includedMemoryMatches, input.includedMemoryMatches);
  assert.equal(output.budget.omitted, input.omitted);
  assert.equal(output.budget.components, input.components);
  assert.equal(JSON.stringify(input), before);
  return output;
}

test("final assembly preserves every field, message pairing, identities and frozen inputs", () => {
  const input = inputs(fixedMessages());
  freeze(input);
  verify(input);
});

test("empty system, empty messages and checkpoint-only budgets retain exact values", () => {
  for (const systemParts of [[], [""], ["one", "two"]]) {
    for (const usedCheckpointTokens of [0, 37]) {
      const input = { ...inputs(), systemParts, usedCheckpointTokens };
      freeze(input);
      verify(input);
    }
  }
});

test("Unicode, reasoning, originalContent and image/audio cost the actual message parts", () => {
  const input = inputs([
    { role: "user", content: [{ type: "text", text: "中文 👩🏽‍💻 é" }, { type: "image", data: "not-loaded", mimeType: "image/png" }, { type: "audio", data: "not-loaded", mimeType: "audio/wav" }], originalContent: "unprefixed" },
    { role: "assistant", content: [{ type: "reasoning", text: "分析 🧠" }, { type: "toolCall", id: "调用1", name: "Read", arguments: { path: "资料.ts", nested: [1, true, null] } }] },
    { role: "toolResult", toolName: "Read", toolCallId: "调用1", content: [{ type: "text", text: "结果" }] }
  ]);
  input.systemParts = ["规则 📖", "项目约束"];
  freeze(input);
  verify(input);
});

test("metadata and over-budget inputs are not clamped or reclassified by the tail", () => {
  const input = inputs([{ role: "user", content: "large ".repeat(1000) }]);
  Object.assign(input, { maxTokens: 1, requestedTokens: 9000, reserveTokens: 0, autoCompacted: true,
    omitted: [], components: [], includedMemoryMatches: [] });
  freeze(input);
  const output = verify(input);
  assert.ok(Number(output.budget.usedTokens) > input.maxTokens);
});

test("successive calls recompute after same-array message, system and checkpoint changes", () => {
  const input = inputs([{ role: "user", content: "a" }]);
  const first = verify(input);
  input.messages[0]!.content = "中文".repeat(100);
  input.messages.push({ role: "assistant", content: [{ type: "text", text: "new reply" }] });
  input.systemParts.push("new rules");
  input.usedCheckpointTokens = 73;
  const second = verify(input);
  assert.notEqual(second.budget.usedTokens, first.budget.usedTokens);
  input.messages.length = 0;
  input.systemParts.length = 0;
  input.usedCheckpointTokens = 0;
  assert.equal(verify(input).budget.usedTokens, 0);
});

test("one final-budget estimate prices thirteen messages, five calls and the system once", () => {
  const input = inputs(fixedMessages());
  api.reset();
  api.assemble(input);
  assert.deepEqual({ ...api.counts() }, { costCalls: 13, systemCalls: 1, stringifyCalls: 5 });
  api.reset();
  api.assemble({ ...inputs(), systemParts: [] });
  assert.deepEqual({ ...api.counts() }, { costCalls: 0, systemCalls: 1, stringifyCalls: 0 });
});
