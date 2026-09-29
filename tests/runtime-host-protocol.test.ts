import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import { RuntimeHostFrameDecoder } from "../src/runtime/host/framing.js";
import {
  decodeHostFrame,
  encodeHostFrame,
  isEventFrame,
  isHelloFrame,
  isRequestFrame,
  isResponseFrame,
  isRetiredFrame,
  runtimeHostProtocolVersion
} from "../src/runtime/host/protocol.js";

const request = {
  kind: "request" as const,
  requestId: "request-1",
  operation: "runtime.snapshot",
  payload: { sessionId: "session-1" }
};

const hello = {
  kind: "hello" as const,
  requestId: "hello-1",
  protocolVersion: runtimeHostProtocolVersion,
  rootHash: "root-hash",
  token: "host-token",
  configRoot: "/config",
  agentRoot: "/agent",
  clientId: "client-1",
  surface: "cli" as const,
  capabilities: ["runtime.authority"]
};

assert.deepEqual(decodeHostFrame(encodeHostFrame(request).trim()), request);
assert.equal(isRequestFrame(request), true);
assert.equal(isHelloFrame(hello), true);
assert.equal(isHelloFrame({ ...hello, keepAlive: false }), true);
assert.equal(isHelloFrame({ ...hello, keepAlive: "false" }), false);
assert.equal(isRetiredFrame({ kind: "retired", hostEpoch: "epoch", reason: "idle" }), true);
assert.equal(isRetiredFrame({ kind: "retired", hostEpoch: "epoch", reason: "crashed" }), false);
assert.equal(isResponseFrame({ kind: "response", requestId: "request-1", ok: true }), true);
assert.equal(isEventFrame({ kind: "event", hostEpoch: "epoch", sequence: 1, update: {} }), false);
assert.throws(() => decodeHostFrame("not-json"), /Invalid Runtime Host JSON frame/u);

const decoder = new RuntimeHostFrameDecoder(8);
assert.deepEqual([...decoder.push("123456")], []);
assert.deepEqual([...decoder.push("78\nabcdef\n12")], ["12345678", "abcdef"], "限制针对每个帧，而不是合并的 socket chunk");
assert.deepEqual([...decoder.push("345678\n")], ["12345678"]);
assert.throws(() => [...new RuntimeHostFrameDecoder(8).push("123456789")], /too large/);
assert.throws(() => [...new RuntimeHostFrameDecoder(8).push("         \n")], /too large/, "trim 不能绕过帧限制");
const unicodeDecoder = new RuntimeHostFrameDecoder(6);
const utf8 = new StringDecoder("utf8");
const chinese = Buffer.from("中文\n");
assert.deepEqual([...unicodeDecoder.push(utf8.write(chinese.subarray(0, 2)))], []);
assert.deepEqual([...unicodeDecoder.push(utf8.write(chinese.subarray(2)))], ["中文"]);

console.log("runtime-host protocol tests passed");
