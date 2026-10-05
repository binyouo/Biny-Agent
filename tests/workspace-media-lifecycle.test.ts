/** Exercise real HTTP responses and file handles without opening a listening socket. */
import assert from "node:assert/strict";
import { once, type EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { StaticPreviewServer } from "../src/desktop/electron/main/StaticPreviewServer.js";

type MediaHandler = {
  ensureMediaServer(): Promise<{ origin: string }>;
  serveMedia(request: IncomingMessage, response: ServerResponse): Promise<void>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function exchange(url: string, method = "GET", range?: string) {
  const chunks: Buffer[] = [];
  const written = deferred();
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); written.resolve(); callback(); }
  });
  const request = new IncomingMessage(socket as Socket);
  request.method = method;
  request.url = new URL(url).pathname;
  request.httpVersion = "1.1"; request.httpVersionMajor = 1; request.httpVersionMinor = 1;
  if (range !== undefined) request.headers.range = range;
  const response = new ServerResponse(request);
  response.assignSocket(socket as Socket);
  return { request, response, socket, written: written.promise, body: () => {
    const wire = Buffer.concat(chunks);
    return wire.subarray(wire.indexOf("\r\n\r\n") + 4).toString();
  } };
}

test("stopping one project terminates a media response still validating its file", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "biny-media-lifecycle-"));
  const preview = new StaticPreviewServer();
  const handler = preview as unknown as MediaHandler;
  t.mock.method(handler, "ensureMediaServer", async () => ({ origin: "http://127.0.0.1:0" }));
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, "0123456789");
  const first = await preview.getWorkspaceMediaUrl("first", "clip.mp4", () => file);
  const other = await preview.getWorkspaceMediaUrl("other", "clip.mp4", () => file);
  const pending = exchange(first.url, "GET", "bytes=2-5");
  const second = exchange(other.url, "GET", "bytes=-3");
  const entered = deferred();
  const release = deferred();
  const originalOpen = fs.open;
  const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); opened.push(handle); return handle;
  });
  const originalStat = fs.stat;
  let blocked = false;
  t.mock.method(fs, "stat", (async (...args: Parameters<typeof fs.stat>) => {
    const result = await Reflect.apply(originalStat, fs, args);
    if (!blocked && args[0] === file) { blocked = true; entered.resolve(); await release.promise; }
    return result;
  }) as typeof fs.stat);
  const serving = handler.serveMedia(pending.request, pending.response);
  try {
    await entered.promise;
    await preview.stop("first");
    release.resolve();
    await serving;
    assert.equal(pending.response.destroyed || pending.response.writableEnded, true,
      "a revoked request must not stay open after its handler returns");
    assert.equal(opened[0]?.fd, -1, "the pending request's file handle is closed");
    const finished = once(second.response, "finish");
    await handler.serveMedia(second.request, second.response);
    await finished;
    assert.equal(second.response.statusCode, 206);
    assert.equal(second.body(), "789", "the other project's media still streams");
  } finally {
    release.resolve(); await serving;
    pending.response.destroy(); second.response.destroy();
    await preview.disposeAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("cancelling a streaming response closes its file handle and allows another range request", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "biny-media-cancel-stream-"));
  const preview = new StaticPreviewServer();
  const handler = preview as unknown as MediaHandler;
  t.mock.method(handler, "ensureMediaServer", async () => ({ origin: "http://127.0.0.1:0" }));
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, Buffer.alloc(1024 * 1024, 97));
  const media = await preview.getWorkspaceMediaUrl("project", "clip.mp4", () => file);
  const first = exchange(media.url);
  const next = exchange(media.url, "GET", "bytes=2-5");
  const originalOpen = fs.open;
  const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); opened.push(handle); return handle;
  });
  try {
    await handler.serveMedia(first.request, first.response);
    await first.written;
    const handle = opened[0]!;
    assert.notEqual(handle.fd, -1);
    const closed = once(handle as unknown as EventEmitter, "close");
    first.response.destroy();
    await closed;
    assert.equal(handle.fd, -1);
    const finished = once(next.response, "finish");
    await handler.serveMedia(next.request, next.response);
    await finished;
    assert.equal(next.response.statusCode, 206);
    assert.equal(next.body(), "aaaa");
  } finally {
    first.response.destroy(); next.response.destroy();
    await preview.disposeAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("media HTTP framing preserves HEAD, single ranges, empty files, and rejected ranges", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "biny-media-framing-"));
  const preview = new StaticPreviewServer();
  const handler = preview as unknown as MediaHandler;
  t.mock.method(handler, "ensureMediaServer", async () => ({ origin: "http://127.0.0.1:0" }));
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, "0123456789");
  const media = await preview.getWorkspaceMediaUrl("project", "clip.mp4", () => file);
  const cases: [string, string | undefined, number, string, string | undefined][] = [
    ["GET", undefined, 200, "0123456789", undefined],
    ["HEAD", "bytes=2-5", 200, "", undefined],
    ["GET", "bytes=0-0", 206, "0", "bytes 0-0/10"],
    ["GET", "bytes=2-5", 206, "2345", "bytes 2-5/10"],
    ["GET", "bytes=7-", 206, "789", "bytes 7-9/10"],
    ["GET", "bytes=-3", 206, "789", "bytes 7-9/10"],
    ["GET", "bytes=-30", 206, "0123456789", "bytes 0-9/10"],
    ["GET", "bytes=8-50", 206, "89", "bytes 8-9/10"],
    ...["bytes=4-3", "bytes=10-", "bytes=-0", "bytes=0-1,3-4", "items=0-2", "bytes=-", "bytes=9007199254740992-"].map(range =>
      ["GET", range, 416, "", "bytes */10"] as [string, string, number, string, string])
  ];
  try {
    for (const [method, range, status, body, contentRange] of cases) {
      const current = exchange(media.url, method, range);
      try {
        const finished = once(current.response, "finish");
        await handler.serveMedia(current.request, current.response);
        await finished;
        assert.equal(current.response.statusCode, status, `${method} ${range}`);
        assert.equal(current.body(), body, `${method} ${range}`);
        assert.equal(current.response.getHeader("Content-Length"), String(method === "HEAD" ? 10 : Buffer.byteLength(body)));
        assert.equal(current.response.getHeader("Content-Range"), contentRange);
      } finally { current.response.destroy(); }
    }
    await fs.writeFile(file, "");
    for (const range of [undefined, "bytes=0-", "bytes=-1"]) {
      const current = exchange(media.url, "GET", range);
      try {
        const finished = once(current.response, "finish");
        await handler.serveMedia(current.request, current.response);
        await finished;
        assert.equal(current.response.statusCode, range === undefined ? 200 : 416);
        assert.equal(current.response.getHeader("Content-Length"), "0");
        assert.equal(current.body(), "");
        assert.equal(current.response.getHeader("Content-Range"), range === undefined ? undefined : "bytes */0");
      } finally { current.response.destroy(); }
    }
  } finally {
    await preview.disposeAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a full media response does not stream past its advertised content length if the file grows", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "biny-media-growth-"));
  const preview = new StaticPreviewServer();
  const handler = preview as unknown as MediaHandler;
  t.mock.method(handler, "ensureMediaServer", async () => ({ origin: "http://127.0.0.1:0" }));
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, "0123456789");
  const media = await preview.getWorkspaceMediaUrl("project", "clip.mp4", () => file);
  const current = exchange(media.url);
  const originalStat = fs.stat;
  t.mock.method(fs, "stat", (async (...args: Parameters<typeof fs.stat>) => {
    const result = await Reflect.apply(originalStat, fs, args);
    if (args[0] === file) await fs.appendFile(file, "appended");
    return result;
  }) as typeof fs.stat);
  try {
    const finished = once(current.response, "finish");
    await handler.serveMedia(current.request, current.response);
    await finished;
    assert.equal(current.response.statusCode, 200);
    assert.equal(current.response.getHeader("Content-Length"), "10");
    assert.equal(current.body(), "0123456789", "the stream must use the same size snapshot as its headers");
  } finally {
    current.response.destroy();
    await preview.disposeAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("premature EOF aborts full and ranged media responses instead of finishing an incomplete body", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "biny-media-short-read-"));
  const preview = new StaticPreviewServer();
  const handler = preview as unknown as MediaHandler;
  t.mock.method(handler, "ensureMediaServer", async () => ({ origin: "http://127.0.0.1:0" }));
  const file = path.join(dir, "clip.mp4");
  await fs.writeFile(file, "0123456789");
  const media = await preview.getWorkspaceMediaUrl("project", "clip.mp4", () => file);
  const originalStat = fs.stat;
  t.mock.method(fs, "stat", (async (...args: Parameters<typeof fs.stat>) => {
    const result = await Reflect.apply(originalStat, fs, args);
    if (args[0] === file) await fs.truncate(file, 3);
    return result;
  }) as typeof fs.stat);
  const originalOpen = fs.open;
  const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); opened.push(handle); return handle;
  });
  try {
    for (const range of [undefined, "bytes=2-5", "bytes=-3"]) {
      await fs.writeFile(file, "0123456789");
      const current = exchange(media.url, "GET", range);
      let finished = false;
      current.response.once("finish", () => { finished = true; });
      try {
        await handler.serveMedia(current.request, current.response);
        const handle = opened.at(-1)!;
        await once(handle as unknown as EventEmitter, "close");
        assert.equal(current.response.destroyed, true, `${range}: incomplete content must terminate the response`);
        assert.equal(finished, false, `${range}: EOF must not count as a complete response`);
        assert.equal(handle.fd, -1);
      } finally { current.response.destroy(); }
    }
  } finally {
    await preview.disposeAll();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
