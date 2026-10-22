import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { withMessageSentAt } from "../src/agent/modelMessages.js";

// Static extraction only: never import AgentSession, replay, Recorder, Runtime,
// attachment IO, SDKs, or a model. The executed functions are fixed pure projections.
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const source = parse("src/agent/AgentSession.ts");
const tree = parse("src/session/messageTree.ts");
const replaySource = parse("src/session/replay.ts");
const agent = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "AgentSession");
assert.ok(agent);
const hydrateMethod = agent.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === "rehydrateSessionMessages");
assert.ok(hydrateMethod?.body);
const extract = (file: ts.SourceFile, names: string[]) => names.map(name => {
  const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, `exactly one approved pure function: ${name}`);
  return found[0]!.getText(file).replace(/^export /u, "");
}).join("\n");
const treeFunctions = extract(tree, ["sessionMessageTree", "activeSessionMessageIds", "compatibleSessionSelections", "activeSessionEventsForPath"]);
const replayFunctions = extract(replaySource, ["uncoveredCanonicalToolCalls", "projectSessionConversation", "completeCanonicalStepResults",
  "replayReasoningParts", "normalizeToolArguments", "stringifyResult", "applyContextCheckpoint"]);
const script = `${treeFunctions}\n${replayFunctions}\nclass Hydrator { ${hydrateMethod.getText(source).replace(/^private /u, "")} }
({ Hydrator, activeSessionEventsForPath, prepare(events, start) {
  const projection = projectSessionConversation(activeSessionEventsForPath(events), {}, events);
  const kept = applyContextCheckpoint(projection, { firstKeptMessageIndex: start });
  return { messages: kept.messages, references: kept.references,
    offset: projection.messages.slice(0, start).filter(message => message.role === "user").length };
} })`;
const compiled = ts.transpileModule(script, { fileName: "inert-interrupted-attachments.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Part = { type: string; text?: string; data?: string };
type Message = { role: string; content: string | Part[] };
type Reference = { id?: string; index: number };
type Event = { type: string; content?: string; messageId?: string; parentMessageId?: string; slotId?: string;
  attachments?: Array<{ path: string }>; auditOnly?: boolean; message?: Message; reason?: string; runtime?: { runId: string } };
type Prepared = { messages: Message[]; references: Reference[]; offset: number };
type Host = { options: { attachmentRoot?: string }; assertAttachmentsSupported: (files: unknown[]) => void;
  rehydrateSessionMessages: (messages: Message[], events: Event[], offset: number, references?: Reference[]) => Promise<Message[]> };
const reads: string[] = [];
let supportChecks = 0;
const api = runInNewContext(compiled.outputText, {
  withMessageSentAt,
  readAttachmentFromRoot: async (root: string, reference: { path: string }) => {
    assert.equal(root, "inert-attachment-root");
    reads.push(reference.path);
    return reference.path === "missing" ? undefined : { data: reference.path };
  },
  attachmentMessageParts: (files: Array<{ data: string }>) => files.map(file => ({ type: "image", data: file.data }))
}, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as {
  Hydrator: new () => Host;
  prepare: (events: Event[], start: number) => Prepared;
  activeSessionEventsForPath: (events: Event[]) => Event[];
};
const host = new api.Hydrator();
host.options = { attachmentRoot: "inert-attachment-root" };
host.assertAttachmentsSupported = () => { supportChecks++; };
const user = (id: string | undefined, content: string, file?: string, parentMessageId?: string, runId?: string): Event => ({
  type: "user_message", content, messageId: id, parentMessageId, slotId: id,
  ...(file ? { attachments: [{ path: file }] } : {}), ...(runId ? { runtime: { runId } } : {})
});
const marker = (reason = "paused", runId?: string): Event => ({ type: "turn_interrupted", reason, content: `marker:${reason}`,
  ...(runId ? { runtime: { runId } } : {}) });
const images = (message: Message | undefined) => !message || typeof message.content === "string" ? []
  : message.content.filter(part => part.type === "image").map(part => part.data);
const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function hydrate(prepared: Prepared, events: Event[], byId = false): Promise<Message[]> {
  const before = JSON.stringify([prepared, events]);
  reads.length = 0;
  supportChecks = 0;
  const result = await host.rehydrateSessionMessages(prepared.messages, events, prepared.offset, byId ? prepared.references : undefined);
  assert.equal(JSON.stringify([prepared, events]), before, "hydration must not mutate shared messages, references, or facts");
  return normalize(result);
}
async function ordinary(events: Event[], start = 0): Promise<Message[]> {
  const before = JSON.stringify(events);
  const prepared = api.prepare(events, start);
  assert.equal(JSON.stringify(events), before, "projection must not mutate its source facts");
  return hydrate(prepared, events);
}

async function main(): Promise<void> {
  const failures: Error[] = [];
  async function check(name: string, body: () => Promise<void>): Promise<void> {
    try { await body(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(new Error(name, { cause: error })); console.log(`FAIL ${name}: ${String(error)}`); }
  }
  for (const reason of ["paused", "interrupted"]) {
    await check(`${reason} marker cannot steal a later real user's image`, async () => {
      const events = [user("first", "text", undefined, undefined, "r1"), marker(reason, "r1"), user("second", "picture", "P", "first", "r2")];
      const result = await ordinary(events);
      assert.equal(result[1]!.content, `marker:${reason}`);
      assert.deepEqual(images(result[2]), ["P"]);
      assert.deepEqual(reads, ["P"]);
      assert.equal(supportChecks, 3);
    });
  }
  await check("compaction retains a marker without consuming the next user's attachment", async () => {
    const events = [user("first", "text"), marker(), user("second", "picture", "P", "first")];
    const prepared = api.prepare(events, 1);
    assert.equal(prepared.offset, 1);
    const result = await hydrate(prepared, events);
    assert.equal(result[0]!.content, "marker:paused");
    assert.deepEqual(images(result[1]), ["P"]);
  });
  await check("compacted-away marker still occupies the offset slot", async () => {
    const events = [user("first", "text"), marker(), user("second", "picture", "P", "first")];
    const prepared = api.prepare(events, 2);
    assert.equal(prepared.offset, 2, "production projection counts the synthetic user in the removed prefix");
    assert.deepEqual(images((await hydrate(prepared, events))[0]), ["P"]);
    assert.deepEqual(reads, ["P"]);
  });
  await check("multiple markers and assistant messages preserve every user slot", async () => {
    const events = [user("first", "A", "A"), marker(), { type: "assistant_message", content: "answer" },
      user("second", "B", "B", "first"), marker("interrupted"), user("third", "C", "C", "second")];
    const result = await ordinary(events);
    assert.deepEqual(result.map(images), [["A"], [], [], ["B"], [], ["C"]]);
    assert.deepEqual(reads, ["A", "B", "C"]);
  });
  await check("legacy no-ID real users keep positional images around a marker", async () => {
    const events = [user(undefined, "legacy A", "A"), marker(), user(undefined, "legacy B", "B")];
    assert.deepEqual((await ordinary(events)).map(images), [["A"], [], ["B"]]);
  });
  await check("legacy compacted prefix with a marker preserves later no-ID attachment", async () => {
    const events = [user(undefined, "legacy A", "A"), marker(), user(undefined, "legacy B", "B")];
    assert.deepEqual((await ordinary(events, 2)).map(images), [["B"]]);
  });
  await check("a real user quoting marker text still receives its own image", async () => {
    const events = [user("first", "text"), marker(), user("second", "marker:paused", "P", "first")];
    const result = await ordinary(events);
    assert.equal(result[1]!.content, "marker:paused");
    assert.deepEqual(images(result[2]), ["P"]);
  });
  const branchedEvents = (): Event[] => [user("root", "root", undefined, undefined, "root-run"),
    user("old", "inactive", "wrong", "root", "old-run"), marker("interrupted", "old-run"),
    user("selected", "selected", "selected-image", "root", "selected-run"), marker("paused", "selected-run"),
    user("next", "next", "next-image", "selected", "next-run"),
    { type: "message_version_selected", messageId: "selected", slotId: "selected" }];
  await check("raw replay events exclude inactive users and their markers before slotting", async () => {
    const result = await ordinary(branchedEvents());
    assert.deepEqual(result.map(images), [[], ["selected-image"], [], ["next-image"]]);
    assert.equal(result[2]!.content, "marker:paused");
    assert.deepEqual(reads, ["selected-image", "next-image"]);
  });
  await check("compaction offset applies to active model-user slots, not physical events", async () => {
    assert.deepEqual((await ordinary(branchedEvents(), 3)).map(images), [["next-image"]]);
    assert.deepEqual(reads, ["next-image"]);
  });
  await check("already-active caller input remains aligned after selection", async () => {
    const events = normalize(api.activeSessionEventsForPath(branchedEvents()));
    assert.deepEqual((await ordinary(events)).map(images), [[], ["selected-image"], [], ["next-image"]]);
  });
  await check("checkpoint retry preserves ID lookup into a publicly inactive branch", async () => {
    const events = branchedEvents();
    const prepared: Prepared = { messages: [{ role: "user", content: "inactive" }, { role: "user", content: "marker:paused" }],
      references: [{ id: "old", index: 9 }, { index: 10 }], offset: 999 };
    const result = await hydrate(prepared, events, true);
    assert.deepEqual(result.map(images), [["wrong"], []]);
    assert.equal(result[1]!.content, "marker:paused");
    assert.deepEqual(reads, ["wrong"]);
  });
  await check("audit-only user receipts neither occupy slots nor supply images", async () => {
    const events = [{ ...user("receipt", "receipt", "audit-image"), auditOnly: true }, user("first", "text"), marker(),
      user("second", "picture", "P", "first")];
    assert.deepEqual((await ordinary(events)).map(images), [[], [], ["P"]]);
    assert.deepEqual(reads, ["P"]);
  });
  await check("passthrough auditOnly on a marker follows the actual replay branch", async () => {
    const events = [user(undefined, "text"), { ...marker(), auditOnly: true }, user(undefined, "picture", "P")];
    assert.deepEqual((await ordinary(events)).map(images), [[], [], ["P"]]);
  });
  await check("terminal marker remains a string and can be removed by exact continuation", async () => {
    const events = [user("first", "picture", "P"), marker()];
    const prepared = api.prepare(events, 0);
    const result = await hydrate(prepared, events);
    assert.equal(result[1]!.content, "marker:paused");
    assert.equal(result.filter((message, index) => !(prepared.references[index]?.id === undefined
      && message.role === "user" && message.content === "marker:paused")).length, 1);
  });
  await check("no attachment root reads nothing", async () => {
    host.options = {};
    const events = [user(undefined, "picture", "P"), marker()];
    const prepared = api.prepare(events, 0);
    assert.deepEqual(await hydrate(prepared, events), normalize(prepared.messages));
    assert.deepEqual(reads, []);
    assert.equal(supportChecks, 0);
    host.options = { attachmentRoot: "inert-attachment-root" };
  });
  await check("missing stored image leaves its real user textual", async () => {
    const events = [user(undefined, "text"), marker(), user(undefined, "missing picture", "missing")];
    const result = await ordinary(events);
    assert.equal(result[2]!.content, "missing picture");
    assert.deepEqual(reads, ["missing"]);
  });
  await check("ordinary histories without markers preserve image order", async () => {
    const events = [user("first", "A", "A"), user("second", "B", "B", "first")];
    assert.deepEqual((await ordinary(events)).map(images), [["A"], ["B"]]);
  });
  if (failures.length) throw new AggregateError(failures, `${failures.length} pure interrupted-attachment regression(s) failed`);
}

await main();
