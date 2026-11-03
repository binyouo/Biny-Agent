import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import type { AgentImageContent, AgentToolResultMessage } from "../src/agent/core/types.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function image(prefix?: string, pixels = false): AgentImageContent {
  const width = pixels ? 640 : 1;
  const height = pixels ? 544 : 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let state = 0x12345678;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width * 3; column++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw[row * (width * 3 + 1) + column + 1] = (state >>> 24) & 255;
    }
  }
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (prefix) {
    // A valid private ancillary chunk carries synthetic bytes, not a credential.
    // Its padding aligns the encoded test fragment with the whole PNG's base64.
    let encoded = `/${prefix}ABCDEFGHIJKLMN/`;
    while (encoded.length % 4) encoded += "/";
    chunks.push(chunk("raNd", Buffer.concat([Buffer.alloc(1), Buffer.from(encoded, "base64")])));
  }
  chunks.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  const png = Buffer.concat(chunks);
  assert.ok(png.length <= 1024 * 1024);
  const data = png.toString("base64");
  if (prefix) assert.ok(data.includes(`${prefix}ABCDEFGHIJKLMN`));
  return { type: "image", mimeType: "image/png", data };
}

function result(content: AgentToolResultMessage["content"], toolName = "capture_image"): AgentToolResultMessage {
  return { role: "toolResult", toolCallId: "fixture-call", toolName, content, isError: false, timestamp: 0 };
}

async function persisted(message: AgentToolResultMessage): Promise<{ stored: AgentToolResultMessage; replayed: AgentToolResultMessage }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-image-persistence-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    recorder = new SessionRecorder(root);
    await recorder.recordAndFlush({ type: "user_message", content: "Synthetic media persistence fixture" });
    await recorder.recordAndFlush({ type: "agent_message", message: {
      role: "assistant", content: [{ type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} }], stopReason: "tool-calls"
    } });
    const recorded = await recorder.recordAndFlush({ type: "agent_message", message });
    assert.ok(recorded.type === "agent_message");
    const file = recorder.filePath;
    await recorder.close();
    recorder = undefined;
    const events = await readSessionEvents(file);
    const event = events.find((entry) => "messageId" in entry && entry.messageId === recorded.messageId);
    assert.ok(event?.type === "agent_message" && event.message.role === "toolResult");
    const replay = replaySessionEvents(events);
    const replayed = replay.messages.find((entry) => entry.role === "toolResult");
    assert.ok(replayed?.role === "toolResult");
    assert.equal(replay.recoveredToolResults.length, 0);
    return { stored: event.message, replayed };
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

for (const prefix of ["sk", "rk", "pk", "AIza", "AKIA"]) {
  test(`encoded PNG bytes containing ${prefix} survive durable recording and replay`, async () => {
    const part = image(prefix);
    const { stored, replayed } = await persisted(result([part]));
    assert.deepEqual(stored.content, [part]);
    assert.deepEqual(replayed.content, [part]);
  });
}

test("ordinary deterministic RGB pixels survive without adding ancillary metadata", async () => {
  const part = image(undefined, true);
  const { stored, replayed } = await persisted(result([part]));
  const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
  for (const message of [stored, replayed]) {
    assert.equal(message.content.length, 1);
    const actual = message.content[0];
    assert.ok(actual?.type === "image");
    assert.equal(actual.mimeType, part.mimeType);
    assert.equal(hash(actual.data), hash(part.data));
  }
});

test("an ordinary small PNG keeps its exact shape", async () => {
  const part = image();
  const { stored, replayed } = await persisted(result([part]));
  assert.deepEqual(stored.content, [part]);
  assert.deepEqual(replayed.content, [part]);
});

test("plain text and generic sensitive details remain redacted", async () => {
  const message = result([{ type: "text", text: "synthetic key skABCDEFGHIJKLMN" }]);
  message.details = { apiKey: "fixture-value", ordinary: "skABCDEFGHIJKLMN" };
  const { stored } = await persisted(message);
  assert.deepEqual(stored.content, [{ type: "text", text: "synthetic key [redacted]" }]);
  assert.deepEqual(stored.details, { apiKey: "[redacted]", ordinary: "[redacted]" });
});

for (const name of ["BrowserClipboardRead", "BrowserCDP", "ChromeRelayEval"]) {
  test(`${name} still removes its entire sensitive result including images`, async () => {
    const message = result([{ type: "text", text: "sensitive fixture" }, image("sk")], name);
    message.details = { ordinary: "sensitive fixture" };
    const { stored, replayed } = await persisted(message);
    assert.equal(stored.content.length, 1);
    assert.equal(stored.content[0]?.type, "text");
    assert.equal(stored.details, undefined);
    assert.deepEqual(replayed.content, stored.content);
  });
}

test("multiple binary parts survive without mutating the caller's text or image input", async () => {
  const first = image("sk");
  const second = image("pk");
  const message = result([first, { type: "text", text: "skABCDEFGHIJKLMN" }, second]);
  const before = structuredClone(message);
  const { stored, replayed } = await persisted(message);
  assert.deepEqual(message, before);
  assert.deepEqual(stored.content, [first, { type: "text", text: "[redacted]" }, second]);
  assert.deepEqual(replayed.content, stored.content);
});
