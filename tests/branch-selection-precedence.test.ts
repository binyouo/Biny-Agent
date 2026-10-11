import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Trusted-tool harness only: source is read as text, never imported or required.
// No SDK, Recorder, checkpoint, Host, database, network, or product module loader.
type FixtureEvent =
  | { type: "user_message"; messageId?: string; parentMessageId?: string; slotId?: string; content: string }
  | { type: "agent_message"; messageId: string; parentMessageId?: string; slotId?: string;
      message: { role: "assistant"; content: Array<{ type: "text"; text: string }> } }
  | { type: "message_version_selected"; messageId: string; slotId: string };

const file = new URL("../src/session/messageTree.ts", import.meta.url);
const parsed = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(["sessionMessageTree", "activeSessionMessageIds", "compatibleSessionSelections"]);
const functions = parsed.statements.filter(statement =>
  ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text));
assert.ok(functions.some(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "activeSessionMessageIds"));
assert.ok(functions.some(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "sessionMessageTree"));
const result = ts.transpileModule(functions.map(statement => statement.getText(parsed)).join("\n"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true
});
assert.equal((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const exports: Record<string, unknown> = {};
runInNewContext(result.outputText, { exports }, { timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false } });
const active = exports.activeSessionMessageIds as (events: readonly FixtureEvent[]) => ReadonlySet<string>;
const ids = (events: readonly FixtureEvent[]): string[] => [...active(events)].sort();
const user = (id: string, parent?: string): FixtureEvent =>
  ({ type: "user_message", messageId: id, parentMessageId: parent, slotId: id, content: id });
const answer = (id: string, parent: string, slot: string): FixtureEvent =>
  ({ type: "agent_message", messageId: id, parentMessageId: parent, slotId: slot,
    message: { role: "assistant", content: [{ type: "text", text: id }] } });
const select = (id: string, slot: string): FixtureEvent =>
  ({ type: "message_version_selected", messageId: id, slotId: slot });
const expect = (events: readonly FixtureEvent[], expected: string[], label: string): void =>
  assert.deepEqual(ids(events), [...expected].sort(), label);

// Ordinary producer sequence: prompt, retry, prompt, retry, switch ancestor.
const history: FixtureEvent[] = [
  user("u1"), answer("a1", "u1", "u1"), answer("a2", "u1", "u1"), select("a2", "u1"),
  user("u2", "a2"), answer("b1", "u2", "u2"), answer("b2", "u2", "u2"), select("b2", "u2")
];
expect(history, ["u1", "a2", "u2", "b2"], "compatible selections stay active");
history.push(select("a1", "u1"));
expect(history, ["u1", "a1"], "latest ancestor switch overrides unreachable descendant");
history.push(select("a2", "u1"));
expect(history, ["u1", "a2", "u2", "b2"], "returning restores remembered descendant choice");
history.push(select("b1", "u2"), select("a1", "u1"), select("a2", "u1"));
expect(history, ["u1", "a2", "u2", "b1"], "return restores older selected answer, not latest appended");
history.push(user("u3", "b1"), answer("c1", "u3", "u3"));
expect(history, ["u1", "a2", "u2", "b1", "u3", "c1"], "continuation extends selected leaf");
history.push(select("a1", "u1"), select("b2", "u2"));
expect(history, ["u1", "a2", "u2", "b2"], "API allows explicit descendant switch to supersede older ancestor");

const branch: FixtureEvent[] = [
  user("u1"), answer("a1", "u1", "u1"), user("u2", "a1"),
  answer("b1", "u2", "u2"), answer("b2", "u2", "u2"), select("b2", "u2"),
  answer("a2", "u1", "u1"), select("a2", "u1"),
  user("u3", "a2"), answer("c1", "u3", "u3"), answer("c2", "u3", "u3"), select("c2", "u3"),
  select("c1", "u3")
];
expect(branch, ["u1", "a2", "u3", "c1"], "old inactive branch cannot poison new-branch switch");
expect([user("x"), user("y"), select("y", "y"), select("x", "x")], ["x"], "latest choice wins across roots");
expect([user("x", "root"), user("y", "root"), user("root"), select("y", "y"), select("x", "x")], ["root", "x"], "forward-reference conflict honors recency");
expect([{ type: "user_message", content: "legacy" }], [], "legacy ID-less history remains empty");
expect([user("child", "parent"), user("parent"), select("child", "child")], ["child", "parent"], "forward reference");
expect([user("orphan", "absent"), select("orphan", "orphan")], ["orphan"], "missing parent remains finite root");
expect([user("x", "y"), user("y", "x"), select("x", "x")], ["x", "y"], "cycle finite path is unchanged");
expect([user("x"), user("y"), select("x", "wrong"), select("y", "y")], ["y"], "mismatched slot keeps legacy conflict fallback");
expect([user("x"), user("y"), select("x", "x"), select("absent", "absent")], ["y"], "unknown selection keeps legacy conflict fallback");
expect([user("x"), user("y"), user("y"), select("x", "x"), select("y", "y")], ["y"], "duplicate IDs keep legacy conflict fallback");
expect([user("x", "y"), user("y", "x"), user("z"), select("z", "z"), select("x", "x")], ["z"], "cyclic conflict keeps legacy latest-node fallback");

// Independent exhaustive-path oracle: unlike production, deliberately O(nodes * choices).
// Valid acyclic selections use recency; malformed slots/unknown IDs/cycles retain old semantics.
let seed = 41;
const random = (limit: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
};
for (const valid of [false, true]) for (let run = 0; run < 300; run += 1) {
  const nodes = Array.from({ length: 30 }, (_, index) => ({
    id: String(index), parent: valid ? (index ? String(random(index)) : undefined) : String(random(33))
  }));
  const choices = Array.from({ length: random(6) }, () => String(random(valid ? 30 : 33)));
  const events = nodes.map(node => user(node.id, node.parent));
  const slots = new Map<string, string>();
  for (const [index, id] of choices.entries()) {
    const slot = valid ? id : String(index);
    events.push(select(id, slot));
    slots.delete(slot); slots.set(slot, id);
  }
  let cyclic = false;
  const paths = nodes.map(leaf => {
    const path = new Set<string>();
    let current: typeof leaf | undefined = leaf;
    while (current && !path.has(current.id)) {
      path.add(current.id);
      current = nodes.find(node => node.id === current?.parent);
    }
    if (current) cyclic = true;
    return path;
  });
  const proper = !cyclic && [...slots].every(([slot, id]) => slot === id && nodes.some(node => node.id === id));
  let candidates = paths;
  if (proper) {
    for (const id of [...slots.values()].reverse()) {
      const compatible = candidates.filter(path => path.has(id));
      if (compatible.length) candidates = compatible;
    }
  } else candidates = paths.filter(path => [...slots.values()].every(id => path.has(id)));
  const expected = candidates.at(-1) ?? paths.at(-1)!;
  expect(events, [...expected], "exhaustive oracle valid=" + valid + " run=" + run);
}
const long = Array.from({ length: 20_000 }, (_, index) => user(String(index), index ? String(index - 1) : undefined));
long.push(select("0", "0"), select("10000", "10000"));
assert.equal(active(long).size, 20_000, "long chain uses iterative linear indexing");
console.log("branch selection pure-helper regressions passed");
