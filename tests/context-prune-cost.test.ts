import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { projectMessageSentAt } from "../src/agent/modelMessages.js";

// Evaluate only the actual synchronous pruning method and its pure helpers.
// The shared send-time formatter is pure; no ContextMemory, SDK, storage or service is started.
const root = process.env.BINY_PRUNE_SOURCE_ROOT ?? process.cwd();
const contextPath = process.env.BINY_PRUNE_BASELINE ?? path.join(root, "src/agent/context/ContextMemory.ts");
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function one<T>(values: readonly T[], label: string): T {
  assert.equal(values.length, 1, label);
  return values[0]!;
}
const context = parse(contextPath);
const tokens = parse(path.join(root, "src/agent/context/tokenUsage.ts"));
const text = parse(path.join(root, "src/agent/modelMessages.ts"));
const owner = one(context.statements.filter((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === "ContextMemory"), "ContextMemory");
const method = one(owner.members.filter((node): node is ts.MethodDeclaration =>
  ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "pruneToolResultsForStep"), "pruneToolResultsForStep");
assert.ok(method.body);
const selected: Array<[ts.Node, ts.SourceFile]> = [[method, context]];
function functions(source: ts.SourceFile, names: readonly string[]): string[] {
  return names.map(name => {
    const node = one(source.statements.filter((item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name), name);
    selected.push([node, source]);
    return node.getText(source).replace(/^export /u, "");
  });
}
function constants(names: readonly string[]): string[] {
  return names.map(name => {
    const node = one(context.statements.filter((item): item is ts.VariableStatement =>
      ts.isVariableStatement(item) && item.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name)), name);
    assert.equal(node.declarationList.declarations.length, 1);
    selected.push([node, context]);
    return node.getText(context);
  });
}
const pure = [
  ...functions(tokens, ["estimateTokens", "messageTokenCost", "estimateMessageTokens"]),
  ...functions(text, ["messageText", "messageToolName", "stringify"]),
  ...functions(context, ["isPrunedToolResult", "prunedToolResultMessage", "truncateTextToTokens"]),
  ...constants(["midTurnPruneThreshold", "prunedToolResultMarker", "archivedToolResultPathPattern"])
];
const allowedCalls = new Set([
  "Math.floor", "this.inputBudget", "estimateMessageTokens", "messages.reduce", "isPrunedToolResult", "indexes.push",
  "prunableIndexes.slice", "Math.max", "prunedToolResultMessage", "messageTokenCost", "Math.ceil", "Buffer.byteLength",
  "projectMessageSentAt", "estimateTokens", "JSON.stringify", "message.content.map", "stringify", "String", "message.content[0].text.startsWith",
  "messageText", "original.match", "messageToolName", "truncateTextToTokens", "value.slice", "suffix.slice"
]);
for (const [node, source] of selected) {
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child) && !ts.isAwaitExpression(child) && !ts.isNewExpression(child));
    if (ts.isCallExpression(child)) {
      const callee = child.expression.getText(source);
      const arrayJoin = ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === "join"
        && (ts.isArrayLiteralExpression(child.expression.expression)
          || ts.isCallExpression(child.expression.expression) && child.expression.expression.expression.getText(source) === "message.content.map");
      assert.ok(arrayJoin || allowedCalls.has(callee), `unreviewed call: ${callee}`);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
}

// The counter wraps, and delegates to, the extracted real cost function.
// estimateMessageTokens and the pruning method both resolve this same wrapper.
const source = `${pure.join("\n")}\nconst prune = ({ ${method.getText(context)} }).pruneToolResultsForStep;
let costCalls = 0;
let budgetReads = 0;
const originalCost = messageTokenCost;
messageTokenCost = (message) => { costCalls += 1; return originalCost(message); };
({
  prune(messages, budget, keep) {
    return prune.call({ inputBudget() { budgetReads += 1; return budget; } }, messages, keep);
  },
  estimate: estimateMessageTokens,
  cost: messageTokenCost,
  replacement: prunedToolResultMessage,
  reset() { costCalls = 0; budgetReads = 0; },
  counts() { return { costCalls, budgetReads }; }
});`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
interface Part { type: string; text?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string }
interface Message { role: "user" | "assistant" | "toolResult"; content: string | Part[]; toolName?: string; toolCallId?: string }
interface Pure {
  prune(messages: Message[], budget: number, keep?: number): Message[];
  estimate(messages: Message[]): number;
  cost(message: Message): number;
  replacement(message: Message): Message;
  reset(): void;
  counts(): { costCalls: number; budgetReads: number };
}
const api = runInNewContext(compiled.outputText, { projectMessageSentAt, Buffer: { byteLength: Buffer.byteLength } },
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as Pure;
const marker = "[earlier tool result compacted for this model step]";
const archivedPath = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
const result = (id: string, content: string): Message => ({ role: "toolResult", toolName: "Read", toolCallId: id, content: [{ type: "text", text: content }] });
function body(message: Message): string {
  assert.ok(Array.isArray(message.content));
  return message.content[0]?.text ?? "";
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function budgetForLimit(limit: number): number {
  const budget = Math.ceil(limit / 0.7);
  assert.equal(Math.floor(budget * 0.7), limit);
  return budget;
}
function fixedMessages(): Message[] {
  const messages: Message[] = [{ role: "user", content: "inspect the repo" }];
  for (let index = 0; index < 5; index++) {
    const id = `call-${index}`;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "Read", arguments: { path: `f${index}.ts` } }] });
    messages.push(result(id, index === 0 ? JSON.stringify({ archived: true, archivePath: archivedPath, preview: "body ".repeat(200) }) : "body ".repeat(200)));
  }
  return messages;
}

test("fixed eleven-message pruning preserves output, pairing and source identity", () => {
  const messages = fixedMessages();
  const before = JSON.stringify(messages);
  freeze(messages);
  const pruned = api.prune(messages, 200);
  assert.notEqual(pruned, messages);
  assert.equal(pruned.length, 11);
  for (let index = 0; index < messages.length; index++) {
    if ([2, 4, 6].includes(index)) {
      assert.notEqual(pruned[index], messages[index]);
      assert.ok(body(pruned[index]!).startsWith(marker));
      assert.equal(pruned[index]!.toolCallId, messages[index]!.toolCallId);
    } else assert.equal(pruned[index], messages[index]);
  }
  assert.equal(body(pruned[2]!), [marker, "Tool: Read", `Archived result: ${archivedPath}`, "Use Read with this archivePath as path if the full value is needed."].join("\n"));
  assert.ok(body(pruned[4]!).includes("Preview: body "));
  assert.equal(JSON.stringify(messages), before);
});

test("exact threshold, roomy inputs and no eligible results retain the original array", () => {
  const boundary = [result("a", "abc".repeat(100))];
  const noEligible: Message[] = [{ role: "user", content: "large ".repeat(1000) }, result("old", marker + " prior")];
  for (const [messages, budget] of [[boundary, budgetForLimit(api.estimate(boundary))], [boundary, 1_000_000], [noEligible, 1]] as const) {
    freeze(messages);
    api.reset();
    assert.equal(api.prune(messages, budget), messages);
    assert.equal(api.counts().costCalls, messages.length);
    assert.equal(api.counts().budgetReads, 1);
  }
});

test("one or two eligible results still return a shallow copy above budget", () => {
  for (const count of [1, 2]) {
    const messages = Array.from({ length: count }, (_, index) => result(String(index), "x".repeat(1000)));
    freeze(messages);
    const pruned = api.prune(messages, 1);
    assert.notEqual(pruned, messages);
    assert.equal(pruned.length, messages.length);
    for (let index = 0; index < messages.length; index++) assert.equal(pruned[index], messages[index]);
  }
});

test("mixed plain data stops exactly at the budget without repruning old markers", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "界😀" }, { type: "image", data: "a", mimeType: "image/png" }, { type: "audio", data: "b", mimeType: "audio/wav" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "想" }, { type: "toolCall", id: "a", name: "Read", arguments: { path: "界.ts", nested: [1, false, null] } }] },
    result("old", marker + " historical"),
    result("a", archivedPath + "界😀".repeat(1000)),
    result("b", "still eligible ".repeat(300)), result("c", "recent"), result("d", "recent")
  ];
  const expected = api.replacement(messages[3]!);
  const total = api.estimate(messages);
  const target = total - api.cost(messages[3]!) + api.cost(expected);
  assert.ok(target < total);
  const before = JSON.stringify(messages);
  freeze(messages);
  const pruned = api.prune(messages, budgetForLimit(target));
  assert.equal(JSON.stringify(pruned[3]), JSON.stringify(expected));
  for (let index = 0; index < messages.length; index++) if (index !== 3) assert.equal(pruned[index], messages[index]);
  assert.equal(api.estimate(pruned), target);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(api.cost({ role: "user", content: [{ type: "image", data: "x".repeat(1000), mimeType: "image/png" }, { type: "audio", data: "y", mimeType: "audio/wav" }] }), 4 + 1024 + 2048);
});

test("a later call reprices changed messages and observes the current budget", () => {
  const messages = fixedMessages();
  const roomy = api.prune(messages, 1_000_000);
  assert.equal(roomy, messages);
  messages[0] = { role: "user", content: "new request ".repeat(500) };
  const appended = result("new", "latest ".repeat(200));
  messages.push(appended);
  const before = JSON.stringify(messages);
  const pruned = api.prune(messages, 200);
  assert.equal(pruned[0], messages[0]);
  assert.equal(pruned.at(-1), appended);
  assert.notEqual(pruned[8], messages[8], "the prior recent result is now eligible");
  assert.equal(JSON.stringify(messages), before);
  assert.equal(api.prune(messages, 1_000_000), messages);
});

test("over-budget pruning prices each input once, plus original and replacement for each changed result", () => {
  const messages = fixedMessages();
  api.reset();
  const pruned = api.prune(messages, 200);
  const changed = pruned.reduce((count, message, index) => count + Number(message !== messages[index]), 0);
  assert.equal(changed, 3);
  assert.equal(api.counts().budgetReads, 1);
  // Original: 2 * 11 + 2 * 3 = 28. Candidate: 11 + 2 * 3 = 17.
  // The original has correct output; the regression is redundant work only.
  assert.equal(api.counts().costCalls, messages.length + 2 * changed);
});
