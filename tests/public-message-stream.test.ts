/** 流式公开正文只处理新分片；歧义前缀保守扣留，最终结果仍以 canonical 投影为准。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PublicAssistantStream, publicAssistantMessage } from "../src/session/publicMessage.js";

const fixtures = [
  "Hello, 世界 👋\nA long ordinary reply.",
  "before<biny_notification>private</biny_notification>after<biny_notification>more</biny_notification>end",
  "before<biny_notification>private without a closing tag",
  "</biny_notification> <<biny_notification></biny_notification> \t ",
  "A<bin<biny_notification>x</biny_notification>y_notification>private",
  "A<bin<biny_notification>x</biny_notification>y_notification>private</biny_notification>tail",
  "A<biny_not<biny_notification>x</biny_notification>ific<biny_notification>y</biny_notification>ation>private",
  "prefix<bin", "<other>ordinary XML</other>",
  "<think>private\nanalysis</thinking>Visible answer",
  " \t<thinking>private</think>   answer\n<think>more</think>done",
  "Answer\n\n</think>\nprivate forever",
  "</thinking>x is ordinary text\nend", "<thinkingx>ordinary text",
  "```xml\n<think>example</think>\n```\n<think>private</think>answer",
  "````xml\n```\n<think>example</think>\n`````\n<think>private</think>answer",
  "   ~~~~xml\n~~~\n<thinking>example</thinking>\n~~~~~\nanswer",
  "```xml\n<think>unclosed fence keeps examples visible",
  "``\n<think>private</think>answer", "    ```\n<think>private</think>answer",
  "before<bin\n<think>private</think>y_notification>hidden</biny_notification>after",
  "<think>private</think><thi   ", "<thi   \nordinary", "<thi   x",
  "<think>private</think><think>literal on the same line",
  "<think>private</think>```\n<think>private too</think>done",
  "A\n" + " \t".repeat(300) + "<think>private</think>answer",
  "A\n" + " \t".repeat(300) + "ordinary whitespace",
  "<biny_notification><think>private</think>hidden</biny_notification>answer",
  "<biny_notification>hidden\n</think>\nprivate forever",
  "``````\n<biny_notification>hidden even in code</biny_notification>\n</think>example\n``````",
  "\r\n\u00a0<think>private</think>answer",
  "<think>" + "x".repeat(2_000) + "</thinking>done",
  "<biny_notification>" + "x".repeat(2_000) + "</biny_notification>done"
];

function checkChunks(raw: string, chunks: readonly string[]): void {
  const stream = new PublicAssistantStream();
  let source = "";
  let emitted = "";
  for (const chunk of chunks) {
    source += chunk;
    emitted += stream.push(chunk);
    assert.ok(publicAssistantMessage(source).startsWith(emitted), `unsafe prefix for ${JSON.stringify(source)}: ${JSON.stringify(emitted)}`);
  }
  const canonical = publicAssistantMessage(raw);
  emitted += stream.finish(canonical);
  assert.equal(emitted, canonical);
  assert.equal(stream.finish(canonical), "", "finishing is idempotent");
}

test("stream projection matches canonical at every split and never publishes an unsafe prefix", () => {
  for (const raw of fixtures) {
    for (let split = 0; split <= raw.length; split += 1) {
      checkChunks(raw, [raw.slice(0, split), raw.slice(split)]);
    }
    checkChunks(raw, [...raw]);
    for (const size of [2, 3, 7, 19, 64]) {
      const chunks: string[] = [];
      for (let start = 0; start < raw.length; start += size) chunks.push(raw.slice(start, start + size));
      checkChunks(raw, chunks);
    }
  }
});

test("stream state resets between provider steps, retries and interrupted replies", () => {
  const stream = new PublicAssistantStream();
  for (const incomplete of ["<think>private", "<biny_notification>private", "```xml\n", "answer\n</think>hidden", "<thi", " ".repeat(1_000)]) {
    stream.push(incomplete);
    stream.reset();
    assert.equal(stream.push("New answer"), "New answer");
    assert.equal(stream.finish("New answer"), "");
    stream.reset();
  }
});

test("adversarial mixed protocol fragments remain a canonical prefix at every character", () => {
  const atoms = ["a", "\n", " ", "\t", "\r", "<", ">", "`", "~", "```", "~~~~", "<think>", "</think>", "<thinking>", "</thinking>", "<thi", "</think", "<biny_notification>", "</biny_notification>", "<bin", "private", "\u00a0", "nking>", "y_notification>"];
  let seed = 42;
  for (let sample = 0; sample < 1_000; sample += 1) {
    let raw = "";
    for (let index = 0; index < 20; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      raw += atoms[seed % atoms.length]!;
    }
    checkChunks(raw, [...raw]);
  }
});

test("exceptionally long ambiguous whitespace is deferred to canonical completion", () => {
  const stream = new PublicAssistantStream();
  const whitespace = " \t".repeat(300);
  assert.equal(stream.push("answer\n"), "answer\n");
  assert.equal(stream.push(whitespace), "");
  assert.equal(stream.push("tail"), "", "streaming does not retain an unbounded unfinished prefix");
  assert.equal(stream.finish("answer\n" + whitespace + "tail"), whitespace + "tail");
});

test("ordinary text is delivered in the current frame without rescanning accumulated text", () => {
  const stream = new PublicAssistantStream();
  for (let index = 0; index < 10_000; index += 1) assert.equal(stream.push("normal text "), "normal text ");
  const source = readFileSync(new URL("../src/agent/AgentSession.ts", import.meta.url), "utf8");
  const streaming = source.slice(source.indexOf('if (event.type === "message_update")'), source.indexOf('} else if (event.type === "turn_start")'));
  assert.doesNotMatch(streaming, /publicAssistantMessage\(stepAssistantContent\)/u, "the actual streaming hot path must consume the new delta only");
  assert.doesNotMatch(streaming, /agentMessageText\(event.message\)/u, "text deltas must not rejoin the accumulated message either");
  assert.match(streaming, /publicStream.push\(event.event.text\)/u);
});
