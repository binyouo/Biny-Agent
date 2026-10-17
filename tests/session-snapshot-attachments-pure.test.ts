import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { withMessageSentAt } from "../src/agent/modelMessages.js";

// Parse source as text. Never import AgentSession, recorder, runtime, or attachment IO.
const source = ts.createSourceFile("AgentSession.ts", readFileSync("src/agent/AgentSession.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const tree = ts.createSourceFile("messageTree.ts", readFileSync("src/session/messageTree.ts", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const agent = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "AgentSession");
assert.ok(agent);
const resume = agent.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === "resume");
const hydrate = agent.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === "rehydrateSessionMessages");
assert.ok(resume && hydrate && hydrate.body);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "this.rehydrateSessionMessages") calls.push(node);
  ts.forEachChild(node, visit);
}
visit(resume);
assert.equal(calls.length, 1);
const call = calls[0]!;
assert.equal(call.arguments.length, 4);
assert.equal(call.arguments[0]!.getText(source), "replay.messages");
assert.equal(call.arguments[2]!.getText(source), "replay.contextStartUserMessageIndex");
assert.equal(call.arguments[3]!.getText(source), "replay.retrySourceEvents ? replay.messageReferences : undefined");
assert.ok([
  "replay.events",
  "replay === snapshotReplay ? activeSessionEventsForPath(resumeEvents) : replay.events"
].includes(call.arguments[1]!.getText(source)), "review the exact source selection before executing changed syntax");

// Only these four pure, import-free projection functions are admitted.
const names = ["sessionMessageTree", "activeSessionMessageIds", "compatibleSessionSelections", "activeSessionEventsForPath"];
const functions = names.map(name => {
  const found = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1);
  return found[0]!.getText(tree).replace(/^export /u, "");
});
const method = hydrate.getText(source).replace(/^private /u, "");
const script = `${functions.join("\n")}\nclass Hydrator { ${method} }\n({ Hydrator, invoke: async function(replay, snapshotReplay, resumeEvents) { return await ${call.getText(source)}; } })`;
const compiled = ts.transpileModule(script, { fileName: "inert-snapshot-fixture.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Part = { type: string; text?: string; data?: string };
type Message = { role: string; content: string | Part[] };
type Event = { type: string; content?: string; messageId?: string; parentMessageId?: string; slotId?: string;
  attachments?: Array<{ path: string }>; auditOnly?: boolean; message?: Message; reason?: string };
type Replay = { messages: Message[]; events: Event[]; contextStartUserMessageIndex: number;
  messageReferences: Array<{ id?: string; index: number }>; retrySourceEvents?: Event[] };
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
  Hydrator: new () => { options: { attachmentRoot?: string }; assertAttachmentsSupported: (files: unknown[]) => void };
  invoke: (this: unknown, replay: Replay, snapshotReplay: Replay | undefined, events: Event[]) => Promise<Message[]>;
};
const host = new api.Hydrator();
host.options = { attachmentRoot: "inert-attachment-root" };
host.assertAttachmentsSupported = () => { supportChecks++; };
const user = (id: string | undefined, file: string, parentMessageId?: string, slotId = id): Event => ({
  type: "user_message", content: file, messageId: id, parentMessageId, slotId, attachments: [{ path: file }]
});
const replay = (messages: Message[], events: Event[] = [], offset = 0, ids: Array<string | undefined> = []): Replay => ({
  messages, events, contextStartUserMessageIndex: offset, messageReferences: messages.map((_, index) => ({ id: ids[index], index }))
});
const images = (messages: Message[]) => messages.flatMap(message => typeof message.content === "string" ? []
  : message.content.filter(part => part.type === "image").map(part => part.data));
const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function invoke(current: Replay, snapshot: Replay | undefined, events: Event[]): Promise<Message[]> {
  const before = JSON.stringify([current, snapshot, events]);
  reads.length = 0;
  supportChecks = 0;
  const result = await api.invoke.call(host, current, snapshot, events);
  assert.equal(JSON.stringify([current, snapshot, events]), before, "shared replay and event inputs remain immutable");
  return normalize(result);
}

async function main(): Promise<void> {
  const failures: Error[] = [];
  async function check(name: string, body: () => Promise<void>): Promise<void> {
    try { await body(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(new Error(name, { cause: error })); console.log(`FAIL ${name}: ${String(error)}`); }
  }
  await check("snapshot attachment references come from validated history", async () => {
    const current = replay([{ role: "user", content: "picture" }], [], 0, ["u"]);
    const result = await invoke(current, current, [user("u", "picture")]);
    assert.deepEqual(images(result), ["picture"]);
    assert.deepEqual(reads, ["picture"]);
    assert.equal(supportChecks, 1);
  });
  await check("snapshot selected user version cannot receive inactive attachment", async () => {
    const old = user("old", "old-image", undefined, "slot");
    const active = user("active", "active-image", undefined, "slot");
    const events = [old, active, { type: "message_version_selected", messageId: "active", slotId: "slot" }];
    const current = replay([{ role: "user", content: "active-image" }], [], 0, ["active"]);
    assert.deepEqual(images(await invoke(current, current, events)), ["active-image"]);
    assert.deepEqual(reads, ["active-image"]);
  });
  await check("snapshot legacy users without IDs retain attachment order", async () => {
    const current = replay([{ role: "user", content: "legacy" }]);
    assert.deepEqual(images(await invoke(current, current, [user(undefined, "legacy-image")])), ["legacy-image"]);
  });
  await check("snapshot compaction offset counts active users only", async () => {
    const events = [user("old", "inactive", undefined, "slot"), user("active", "compacted", undefined, "slot"),
      user("next", "retained", "active"), { type: "message_version_selected", messageId: "active", slotId: "slot" }];
    const current = replay([{ role: "user", content: "retained" }], [], 1, ["next"]);
    assert.deepEqual(images(await invoke(current, current, events)), ["retained"]);
    assert.deepEqual(reads, ["retained"]);
  });
  await check("audit-only receipts do not supply snapshot attachments", async () => {
    const events = [{ ...user("receipt", "audit"), auditOnly: true }, user("u", "real")];
    const current = replay([{ role: "user", content: "real" }], [], 0, ["u"]);
    assert.deepEqual(images(await invoke(current, current, events)), ["real"]);
    assert.deepEqual(reads, ["real"]);
  });
  await check("ordinary replay retains its event source", async () => {
    const current = replay([{ role: "user", content: "ordinary" }], [user("u", "ordinary")]);
    assert.deepEqual(images(await invoke(current, undefined, [user("u", "wrong-raw")])), ["ordinary"]);
  });
  await check("rejected snapshot with capability fallback retains replay source", async () => {
    const current = replay([{ role: "user", content: "recovered" }], [user("u", "recovered")]);
    const rejected = replay([{ role: "user", content: "stale" }]);
    assert.deepEqual(images(await invoke(current, rejected, [user("u", "wrong-raw")])), ["recovered"]);
  });
  await check("checkpoint retry retains ID-based event mapping", async () => {
    const current = replay([{ role: "user", content: "owned" }], [user("inactive", "wrong"), user("owned", "owned")], 0, ["owned"]);
    current.retrySourceEvents = current.events;
    assert.deepEqual(images(await invoke(current, undefined, [user("owned", "wrong-raw")])), ["owned"]);
    assert.deepEqual(reads, ["owned"]);
  });
  await check("no configured root performs no attachment reads", async () => {
    host.options = {};
    const current = replay([{ role: "user", content: "plain" }]);
    assert.deepEqual(await invoke(current, current, [user(undefined, "not-read")]), current.messages);
    assert.deepEqual(reads, []);
    host.options = { attachmentRoot: "inert-attachment-root" };
  });
  await check("missing stored file leaves text intact", async () => {
    const current = replay([{ role: "user", content: "missing" }]);
    assert.deepEqual(await invoke(current, current, [user(undefined, "missing")]), current.messages);
    assert.deepEqual(reads, ["missing"]);
  });
  await check("terminal synthetic interrupted marker stays textual", async () => {
    const current = replay([{ role: "user", content: "image" }, { role: "user", content: "interrupted marker" }]);
    const result = await invoke(current, current, [user(undefined, "image"), { type: "turn_interrupted", content: "interrupted marker", reason: "paused" }]);
    assert.deepEqual(images(result), ["image"]);
    assert.equal(result[1]!.content, "interrupted marker");
  });
  if (failures.length) throw new AggregateError(failures, `${failures.length} pure snapshot regression(s) failed`);
}

await main();
