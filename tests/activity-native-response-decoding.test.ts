/** Real capture callers and in-memory byte streams; no daemon, sockets, or screen access. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { ActivityNativeClient } from "../src/desktop/electron/main/ActivityNativeClient.js";

interface Request {
  id: string;
  cmd: string;
  args: { expected_bundle?: string; out?: string };
}

class DaemonSocket extends Duplex {
  constructor(private readonly reply: (socket: DaemonSocket, request: Request) => void) { super(); }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const request = JSON.parse(chunk.toString("utf8")) as Request;
    queueMicrotask(() => this.reply(this, request));
    callback();
  }
  receive(...chunks: Buffer[]): void { for (const chunk of chunks) this.push(chunk); }
}

function frame(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`); }

async function fixture(t: TestContext, reply: (socket: DaemonSocket, request: Request) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-native-response-decoding-"));
  const sockets: DaemonSocket[] = [];
  const requestTimers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    const timer = realSetTimeout(callback, delay);
    if (delay === 30_000) requestTimers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout>) => {
    requestTimers.delete(timer);
    realClearTimeout(timer);
  });
  const client = new ActivityNativeClient(root, path.join(root, "temp"));
  t.mock.method(net, "connect", () => {
    const socket = new DaemonSocket(reply);
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected real daemon launch"); });
  syncBuiltinESMExports();
  t.after(async () => {
    await client.stop();
    assert.equal(requestTimers.size, 0, "no request timer survives shutdown");
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(spawn.mock.callCount(), 0);
    await rm(root, { recursive: true, force: true });
  });
  return { root, client, sockets, requestTimers };
}

for (const character of ["é", "中", "🙂"]) {
  for (let split = 1; split < Buffer.byteLength(character); split++) {
    await test(`captureAppshot reads the exact ${character} path when its UTF-8 character is split at byte ${split}`, async (t) => {
      let imagePath = "";
      const f = await fixture(t, (socket, request) => {
        assert.equal(request.cmd, "appshot_capture");
        const bytes = frame({ id: request.id, ok: true, data: { path: imagePath, bundleId: request.args.expected_bundle } });
        const boundary = bytes.indexOf(Buffer.from(character)) + split;
        assert.ok(boundary >= split);
        socket.receive(bytes.subarray(0, boundary), bytes.subarray(boundary));
      });
      imagePath = path.join(f.root, `${character}-snapshot.jpg`);
      const image = Buffer.from("isolated local image bytes");
      await writeFile(imagePath, image);
      assert.deepEqual(await f.client.captureAppshot(1280, "com.example.editor", []), image);
      await assert.rejects(readFile(imagePath), { code: "ENOENT" });
      assert.equal(f.sockets.length, 1);
      assert.equal(f.requestTimers.size, 0);
    });
  }
}

await test("one-byte chunks preserve a whole mixed Unicode path", async (t) => {
  let imagePath = "";
  const f = await fixture(t, (socket, request) => {
    const bytes = frame({ id: request.id, ok: true, data: { path: imagePath, bundleId: request.args.expected_bundle } });
    socket.receive(...Array.from(bytes, (byte) => Buffer.from([byte])));
  });
  imagePath = path.join(f.root, "é中🙂-snapshot.jpg");
  await writeFile(imagePath, "mixed Unicode image");
  assert.equal((await f.client.captureAppshot(1280, "com.example.editor", [])).toString(), "mixed Unicode image");
  assert.equal(f.requestTimers.size, 0);
});

for (const structured of [false, true]) {
  await test(`split UTF-8 preserves the daemon's ${structured ? "structured" : "string"} error and reuses the connection`, async (t) => {
    const message = "截图不可用：é中🙂";
    let requests = 0;
    const f = await fixture(t, (socket, request) => {
      requests++;
      const bytes = frame({ id: request.id, ok: false, error: structured ? { message } : message });
      socket.receive(...Array.from(bytes, (byte) => Buffer.from([byte])));
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.client.captureAppshot(1280, "com.example.editor", []), (error) => error instanceof Error && error.message === message);
      assert.equal(f.requestTimers.size, 0);
    }
    assert.equal(requests, 2);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.sockets[0]!.destroyed, false);
  });
}

await test("coalesced frames, unknown IDs, and a split next-frame remainder preserve request routing", async (t) => {
  let count = 0;
  let imagePath = "";
  const pendingUnknown = frame({ id: "unrelated", ok: false, error: "无关🙂" });
  const split = pendingUnknown.indexOf(Buffer.from("🙂")) + 2;
  const f = await fixture(t, (socket, request) => {
    const target = frame({ id: request.id, ok: true, data: { path: imagePath, bundleId: request.args.expected_bundle } });
    if (++count === 1) socket.receive(Buffer.concat([
      frame({ id: "other", ok: false, error: "ignored" }), target, pendingUnknown.subarray(0, split)
    ]));
    else socket.receive(Buffer.concat([pendingUnknown.subarray(split), target]));
  });
  imagePath = path.join(f.root, "snapshot.jpg");
  for (let attempt = 0; attempt < 2; attempt++) {
    await writeFile(imagePath, `image-${attempt}`);
    assert.equal((await f.client.captureAppshot(1280, "com.example.editor", [])).toString(), `image-${attempt}`);
    assert.equal(f.requestTimers.size, 0);
  }
  assert.equal(f.sockets.length, 1);
});

for (const invalid of [[0xff], [0xe4], [0xe4, 0xbd], [0xf0, 0x9f, 0x99]]) {
  await test(`malformed UTF-8 ${Buffer.from(invalid).toString("hex")} retains replacement decoding inside a complete error frame`, async (t) => {
    const raw = Buffer.from(invalid);
    const expected = `before ${raw.toString("utf8")} after`;
    const f = await fixture(t, (socket, request) => {
      const prefix = Buffer.from(`{"id":${JSON.stringify(request.id)},"ok":false,"error":"before `);
      socket.receive(prefix, ...invalid.map((byte) => Buffer.from([byte])), Buffer.from(" after\"}\n"));
    });
    await assert.rejects(f.client.captureAppshot(1280, "com.example.editor", []), (error) => error instanceof Error && error.message === expected);
    assert.equal(f.requestTimers.size, 0);
  });
}

for (const incomplete of [Buffer.from("{\"id\":"), Buffer.from([0xe4, 0xbd]), Buffer.from([0xf0, 0x9f, 0x99])]) {
  await test(`EOF after incomplete frame ${incomplete.toString("hex")} rejects promptly and discards decoder state on reconnect`, async (t) => {
    let requests = 0;
    let imagePath = "";
    const f = await fixture(t, (socket, request) => {
      if (++requests === 1) {
        socket.receive(incomplete);
        socket.push(null);
        socket.end();
      } else socket.receive(frame({ id: request.id, ok: true, data: { path: imagePath, bundleId: request.args.expected_bundle } }));
    });
    await assert.rejects(f.client.captureAppshot(1280, "com.example.editor", []), /截图连接已关闭/u);
    assert.equal(f.requestTimers.size, 0);
    assert.equal(f.sockets[0]!.destroyed, true);
    imagePath = path.join(f.root, "reconnected.jpg");
    await writeFile(imagePath, "fresh connection");
    assert.equal((await f.client.captureAppshot(1280, "com.example.editor", [])).toString(), "fresh connection");
    assert.equal(f.requestTimers.size, 0);
    assert.equal(f.sockets.length, 2);
  });
}

await test("invalid JSON closes the connection and clears the outstanding request timer", async (t) => {
  const f = await fixture(t, (socket) => socket.receive(Buffer.from("not JSON\n")));
  await assert.rejects(f.client.captureAppshot(1280, "com.example.editor", []), /截图连接已关闭/u);
  assert.equal(f.sockets[0]!.destroyed, true);
  assert.equal(f.requestTimers.size, 0);
});

await test("stopping during a partial character rejects and releases the outstanding request", async (t) => {
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const f = await fixture(t, (socket) => { socket.receive(Buffer.from([0xe4, 0xbd])); requested(); });
  const pending = f.client.captureAppshot(1280, "com.example.editor", []);
  const rejected = assert.rejects(pending, /截图服务已停止/u);
  await started;
  assert.equal(f.requestTimers.size, 1);
  await f.client.stop();
  await rejected;
  assert.equal(f.requestTimers.size, 0);
  assert.equal(f.sockets[0]!.destroyed, true);
});
