import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
// Deliberately bounded structural fixture types, not a replacement event schema.
// This keeps isolated strict checking independent of Recorder/runtime dependencies.
type FixtureAssistantPart = { type: "text" | "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
interface FixtureMessageIdentity {
  messageId?: string;
  parentMessageId?: string;
  slotId?: string;
  replyToMessageId?: string;
  runtime?: { eventId: string; eventSeq: number; runId: string; turnId: string };
}
type SessionEvent = FixtureMessageIdentity & (
  | { type: "user_message"; content: string; auditOnly?: boolean }
  | { type: "assistant_message"; content: string; reasoningContent?: string }
  | { type: "agent_message"; message:
      | { role: "assistant"; content: FixtureAssistantPart[] }
      | { role: "toolResult"; toolCallId: string; toolName: string; content: Array<{ type: "text"; text: string }> } }
  | { type: "tool_call"; tool: string; args: unknown; toolCallId?: string; sequence?: number }
  | { type: "tool_result"; tool: string; result: unknown; toolCallId?: string; sequence?: number;
      executionStatus?: "succeeded" | "failed" | "cancelled" | "unknown" }
  | { type: "message_version_selected"; messageId: string; slotId: string }
);
interface ClaudeLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

// Read source text only. Never import transfer.ts, Recorder, storage, or runtime.
// Resolve the reviewed fixture source tree relative to this test, never cwd/env.
const root = new URL("../", import.meta.url);
const source = (file: string): string => readFileSync(new URL(file, root), "utf8");
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function declarations(file: string, names: readonly string[]): string {
  const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) {
      found.set(statement.name.text, statement.getText(parsed));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
          found.set(declaration.name.text, statement.getText(parsed));
        }
      }
    }
  }
  assert.equal(found.size, names.length, `Missing reviewed declaration in ${file}`);
  return names.map(name => found.get(name)!).join("\n");
}

function pureModule(file: string, allowedImports: readonly string[]): string {
  const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return parsed.statements.filter(statement => {
    if (!ts.isImportDeclaration(statement)) return true;
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    assert.ok(statement.importClause?.isTypeOnly || allowedImports.includes(statement.moduleSpecifier.text),
      `Unreviewed runtime import: ${statement.getText(parsed)}`);
    return false;
  }).map(statement => statement.getText(parsed)).join("\n");
}

function evaluate<T>(code: string, bindings: Record<string, unknown>, footer = ""): T {
  const result = ts.transpileModule(code + "\n" + footer, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  });
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  const exports: Record<string, unknown> = {};
  // No require, process, fs, network, or product module loader enters this realm.
  runInNewContext(result.outputText, { exports, ...bindings }, {
    timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false }
  });
  return exports as T;
}

const tree = evaluate<{
  activeSessionEventsForPath(events: readonly SessionEvent[]): SessionEvent[];
}>(pureModule("src/session/messageTree.ts", []), {});
const publicText = evaluate<{
  publicAssistantMessage(content: string): string;
}>(declarations("src/session/publicMessage.ts", [
  "notificationOpenTag", "notificationBlockPattern", "publicAssistantMessage", "stripReasoningEnvelope"
]), {});
const identity = evaluate<{
  createImportedMessageIdentity(): () => { messageId: string; parentMessageId?: string; slotId: string };
}>(pureModule("src/session/import/identity.ts", ["node:crypto"]), { randomBytes });
const importer = evaluate<{
  claudeLinesToBinyEvents(lines: readonly unknown[]): SessionEvent[];
}>(pureModule("src/session/import/claude.ts", ["./identity.js"]), identity);
const serializer = evaluate<{
  convert(events: readonly SessionEvent[]): ClaudeLine[];
}>(declarations("src/session/transfer.ts", [
  "binyEventsToClaudeLines", "reasoningTextOf", "toolResultText", "isRecord"
]), { ...tree, ...publicText }, "exports.convert = binyEventsToClaudeLines;");

const user = (id: string, content: string, parentMessageId?: string, slotId = id): SessionEvent =>
  ({ type: "user_message", messageId: id, parentMessageId, slotId, content });
function answer(id: string, content: string, parentMessageId: string, slotId: string, replyToMessageId = parentMessageId): SessionEvent[] {
  return [
    { type: "agent_message", messageId: id, parentMessageId, slotId, replyToMessageId,
      message: { role: "assistant", content: [{ type: "text", text: content }] } },
    { type: "assistant_message", messageId: id, parentMessageId, slotId, replyToMessageId, content }
  ];
}
function roundtrip(events: SessionEvent[]): SessionEvent[] {
  return json(tree.activeSessionEventsForPath(importer.claudeLinesToBinyEvents(serializer.convert(events))));
}
function conversation(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => {
    if (event.type === "user_message" && !event.auditOnly) return [event.content];
    if (event.type === "agent_message" && event.message.role === "assistant") {
      return event.message.content.flatMap(part => part.type === "text" ? [part.text] : []);
    }
    return [];
  });
}
function selectedAnswer(selected: "a1" | "a2"): SessionEvent[] {
  // Same parent/slot shape as tests/session-fork.test.ts:testMessageVersionReplay.
  return [
    user("u1", "same prompt"),
    ...answer("a1", "first answer", "u1", "slot1"),
    ...answer("a2", "second answer", "u1", "slot1"),
    { type: "message_version_selected", messageId: selected, slotId: "slot1" }
  ];
}

test("selected old assistant version remains the only answer after Claude roundtrip", () => {
  const events = selectedAnswer("a1");
  assert.deepEqual(conversation(roundtrip(events)), ["same prompt", "first answer"]);
});
test("selected latest assistant version excludes the replaced answer", () => {
  assert.deepEqual(conversation(roundtrip(selectedAnswer("a2"))), ["same prompt", "second answer"]);
});
test("inactive branch descendants do not become live imported turns", () => {
  const events: SessionEvent[] = [
    user("u1", "same prompt"), ...answer("a1", "first answer", "u1", "slot1"),
    user("old-followup", "discarded branch request", "a1"),
    ...answer("old-followup-answer", "discarded branch reply", "old-followup", "slot2"),
    ...answer("a2", "second answer", "u1", "slot1"),
    { type: "message_version_selected", messageId: "a2", slotId: "slot1" }
  ];
  assert.deepEqual(conversation(roundtrip(events)), ["same prompt", "second answer"]);
});

test("edited user branch retains only its own completed tool pair", () => {
  let eventSeq = 0;
  let callSequence = 0;
  const branch = (suffix: string, input: string): SessionEvent[] => {
    const uid = `u-${suffix}`, callId = `call-${suffix}`, toolMessage = `tool-call-${suffix}`;
    const resultMessage = `tool-result-${suffix}`;
    const toolSequence = ++callSequence;
    const events: SessionEvent[] = [
      user(uid, input, undefined, "u-old"),
      { type: "tool_call", tool: "Read", args: { path: `${suffix}.txt` }, toolCallId: callId, sequence: toolSequence },
      { type: "tool_result", tool: "Read", result: `${suffix} body`, toolCallId: callId,
        sequence: toolSequence, executionStatus: "succeeded" },
      { type: "agent_message", messageId: toolMessage, parentMessageId: uid, slotId: toolMessage,
        message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "Read",
          arguments: { path: `${suffix}.txt` } }] } },
      { type: "agent_message", messageId: resultMessage, parentMessageId: toolMessage, slotId: resultMessage,
        message: { role: "toolResult", toolCallId: callId, toolName: "Read",
          content: [{ type: "text", text: `${suffix} body` }] } },
      ...answer(`answer-${suffix}`, `${suffix} answer`, resultMessage, "u-old", uid)
    ];
    return events.map(event => ({ ...event, runtime: {
      eventId: `event-${++eventSeq}`, eventSeq, runId: `run-${suffix}`, turnId: `turn-${suffix}`
    } }));
  };
  // Native initial final answers use the user ID as slot. AgentSession.retry
  // preserves that original user slot for the sibling edited user and its answer.
  // Flat tool facts precede canonical step messages (toolExecutionCoordinator).
  const events: SessionEvent[] = [
    ...branch("old", "old request"), ...branch("new", "new request"),
    { type: "message_version_selected", messageId: "answer-new", slotId: "u-old",
      runtime: { eventId: `event-${++eventSeq}`, eventSeq, runId: "run-new", turnId: "turn-new" } }
  ];
  const imported = roundtrip(events);
  assert.deepEqual(conversation(imported), ["new request", "new answer"]);
  const facts = imported.filter(event => event.type === "tool_call" || event.type === "tool_result");
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map(event => event.toolCallId), ["call-new", "call-new"]);
  assert.equal(facts[0]?.type === "tool_call" ? (facts[0].args as { path: string }).path : undefined, "new.txt");
  assert.equal(facts[1]?.type === "tool_result" ? facts[1].result : undefined, "new body");
});

test("export does not infer missing tool identities from unique names", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "read file" },
    { type: "tool_call", tool: "Read", args: { path: "note.txt" } },
    { type: "tool_result", tool: "Read", result: "body", executionStatus: "succeeded" },
    { type: "assistant_message", content: "done" }
  ];
  const lines = json(serializer.convert(events));
  assert.equal(lines.length, 4);
  const imported = roundtrip(events);
  assert.deepEqual(conversation(imported), ["read file", "done"]);
  const facts = imported.filter(event => event.type === "tool_call" || event.type === "tool_result");
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.toolCallId, facts[1]?.toolCallId);
  assert.equal(facts[0]?.toolCallId, "");
  assert.ok(facts.every(event => event.auditOnly));
});
test("Recorder-linked user with legacy flat assistant preserves existing transfer fixture", () => {
  // tests/session-transfer.test.ts:recordConversation gets a linked user from
  // Recorder, but its assistant is a flat legacy event without canonical identity.
  const events: SessionEvent[] = [
    user("linked-user", "read file"),
    { type: "tool_call", tool: "Read", args: { path: "note.txt" }, toolCallId: "call_1" },
    { type: "tool_result", tool: "Read", toolCallId: "call_1", result: "body", executionStatus: "succeeded" },
    { type: "assistant_message", content: "done", reasoningContent: "read then summarize" }
  ];
  assert.deepEqual(conversation(roundtrip(events)), ["read file", "done"]);
  assert.equal(serializer.convert(events).length, 4);
});
test("linked linear legacy users and flat assistant IDs remain intact", () => {
  const events: SessionEvent[] = [
    user("u1", "first"), { type: "assistant_message", messageId: "legacy-answer", content: "answer" },
    user("u2", "second", "u1")
  ];
  assert.deepEqual(conversation(roundtrip(events)), ["first", "answer", "second"]);
});
test("Claude projection does not mutate source events", () => {
  const events = selectedAnswer("a1");
  const before = JSON.stringify(events);
  serializer.convert(events);
  assert.equal(JSON.stringify(events), before);
});

test("Biny bundle remains archival, including inactive versions and the selection", async () => {
  const events = selectedAnswer("a1");
  const before = JSON.stringify(events);
  const bundle = evaluate<{
    exportSessionBundle(root: string, session: string): Promise<{ content: string }>;
  }>(declarations("src/session/transfer.ts", ["exportSessionBundle"]), {
    BINY_BUNDLE_FORMAT: "biny-session-bundle", BINY_BUNDLE_VERSION: 2,
    readStoredSessionEvents: async () => ({ events }),
    resolveSessionFile: async () => "fixture.jsonl",
    sessionIdFromFile: () => "fixture",
    collectBundleAttachments: async () => ({ attachments: [], skipped: [] }),
    sanitizeBaseName: (name: string) => name
  });
  const exported = JSON.parse((await bundle.exportSessionBundle("unused", "fixture")).content) as {
    events: SessionEvent[]; manifest: { eventCount: number };
  };
  assert.deepEqual(exported.events, json(events));
  assert.equal(exported.manifest.eventCount, events.length);
  assert.equal(JSON.stringify(events), before);
});
