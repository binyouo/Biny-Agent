import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolCallContent } from "../src/agent/core/types.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-sensitive-redaction-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");

try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "browser-sensitive-redaction");
  for (const [index, tool] of ["BrowserDialogRespond", "BrowserDialogAutoReply"].entries()) {
    const text = `private-prompt-reply-${String(index)}`;
    const args = tool === "BrowserDialogRespond"
      ? { action: "accept", text }
      : { action: "arm", behavior: "accept", text };
    const persistedCall = recorder.record({ type: "tool_call", tool, args });
    assert.deepEqual((persistedCall as Extract<typeof persistedCall, { type: "tool_call" }>).args, { ...args, text: "[redacted]" });
    recorder.record({ type: "agent_message", message: { role: "assistant", content: [
      { type: "toolCall", id: `dialog-${String(index)}`, name: tool, arguments: args }
    ] } });
  }
  const clipboardText = "private-system-clipboard-value";
  const clipboardCall = recorder.record({ type: "tool_call", tool: "BrowserClipboardWrite", args: { text: clipboardText } });
  assert.deepEqual((clipboardCall as Extract<typeof clipboardCall, { type: "tool_call" }>).args, { text: "[redacted]" });
  recorder.record({ type: "agent_message", message: { role: "assistant", content: [
    { type: "toolCall", id: "clipboard-write", name: "BrowserClipboardWrite", arguments: { text: clipboardText } }
  ] } });
  const clipboardImage = Buffer.from("private clipboard image").toString("base64");
  const clipboardResult = recorder.record({ type: "tool_result", tool: "BrowserClipboardRead", result: { text: clipboardText, truncated: false, hasImage: true, imageStatus: "available", imageData: clipboardImage }, modelResult: { text: clipboardText, truncated: false, hasImage: true, imageStatus: "available", imageReturned: true } });
  assert.deepEqual((clipboardResult as Extract<typeof clipboardResult, { type: "tool_result" }>).result, { text: "[redacted]", truncated: false, hasImage: true, imageStatus: "available" });
  assert.deepEqual((clipboardResult as Extract<typeof clipboardResult, { type: "tool_result" }>).modelResult, { text: "[redacted]", truncated: false, hasImage: true, imageStatus: "available", imageReturned: true });
  recorder.record({ type: "agent_message", message: {
    role: "toolResult", toolCallId: "clipboard-read", toolName: "BrowserClipboardRead", content: [
      { type: "text", text: clipboardText }, { type: "image", mimeType: "image/jpeg", data: clipboardImage }
    ]
  } });
  const cdpParameter = "private-cdp-parameter";
  const cdpCall = recorder.record({ type: "tool_call", tool: "BrowserCDP", args: { method: "Network.setCookie", params: { name: "sid", value: cdpParameter } } });
  assert.deepEqual((cdpCall as Extract<typeof cdpCall, { type: "tool_call" }>).args, { method: "Network.setCookie", params: "[redacted]" });
  const cdpResult = recorder.record({ type: "tool_result", tool: "BrowserCDP", result: { cookies: [{ name: "sid", value: cdpParameter }] } });
  assert.equal((cdpResult as Extract<typeof cdpResult, { type: "tool_result" }>).result, "[browser CDP result redacted]");
  recorder.record({ type: "agent_message", message: { role: "assistant", content: [
    { type: "toolCall", id: "cdp-call", name: "BrowserCDP", arguments: { method: "Network.setCookie", params: { name: "sid", value: cdpParameter } } }
  ] } });
  recorder.record({ type: "agent_message", message: {
    role: "toolResult", toolCallId: "cdp-result", toolName: "BrowserCDP", content: [
      { type: "text", text: JSON.stringify({ cookies: [{ name: "sid", value: cdpParameter }] }) }
    ], details: { cookies: [{ name: "sid", value: cdpParameter }] }
  } });
  const relayCode = "private-relay-expression";
  const relayValue = "private-relay-page-value";
  const relayCall = recorder.record({ type: "tool_call", tool: "ChromeRelayEval", args: { browserId: "browser", tabId: 7, code: relayCode } });
  assert.deepEqual((relayCall as Extract<typeof relayCall, { type: "tool_call" }>).args, { browserId: "browser", tabId: 7, code: "[redacted]" });
  const relayResult = recorder.record({ type: "tool_result", tool: "ChromeRelayEval", result: { value: relayValue } });
  assert.equal((relayResult as Extract<typeof relayResult, { type: "tool_result" }>).result, "[Chrome Relay evaluation result redacted]");
  recorder.record({ type: "agent_message", message: { role: "assistant", content: [
    { type: "toolCall", id: "relay-eval-call", name: "ChromeRelayEval", arguments: { browserId: "browser", tabId: 7, code: relayCode } }
  ] } });
  recorder.record({ type: "agent_message", message: {
    role: "toolResult", toolCallId: "relay-eval-result", toolName: "ChromeRelayEval", content: [
      { type: "text", text: JSON.stringify({ value: relayValue }) }
    ], details: { value: relayValue }
  } });
  const ordinaryText = "ordinary browser input";
  recorder.record({ type: "tool_call", tool: "BrowserType", args: { value: ordinaryText } });
  const signedCalls: AgentToolCallContent[] = [
    { type: "toolCall", id: "signed-dialog", name: "BrowserDialogRespond", arguments: { action: "accept", text: "private-signed-dialog" } },
    { type: "toolCall", id: "signed-auto-dialog", name: "BrowserDialogAutoReply", arguments: { action: "arm", behavior: "accept", text: "private-signed-dialog" } },
    { type: "toolCall", id: "signed-clipboard", name: "BrowserClipboardWrite", arguments: { text: clipboardText } },
    { type: "toolCall", id: "signed-cdp", name: "BrowserCDP", arguments: { method: "Network.setCookie", params: { value: cdpParameter } } },
    { type: "toolCall", id: "signed-relay", name: "ChromeRelayEval", arguments: { code: relayCode } },
    { type: "toolCall", id: "signed-ordinary", name: "BrowserType", arguments: { value: ordinaryText } }
  ].map(call => ({ ...call, type: "toolCall", providerMetadata: { google: { thoughtSignature: "opaque-call-signature" } } }));
  for (const call of signedCalls) {
    const event = recorder.record({ type: "agent_message", message: { role: "assistant", content: [call] } });
    assert.equal(event.type, "agent_message");
    if (event.type !== "agent_message" || event.message.role !== "assistant") throw new Error("Expected assistant event");
    const persisted = event.message.content[0];
    assert.ok(persisted?.type === "toolCall");
    assert.deepEqual(persisted.providerMetadata, call.name === "BrowserType" ? call.providerMetadata : undefined);
  }
  await recorder.close();

  const session = await readFile(recorder.filePath, "utf8");
  assert.doesNotMatch(session, /private-prompt-reply-/u);
  assert.doesNotMatch(session, /private-system-clipboard-value/u);
  assert.doesNotMatch(session, /private-cdp-parameter/u);
  assert.doesNotMatch(session, /private-relay-expression|private-relay-page-value/u);
  assert.equal(session.includes(clipboardImage), false);
  assert.match(session, /ordinary browser input/u);
  assert.equal((JSON.parse(session.trim().split("\n")[0]!) as { args: { text: string } }).args.text, "[redacted]");

  const turnStore = new TurnStore(root, "browser-sensitive-redaction");
  await turnStore.save("continue", undefined, [{ role: "assistant", content: [
    ...["BrowserDialogRespond", "BrowserDialogAutoReply"].map((name, index) => ({
      type: "toolCall" as const,
      id: `checkpoint-${String(index)}`,
      name,
      arguments: name === "BrowserDialogRespond"
        ? { action: "accept", text: `private-prompt-reply-${String(index)}` }
        : { action: "arm", behavior: "accept", text: `private-prompt-reply-${String(index)}` }
    })),
    { type: "toolCall", id: "clipboard-write", name: "BrowserClipboardWrite", arguments: { text: clipboardText } },
    { type: "toolCall", id: "cdp-write", name: "BrowserCDP", arguments: { method: "Network.setCookie", params: { name: "sid", value: cdpParameter } } },
    { type: "toolCall", id: "relay-eval-write", name: "ChromeRelayEval", arguments: { browserId: "browser", tabId: 7, code: relayCode } },
    { type: "toolCall", id: "ordinary", name: "BrowserType", arguments: { value: ordinaryText } }
  ] }, {
    role: "toolResult", toolCallId: "clipboard-read", toolName: "BrowserClipboardRead", content: [
      { type: "text", text: clipboardText }, { type: "image", mimeType: "image/jpeg", data: clipboardImage }
    ]
  }, {
    role: "toolResult", toolCallId: "cdp-result", toolName: "BrowserCDP", content: [
      { type: "text", text: JSON.stringify({ cookies: [{ name: "sid", value: cdpParameter }] }) }
    ], details: { cookies: [{ name: "sid", value: cdpParameter }] }
  }, {
    role: "toolResult", toolCallId: "relay-eval-result", toolName: "ChromeRelayEval", content: [
      { type: "text", text: JSON.stringify({ value: relayValue }) }
    ], details: { value: relayValue }
  }], 1);
  const checkpoint = await turnStore.load();
  assert.ok(checkpoint);
  assert.doesNotMatch(JSON.stringify(checkpoint.messages), /private-prompt-reply-/u);
  assert.doesNotMatch(JSON.stringify(checkpoint.messages), /private-system-clipboard-value/u);
  assert.doesNotMatch(JSON.stringify(checkpoint.messages), /private-cdp-parameter/u);
  assert.doesNotMatch(JSON.stringify(checkpoint.messages), /private-relay-expression|private-relay-page-value/u);
  assert.equal(JSON.stringify(checkpoint.messages).includes(clipboardImage), false);
  assert.match(JSON.stringify(checkpoint.messages), /ordinary browser input/u);

  await turnStore.save("continue", undefined, [{ role: "assistant", content: signedCalls }], 1);
  const signedCheckpoint = await turnStore.load();
  assert.ok(signedCheckpoint);
  const assistant = signedCheckpoint.messages[0];
  assert.ok(assistant?.role === "assistant");
  for (const part of assistant.content) {
    assert.ok(part.type === "toolCall");
    assert.deepEqual(part.providerMetadata, part.name === "BrowserType" ? { google: { thoughtSignature: "opaque-call-signature" } } : undefined);
  }
  assert.doesNotMatch(JSON.stringify(signedCheckpoint.messages), /private-signed-dialog|private-system-clipboard-value|private-cdp-parameter|private-relay-expression/u);
  assert.equal(signedCalls[0]?.arguments.text, "private-signed-dialog");
  assert.deepEqual(signedCalls[0]?.providerMetadata, { google: { thoughtSignature: "opaque-call-signature" } });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
