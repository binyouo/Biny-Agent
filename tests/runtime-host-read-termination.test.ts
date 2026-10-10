import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { RuntimeHostFrameDecoder } from "../src/runtime/host/framing.js";
import { encodeHostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";

class FakeSocket {
  destroyed = false;
  errors: Error[] = [];
  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.errors.push(error);
    return this;
  }
}

function fixture(maxBytes = 256) {
  const socket = new FakeSocket();
  const connection = { socket, authenticated: true, decoder: new RuntimeHostFrameDecoder(maxBytes) };
  let decoderCalls = 0;
  const push = connection.decoder.push.bind(connection.decoder);
  connection.decoder.push = (chunk) => { decoderCalls += 1; return push(chunk); };
  const queued: Array<() => Promise<unknown>> = [];
  const executed: HostRequestFrame[] = [];
  const responses: unknown[] = [];
  // Borrow only methods: never run the Host constructor or create a real socket.
  const host = Object.assign(Object.create(RuntimeHostServer.prototype), {
    pendingRequests: 0,
    activityRevision: 0,
    registry: { primary: () => ({ sessionId: "primary" }) },
    sessionWriterOwners: new Map(),
    dispatcher: {
      dispatch: (_lane: string, work: () => Promise<unknown>) => {
        return new Promise<unknown>((resolve, reject) => {
          queued.push(async () => {
            try { resolve(await work()); } catch (error) { reject(error); }
          });
        });
      }
    },
    execute: async (_connection: unknown, frame: HostRequestFrame) => { executed.push(frame); },
    send: (_connection: unknown, frame: unknown) => { responses.push(frame); }
  }) as RuntimeHostServer;
  return {
    socket, queued, executed, responses,
    decoderCalls: () => decoderCalls,
    read: (chunk: string) => host["read"](connection as unknown as Parameters<RuntimeHostServer["read"]>[0], chunk),
    runQueued: async () => { for (const work of queued) await work(); }
  };
}

function request(requestId: string): string {
  return encodeHostFrame({ kind: "request", requestId, operation: "client.keep-alive", payload: { keepAlive: false } });
}

test("valid coalesced frames dispatch in order", async () => {
  const f = fixture();
  f.read(request("first") + request("second"));
  assert.equal(f.queued.length, 2);
  await f.runQueued();
  assert.deepEqual(f.executed.map((frame) => frame.requestId), ["first", "second"]);
  assert.equal(f.socket.destroyed, false);
});

for (const [name, invalid, error] of [
  ["invalid request shape", "{}\n", /Invalid Runtime Host request/],
  ["invalid JSON", "{\n", /Invalid Runtime Host JSON frame/],
  ["oversized frame", `${"x".repeat(257)}\n`, /frame is too large/]
] as const) {
  test(`${name} stops later coalesced frames`, () => {
    const f = fixture();
    f.read(invalid + request("later"));
    assert.equal(f.socket.destroyed, true);
    assert.match(f.socket.errors[0]!.message, error);
    assert.equal(f.queued.length, 0);
  });
}

test("a later read on a destroyed socket does not dispatch", () => {
  const f = fixture();
  f.socket.destroy();
  f.read(request("later"));
  assert.equal(f.queued.length, 0);
  assert.equal(f.socket.errors.length, 0);
  assert.equal(f.decoderCalls(), 0);
});

test("fragmented frame and split UTF-8 character preserve request identity", async () => {
  const f = fixture();
  const utf8 = new StringDecoder("utf8");
  const bytes = Buffer.from(request("中文"));
  const boundary = bytes.indexOf(Buffer.from("中")) + 1;
  f.read(utf8.write(bytes.subarray(0, boundary)));
  assert.equal(f.queued.length, 0);
  f.read(utf8.write(bytes.subarray(boundary)));
  await f.runQueued();
  assert.deepEqual(f.executed.map((frame) => frame.requestId), ["中文"]);
  assert.equal(f.socket.destroyed, false);
});

test("fragmented invalid frame stops its coalesced successor and later reads", () => {
  const f = fixture();
  f.read("{");
  assert.equal(f.socket.destroyed, false);
  f.read("}\n" + request("same-chunk"));
  f.read(request("next-chunk"));
  assert.equal(f.queued.length, 0);
  assert.equal(f.socket.errors.length, 1);
});

test("work admitted before destruction is still executable", async () => {
  const f = fixture();
  f.read(request("admitted") + "{}\n" + request("too-late"));
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.queued.length, 1);
  await f.runQueued();
  assert.deepEqual(f.executed.map((frame) => frame.requestId), ["admitted"]);
});
