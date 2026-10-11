import assert from "node:assert/strict";
import { recentEmotionMessagesFromEvents } from "../src/agent/context/emotionMessages.js";
import type { EmotionAnalysisMessage } from "../src/agent/context/emotionAnalysis.js";
import { messageText } from "../src/agent/modelMessages.js";
import { activeSessionMessageIds, sessionMessageTree } from "../src/session/messageTree.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { redactSecrets } from "../src/utils/redaction.js";

// Previous projection: intentionally transform the whole active path before taking its tail.
function previousProjection(events: readonly SessionEvent[]): EmotionAnalysisMessage[] {
  const activeIds = activeSessionMessageIds(events);
  return sessionMessageTree(events)
    .filter((node) => activeIds.has(node.id) && (node.message.role === "user" || node.message.role === "assistant"))
    .map((node): EmotionAnalysisMessage | undefined => {
      const text = redactSecrets(messageText(node.message));
      if (!text.trim()) return undefined;
      return node.message.role === "user" ? { role: "user", text } : { role: "assistant", text };
    })
    .filter((message): message is EmotionAnalysisMessage => message !== undefined)
    .slice(-10);
}

function user(id: string, content: string, parentMessageId?: string): SessionEvent {
  return { type: "user_message", messageId: id, parentMessageId, content };
}
function assistant(id: string, text: string, parentMessageId?: string, slotId?: string): SessionEvent {
  return { type: "agent_message", messageId: id, parentMessageId, slotId,
    message: { role: "assistant", content: [{ type: "text", text }] } };
}
function linear(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => index % 2
    ? assistant(String(index), `message-${String(index)}`, String(index - 1))
    : user(String(index), `message-${String(index)}`, index ? String(index - 1) : undefined));
}
function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function equivalent(events: SessionEvent[]): EmotionAnalysisMessage[] {
  const before = JSON.stringify(events);
  freeze(events);
  const expected = previousProjection(events);
  const actual = recentEmotionMessagesFromEvents(events);
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(events), before, "projection must not mutate input");
  assert.deepEqual(recentEmotionMessagesFromEvents(events), actual, "repeat calls remain stable");
  return actual;
}

for (const count of [0, 1, 10, 11, 100, 20_000]) {
  assert.deepEqual(equivalent(linear(count)).map((message) => message.text),
    Array.from({ length: Math.min(count, 10) }, (_, index) => `message-${String(Math.max(0, count - 10) + index)}`));
}

const blankTail = linear(15);
for (let index = 15; index < 40; index += 1) blankTail.push(user(String(index), index % 2 ? "" : " \t\n　", String(index - 1)));
assert.deepEqual(equivalent(blankTail).map((message) => message.text),
  Array.from({ length: 10 }, (_, index) => `message-${String(index + 5)}`));
assert.deepEqual(equivalent([user("empty", "\t\n　")]), []);
assert.deepEqual(equivalent([
  { type: "user_message", content: "legacy user without id" },
  { type: "assistant_message", content: "legacy assistant", messageId: "legacy" },
  { type: "user_message", content: "audit only", messageId: "audit", auditOnly: true }
]), []);

const branches: SessionEvent[] = [
  user("root", "root"), assistant("old", "old", "root", "answer"), user("old-child", "old child", "old"),
  assistant("new", "new", "root", "answer"), user("new-child", "new child", "new")
];
assert.deepEqual(equivalent(structuredClone(branches)).map((message) => message.text), ["root", "new", "new child"]);
assert.deepEqual(equivalent([...branches, { type: "message_version_selected", slotId: "answer", messageId: "old" }])
  .map((message) => message.text), ["root", "old", "old child"]);
equivalent([...branches, { type: "message_version_selected", slotId: "answer", messageId: "absent" }]);
equivalent([...branches, { type: "message_version_selected", slotId: "answer", messageId: "old" },
  { type: "message_version_selected", slotId: "answer", messageId: "new" }]);
assert.deepEqual(equivalent([user("dup", "first"), user("dup", "second"), assistant("tail", "tail", "dup")])
  .map((message) => message.text), ["first", "second", "tail"]);
assert.deepEqual(equivalent([user("orphan", "orphan", "missing")]), [{ role: "user", text: "orphan" }]);
equivalent([user("a", "a", "b"), user("b", "b", "a"),
  { type: "message_version_selected", messageId: "a", slotId: "cycle" }]);
equivalent([user("self", "self", "self")]);

// Every credential-like value here is synthetic, and no external services are used.
const secretSamples = [
  ["sk-syntheticabcdefgh", "[redacted]"],
  ["Bearer synthetic-token", "Bearer [redacted]"],
  ["rk-syntheticabcdefgh pk-syntheticabcdefgh ghp_syntheticabcdefgh github_pat_syntheticabcdefgh", "[redacted] [redacted] [redacted] [redacted]"],
  ["AIzaSyntheticabcdefgh AKIASyntheticabcdefgh", "[redacted] [redacted]"],
  ["aws_secret_access_key=synthetic,_authToken:synthetic", "aws_secret_access_key=[redacted],_authToken:[redacted]"],
  ["access_token=synthetic，refresh-token:synthetic、secret=synthetic", "access_token=[redacted]，refresh-token:[redacted]、secret=[redacted]"],
  ["api_key=synthetic；保留", "api_key=[redacted]；保留"],
  ['{"password":"synthetic value"}', '{"password":"[redacted]"}'],
  ["-----BEGIN PRIVATE KEY-----\nsynthetic only\n-----END PRIVATE KEY-----", "[redacted private key]"],
  ["x".repeat(149) + " Bearer synthetic-token", "x".repeat(149) + " Bearer [redacted]"],
  ["\n".repeat(150) + "-----BEGIN PRIVATE KEY-----" + "S".repeat(300) + "-----END PRIVATE KEY-----", "\n".repeat(150) + "[redacted private key]"]
];
for (const [input, expected] of secretSamples) {
  assert.deepEqual(equivalent([user("secret", input!)]), [{ role: "user", text: expected }]);
}

const structured: SessionEvent[] = [
  user("u", "开始🧪é"),
  { type: "agent_message", messageId: "a", parentMessageId: "u", message: {
    role: "assistant", content: [{ type: "text", text: "正文" }, { type: "reasoning", text: "思考" },
      { type: "toolCall", id: "call", name: "fake", arguments: { password: "synthetic-only", value: "中😀" } }]
  } },
  { type: "agent_message", messageId: "tool", parentMessageId: "a", message: {
    role: "toolResult", toolCallId: "call", toolName: "fake", content: [{ type: "text", text: "excluded tool output" }]
  } },
  assistant("tail", "结束", "tool")
];
assert.deepEqual(equivalent(structured).map((message) => message.text), ["开始🧪é", '正文思考{"password":"[redacted]","value":"中😀"}', "结束"]);
assert.equal(messageText({ role: "user", content: [{ type: "text", text: "图" },
  { type: "image", data: "synthetic", mimeType: "image/png" }, { type: "audio", data: "synthetic", mimeType: "audio/wav" }] }),
"图[image/png image][audio/wav audio]");

// Full text acceptance happens before downstream truncation. Do not backfill an older
// message if a selected message becomes blank after its first 150 code points.
const leading = linear(11);
leading.push(user("space", " ".repeat(150) + "visible beyond limit", "10"));
const projected = equivalent(leading);
assert.equal(projected.length, 10);
assert.equal(projected[0]?.text, "message-2");
assert.equal(projected.at(-1)?.text, " ".repeat(150) + "visible beyond limit");
const normalized = projected.map((message) => ({ ...message, text: Array.from(message.text).slice(0, 150).join("") }))
  .filter((message) => message.text.trim()).slice(-10);
assert.equal(normalized.length, 9);
assert.equal(normalized[0]?.text, "message-2");
assert.equal(equivalent([user("unicode", "😀".repeat(151))])[0]?.text, "😀".repeat(151));

// Differential graphs include forward parents, cycles, duplicate IDs, blanks,
// ignored roles, and competing version selections. All inputs are generated.
let seed = 0x52ab17;
const random = (limit: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
};
for (let run = 0; run < 500; run += 1) {
  const events: SessionEvent[] = [];
  const count = random(80);
  for (let index = 0; index < count; index += 1) {
    const id = String(random(count + 3));
    const parent = random(5) ? String(random(count + 3)) : undefined;
    const text = ["", " \t\n", `synthetic-${String(index)}`, "😀中文", "token=synthetic；ok"][random(5)]!;
    const kind = random(4);
    events.push(kind === 0 ? user(id, text, parent) : kind === 1 ? assistant(id, text, parent) : kind === 2
      ? { type: "agent_message", messageId: id, parentMessageId: parent, message: { role: "toolResult", toolCallId: id, toolName: "fake", content: [{ type: "text", text }] } }
      : { type: "assistant_message", content: text, messageId: id });
  }
  for (let index = 0, count = random(5); index < count; index += 1) {
    events.push({ type: "message_version_selected", slotId: String(random(3)), messageId: String(random(83)) });
  }
  equivalent(events);
}
console.log("emotion message projection tests passed (500 generated graphs plus boundaries)");
