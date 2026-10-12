import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-text-only test: no product imports or database, filesystem-backed index,
// model, Host, SDK, Recorder, or canonical-tree execution.
interface Input { messageId?: string; slotId?: string }
type Reject = (input: Input, activeIds: ReadonlySet<string> | undefined,
  selectedSlots: ReadonlyMap<string, string>, latestSlots: ReadonlyMap<string, string>) => boolean;
const source = ts.createSourceFile("temporalMemory.ts",
  readFileSync("src/session/temporalMemory.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const indexClass = source.statements.find((item): item is ts.ClassDeclaration =>
  ts.isClassDeclaration(item) && item.name?.text === "TemporalMemoryIndex");
assert.ok(indexClass);
const exports: Record<string, unknown> = {};
for (const [methodName, input] of [["indexSessionFile", "event"], ["sourceStillCurrent", "matching"]] as const) {
  const method = indexClass.members.find((item): item is ts.MethodDeclaration =>
    ts.isMethodDeclaration(item) && ts.isIdentifier(item.name) && item.name.text === methodName);
  assert.ok(method?.body);
  const guards: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const text = node.expression.getText(source);
      if (text.includes("activeIds.has") || text.includes("selectedSlots.get")) guards.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  assert.equal(guards.length, 2, methodName + ": extract exactly the two existing membership guards");
  const active = guards[0]!.expression.getText(source);
  const slot = guards[1]!.expression.getText(source);
  const expectedActive = `activeIds && ${input}.messageId && !activeIds.has(${input}.messageId)`;
  const oldSlot = methodName === "indexSessionFile"
    ? "event.slotId && event.messageId && (selectedSlots.get(event.slotId) ?? latestSlots.get(event.slotId)) !== event.messageId"
    : "matching.slotId && matching.messageId\n        && (selectedSlots.get(matching.slotId) ?? latestSlots.get(matching.slotId)) !== matching.messageId";
  // Complete byte allowlist. Baseline is accepted only so it can fail the same
  // behavioral assertions; execution always uses extracted production text.
  assert.equal(active, expectedActive);
  assert.ok(slot === oldSlot || slot === "activeIds === undefined && " + oldSlot,
    methodName + ": slot guard must match the reviewed baseline or candidate bytes");
  const body = `exports.${methodName} = function (${input}, activeIds, selectedSlots, latestSlots) {
    return Boolean((${active}) || (${slot}));
  };`;
  runInNewContext(body, { exports }, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  });
}
interface Case {
  label: string; input: Input; active?: string[];
  selected?: Array<[string, string]>; latest?: Array<[string, string]>; rejected: boolean;
}
const cases: Case[] = [
  { label: "native assistant retry retains user", input: { messageId: "u1", slotId: "u1" },
    active: ["u1", "a2"], selected: [["u1", "a2"]], latest: [["u1", "u1"]], rejected: false },
  { label: "native switch to older assistant retains user", input: { messageId: "u1", slotId: "u1" },
    active: ["u1", "a1"], selected: [["u1", "a1"]], latest: [["u1", "u1"]], rejected: false },
  { label: "edited user after returning to original answer", input: { messageId: "u1", slotId: "u1" },
    active: ["u1", "a1"], selected: [["u1", "a1"]], latest: [["u1", "u2"]], rejected: false },
  { label: "user-only selection filtering would still lose older active user", input: { messageId: "u1", slotId: "u1" },
    active: ["u1", "a1"], latest: [["u1", "u2"]], rejected: false },
  { label: "inactive edited user stays excluded", input: { messageId: "u2", slotId: "u1" },
    active: ["u1", "a1"], selected: [["u1", "a1"]], latest: [["u1", "u2"]], rejected: true },
  { label: "edited active user retained", input: { messageId: "u2", slotId: "u1" },
    active: ["u2", "a2"], selected: [["u1", "a2"]], latest: [["u1", "u2"]], rejected: false },
  { label: "empty active set rejects identified user", input: { messageId: "u1", slotId: "u1" },
    active: [], latest: [["u1", "u1"]], rejected: true },
  { label: "tree no slot", input: { messageId: "u1" }, active: ["u1"], rejected: false },
  { label: "tree no id retains existing fallback", input: { slotId: "u1" }, active: [], rejected: false },
  { label: "legacy explicit old user selection retained", input: { messageId: "u1", slotId: "s" },
    selected: [["s", "u1"]], latest: [["s", "u2"]], rejected: false },
  { label: "legacy unselected new user rejected", input: { messageId: "u2", slotId: "s" },
    selected: [["s", "u1"]], latest: [["s", "u2"]], rejected: true },
  { label: "legacy latest user retained", input: { messageId: "u2", slotId: "s" },
    latest: [["s", "u2"]], rejected: false },
  { label: "legacy previous user rejected", input: { messageId: "u1", slotId: "s" },
    latest: [["s", "u2"]], rejected: true },
  { label: "legacy no slot", input: { messageId: "u1" }, rejected: false },
  { label: "legacy no id", input: { slotId: "s" }, rejected: false },
  { label: "legacy idless and slotless", input: {}, rejected: false },
  { label: "legacy assistant marker behavior deliberately unchanged", input: { messageId: "u1", slotId: "u1" },
    selected: [["u1", "a1"]], latest: [["u1", "u1"]], rejected: true }
];
const scan = exports.indexSessionFile as Reject;
const postflight = exports.sourceStillCurrent as Reject;
for (const example of cases) {
  const active = example.active === undefined ? undefined : new Set(example.active);
  const selected = new Map(example.selected);
  const latest = new Map(example.latest);
  const before = JSON.stringify([example.input, example.active, [...selected], [...latest]]);
  const scanResult = scan(example.input, active, selected, latest);
  const postflightResult = postflight(example.input, active, selected, latest);
  assert.equal(scanResult, example.rejected, "scan: " + example.label);
  assert.equal(postflightResult, example.rejected, "postflight: " + example.label);
  assert.equal(scanResult, postflightResult, "both guards agree: " + example.label);
  assert.equal(JSON.stringify([example.input, active === undefined ? undefined : [...active], [...selected], [...latest]]),
    before, "predicate must not mutate fixtures");
}
console.log("temporal user selection predicates: " + cases.length + " cases passed in both guards");
