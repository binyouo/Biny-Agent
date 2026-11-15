/** Exact prefix semantics plus a deterministic work bound, without timing thresholds. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forkSession } from "../src/session/fork.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { SessionEvent } from "../src/session/recorder.js";

const source = ts.createSourceFile("fork.ts", readFileSync(new URL("../src/session/fork.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = new Set(["safeCutPoint", "hasUnmatchedToolCalls"]);
const declarations = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
assert.equal(declarations.filter(node => node.name?.text === "safeCutPoint").length, 1);
const program = ts.transpileModule(`${declarations.map(node => node.getText(source)).join("\n")}\nsafeCutPoint;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const cut = runInNewContext(program, {}) as (events: readonly SessionEvent[], requested: number) => number;

function previousCut(events: readonly SessionEvent[], requested: number): number {
  for (let length = requested; length > 0; length--) {
    const open = new Set<string>();
    for (const [index, event] of events.slice(0, length).entries()) {
      if (event.type === "tool_call") open.add(event.toolCallId ?? `sequence-${String(event.sequence ?? index)}`);
      else if (event.type === "tool_result") open.delete(event.toolCallId ?? `sequence-${String(event.sequence ?? index)}`);
    }
    if (!open.size) return length;
  }
  return 0;
}
const events: SessionEvent[] = [
  { type: "user_message", content: "fixture" },
  { type: "tool_call", tool: "fixture", toolCallId: "a", args: {} },
  { type: "tool_result", tool: "fixture", toolCallId: "a", result: "done" },
  { type: "tool_call", tool: "fixture", sequence: 7, args: {} },
  { type: "tool_result", tool: "fixture", sequence: 7, result: "done" },
  { type: "tool_call", tool: "fixture", args: {} },
  { type: "tool_result", tool: "fixture", result: "done" },
  { type: "tool_call", tool: "fixture", toolCallId: "sequence-7", args: {} }
];
test("all short prefixes preserve legacy ID, duplicate, unmatched and sequence semantics", () => {
  for (let encoded = 0; encoded < events.length ** 5; encoded++) {
    let value = encoded;
    const input: SessionEvent[] = [];
    for (let index = 0; index < 5; index++) { input.push(events[value % events.length]!); value = Math.floor(value / events.length); }
    for (let length = 1; length <= input.length; length++) assert.equal(cut(input, length), previousCut(input, length));
  }
});
test("long unfinished suffix reads each source event only once", () => {
  const input = [events[0]!, events[1]!, ...Array<SessionEvent>(998).fill(events[0]!)];
  let reads = 0;
  const counted = new Proxy(input, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/u.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  assert.equal(cut(counted, input.length), 1);
  assert.ok(reads <= input.length, `expected linear reads, observed ${reads}`);
});

test("public fork preserves source and rolls a large unfinished suffix back to the user", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-fork-linear-"));
  try {
    await ensureAgentDirs(root);
    const input = [events[0]!, events[1]!, ...Array<SessionEvent>(19_998).fill({ type: "assistant_message", content: "fixture status", auditOnly: true })];
    const bytes = Buffer.from(`${input.map(event => JSON.stringify(event)).join("\n")}\n`);
    const sourcePath = await createSessionFile(root, "long-source", bytes);
    const forked = await forkSession(root, "long-source");
    assert.equal(forked.events, 1);
    assert.equal(forked.sourceSessionId, "long-source");
    assert.deepEqual(await readFile(sourcePath), bytes);
    assert.deepEqual(JSON.parse((await readFile(forked.filePath, "utf8")).trim()), events[0]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
