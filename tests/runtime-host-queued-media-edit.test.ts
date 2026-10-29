/**
 * Source-isolated boundary regression: no Host, socket, Electron, AgentSession,
 * Recorder, database, SDK or model module is imported or started.
 * Only the selected IPC schema expression, Host queue-mutation case, and four
 * reviewed in-memory runtime methods execute against inert fixtures.
 * VM initialization has a 1s limit and disables generated strings/Wasm. Returned
 * functions subsequently run outside that initialization timeout; their audited
 * bodies contain only bounded fixture-array work and awaited inert callbacks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

function source(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(new URL("../" + relative, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function unique<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T, predicate: (node: T) => boolean): T {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node) && predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(matches.length, 1, "source extraction must identify exactly one node");
  return matches[0]!;
}

function variable(file: ts.SourceFile, name: string): ts.VariableDeclaration {
  return unique(file, ts.isVariableDeclaration, node => ts.isIdentifier(node.name) && node.name.text === name);
}

const ipc = source("src/desktop/electron/main/ipc.ts");
const server = source("src/runtime/host/server.ts");
const validation = source("src/runtime/host/validation.ts");
const runtimeSource = source("src/runtime/InteractiveAgentRuntime.ts");
const renderer = source("src/desktop/renderer/src/components/composer/QueuedMessages.tsx");
const ipcHandler = unique(ipc, ts.isCallExpression, node =>
  node.expression.getText(ipc) === "handleRecoveryGated"
  && node.arguments[0]?.getText(ipc) === "desktopIpc.mutateQueuedMessage");
const inputProperty = unique(ipcHandler, ts.isPropertyAssignment, node => node.name.getText(ipc) === "input");
const prompt = variable(ipc, "promptSchema").initializer!;
const queueCase = unique(server, ts.isCaseClause, node =>
  ts.isStringLiteral(node.expression) && node.expression.text === "run.queue.mutate");
const requiredString = unique(validation, ts.isFunctionDeclaration, node => node.name?.text === "requiredString");
const runtimeClass = unique(runtimeSource, ts.isClassDeclaration, node => node.name?.text === "InteractiveAgentRuntime");
const methodNames = ["updateQueuedRunMessage", "requireQueuedMessage", "queuedMessageSnapshots", "startQueuedMessageRun"];
const methods = methodNames.map(name => unique(runtimeClass, ts.isMethodDeclaration, node => node.name.getText(runtimeSource) === name).getText(runtimeSource));
const script = stripTypeScriptTypes([
  "const promptSchema = " + prompt.getText(ipc) + ";",
  "const editSchema = " + inputProperty.initializer.getText(ipc) + ";",
  requiredString.getText(validation).replace(/^export /u, ""),
  "class QueueProjection { " + methods.join("\n") + " }",
  "async function hostEdit(payload) { const runtime = this.runtime; const connection = {}; "
    + queueCase.statements.map(node => node.getText(server)).join("\n") + " }",
  "globalThis.extracted = { promptSchema, editSchema, QueueProjection, hostEdit };"
].join("\n"), { mode: "strip" });

interface Attachment { name: string; mimeType: string; data: string; path: string; size: number }
interface QueueItem { messageId: string; input: string; attachments: Attachment[] }
interface Snapshot { messageId: string; content: string; attachmentCount: number }
interface RuntimeFixture {
  queuedMessages: QueueItem[];
  closed: boolean;
  publishSnapshot(): void;
  startRun(...args: unknown[]): void;
  commandRuntime: { agent: { recordError(error: unknown): void } };
  updateQueuedRunMessage(messageId: string, input: string): Promise<void>;
  queuedMessageSnapshots(): Snapshot[];
  startQueuedMessageRun(previous: { runId: string; allowUserInput: boolean; capabilitySelection: unknown }): void;
}
interface HostFixture {
  runtime: RuntimeFixture;
  assertRevision(payload: Record<string, unknown>, runtime: RuntimeFixture): void;
  ensureSessionWriter(connection: object, runtime: RuntimeFixture): Promise<void>;
  assertEventSequenceAvailable(): void;
}
interface Extracted {
  promptSchema: z.ZodType<string>;
  editSchema: z.ZodType<string | undefined>;
  QueueProjection: new () => RuntimeFixture;
  hostEdit(this: HostFixture, payload: Record<string, unknown>): Promise<void>;
}
const sandbox: { z: typeof z; structuredClone: typeof structuredClone; isDeepStrictEqual: typeof isDeepStrictEqual; extracted?: Extracted } = { z, structuredClone, isDeepStrictEqual };
runInNewContext(script, sandbox, { timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false } });
assert.ok(sandbox.extracted);
const extracted = sandbox.extracted;

function fixture(attachments: Attachment[] = media()) {
  const item: QueueItem = { messageId: "queued", input: "original text and references", attachments };
  const runtime = new extracted.QueueProjection();
  const publications: Snapshot[][] = [];
  const starts: unknown[][] = [];
  runtime.queuedMessages = [item];
  runtime.closed = false;
  runtime.publishSnapshot = () => { publications.push(runtime.queuedMessageSnapshots()); };
  runtime.startRun = (...args) => { starts.push(args); };
  runtime.commandRuntime = { agent: { recordError(error) { throw error; } } };
  const boundaries: string[] = [];
  const host: HostFixture = {
    runtime,
    assertRevision() { boundaries.push("revision"); },
    async ensureSessionWriter() { boundaries.push("writer"); },
    assertEventSequenceAvailable() { throw new Error("update must not enter run admission"); }
  };
  const edit = async (input: unknown, ipcBoundary = true, messageId = "queued"): Promise<void> => {
    const parsed = ipcBoundary ? extracted.editSchema.parse(input) : input;
    await extracted.hostEdit.call(host, { action: "update", messageId, input: parsed });
  };
  return { item, runtime, host, edit, starts, publications, boundaries };
}

function media(): Attachment[] {
  return [
    { name: "picture.png", mimeType: "image/png", data: "synthetic-image", path: "@attachments/picture.png", size: 15 },
    { name: "clip.wav", mimeType: "audio/wav", data: "synthetic-audio", path: "@attachments/clip.wav", size: 15 }
  ];
}

for (const input of ["", " \t\n"]) {
  test("IPC and Host permit a native-media queue edit with " + JSON.stringify(input), async () => {
    const f = fixture();
    const attachments = f.item.attachments;
    const before = JSON.stringify(attachments);
    await f.edit(input);
    assert.equal(f.item.input, "");
    assert.equal(f.item.attachments, attachments);
    assert.equal(JSON.stringify(attachments), before);
    assert.deepEqual(JSON.parse(JSON.stringify(f.publications)), [[{ messageId: "queued", content: "", attachmentCount: 2 }]]);
    assert.deepEqual(f.boundaries, ["revision", "writer"]);
    const selection = { tools: "none", skills: "none" };
    f.runtime.startQueuedMessageRun({ runId: "previous", allowUserInput: false, capabilitySelection: selection });
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0]![0], "请分析这些附件。");
    const startedAttachments = f.starts[0]![1] as Attachment[];
    assert.equal(startedAttachments.length, attachments.length);
    attachments.forEach((attachment, index) => assert.equal(startedAttachments[index], attachment));
    assert.deepEqual(JSON.parse(JSON.stringify(f.starts[0]![6])), selection);
    assert.equal(f.runtime.queuedMessages.length, 0);
  });
}

test("Host boundary independently accepts empty native-media edits", async () => {
  const f = fixture();
  await f.edit("", false);
  assert.equal(f.item.input, "");
  assert.equal(f.item.attachments.length, 2);
});

test("text-only and reference-only queues still reject empty edits without mutation", async () => {
  for (const input of ["", " \n"]) {
    const f = fixture([]);
    f.item.input = "Attached files: @attachments/report.pdf";
    const before = JSON.stringify(f.item);
    await assert.rejects(f.edit(input), /Queued message cannot be empty/u);
    assert.equal(JSON.stringify(f.item), before);
    assert.equal(f.publications.length, 0);
  }
});

test("missing and non-string edits remain rejected at both boundaries", async () => {
  for (const input of [undefined, null, 1, false, [], {}]) {
    for (const ipcBoundary of [true, false]) {
      const f = fixture();
      const before = JSON.stringify(f.item);
      await assert.rejects(f.edit(input, ipcBoundary));
      assert.equal(JSON.stringify(f.item), before);
      assert.equal(f.publications.length, 0);
    }
  }
});

test("IPC preserves the length limit and general send schema", async () => {
  assert.equal(extracted.editSchema.parse("x".repeat(1_000_000))?.length, 1_000_000);
  const f = fixture();
  await assert.rejects(f.edit("x".repeat(1_000_001)));
  assert.equal(f.item.input, "original text and references");
  assert.equal(f.boundaries.length, 0);
  assert.throws(() => extracted.promptSchema.parse(""));
  assert.throws(() => extracted.promptSchema.parse("x".repeat(1_000_001)));
  assert.equal(extracted.promptSchema.parse("ordinary prompt"), "ordinary prompt");
});

test("nonempty edits retain trimming and attachments", async () => {
  const f = fixture();
  const attachments = f.item.attachments;
  await f.edit("  revised text  ");
  assert.equal(f.item.input, "revised text");
  assert.equal(f.item.attachments, attachments);
  assert.equal(f.publications.length, 1);
});

test("missing item and existing revision/writer errors leave the queue untouched", async () => {
  for (const failure of ["missing", "revision", "writer"] as const) {
    const f = fixture();
    const before = JSON.stringify(f.item);
    if (failure === "revision") f.host.assertRevision = () => { throw new Error("revision sentinel"); };
    if (failure === "writer") f.host.ensureSessionWriter = async () => { throw new Error("writer sentinel"); };
    await assert.rejects(f.edit("changed", true, failure === "missing" ? "absent" : "queued"),
      failure === "missing" ? /Queued message is no longer pending/u : new RegExp(failure + " sentinel", "u"));
    assert.equal(JSON.stringify(f.item), before);
    assert.equal(f.publications.length, 0);
    assert.deepEqual(f.boundaries, failure === "missing" ? ["revision", "writer"] : failure === "writer" ? ["revision"] : []);
  }
});

test("source keeps the existing empty-media display and normal edit entry points", () => {
  const commit = variable(renderer, "commitEdit").initializer!;
  assert.match(commit.getText(renderer), /const content = current\.content\.trim\(\)/u);
  assert.match(commit.getText(renderer), /await onUpdate\(current\.messageId, content\)/u);
  assert.doesNotMatch(commit.getText(renderer), /if\s*\([^)]*!content/u);
  const text = renderer.text;
  assert.match(text, /message\.content \|\| \x60\[\$\{String\(message\.attachmentCount\)\} 个文件\]\x60/u);
  assert.match(text, /onBlur=\{\(\) => \{ if \(!composing\.current\) void commitEdit\(\); \}\}/u);
  assert.match(text, /event\.key === "Enter" && !event\.shiftKey/u);
});
