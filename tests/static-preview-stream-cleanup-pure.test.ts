/** Actual HTTP callback with inert path/stat/open substitutes and in-memory streams only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("StaticPreviewServer.ts", readFileSync(
  new URL("../src/desktop/electron/main/StaticPreviewServer.ts", import.meta.url), "utf8"
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const serverClass = source.statements.filter(ts.isClassDeclaration).find(node => node.name?.text === "StaticPreviewServer");
assert.ok(serverClass);
const methods = serverClass.members.filter(ts.isMethodDeclaration).filter(node => node.name.getText(source) === "listen");
assert.equal(methods.length, 1);
const declarations = methods[0]!.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const server = declarations.find(node => node.name.getText(source) === "server");
assert.ok(server?.initializer && ts.isCallExpression(server.initializer));
assert.equal(server.initializer.expression.getText(source), "createServer");
assert.equal(server.initializer.arguments.length, 1);
const callback = server.initializer.arguments[0]!;
assert.ok(ts.isArrowFunction(callback));
const mime = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(source) === "mimeTypes");
assert.ok(mime?.initializer);
const inside = source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "inside");
assert.ok(inside);
const emitted = ts.transpileModule(
  `const mimeTypes = ${mime.initializer.getText(source)};\n${inside.getText(source)}\nglobalThis.handler = ${callback.getText(source)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true }
);
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(/u.test(emitted.outputText), false);
const script = new Script(emitted.outputText);

interface Request { method: string; url: string; destroyed?: boolean; complete?: boolean }
type Response = Writable & { headersSent: boolean; writeHead(status: number, headers?: Record<string, string>): Response };
interface Reader {
  stream: Readable;
  destroyCalls: number;
  readCalls: number;
  errors: Error[];
  completeOpen?: () => void;
}
interface Options {
  body?: string;
  holdWrites?: boolean;
  deferOpen?: boolean;
  statGate?: Promise<void>;
  statError?: Error;
  isFile?: boolean;
  resolvedPath?: string;
  openError?: Error;
  sourceError?: Error;
}
function fixture(options: Options = {}) {
  const readers: Reader[] = [];
  const openedPaths: string[] = [];
  const heads: Array<{ status: number; headers?: Record<string, string> }> = [];
  const chunks: Buffer[] = [];
  const responseErrors: Error[] = [];
  let statCalls = 0;
  let responseDestroyCalls = 0;
  let responseFinalCalls = 0;
  let responseFinishEvents = 0;
  let pendingWrite: (() => void) | undefined;
  const response = new Writable({
    highWaterMark: options.holdWrites ? 1 : 16_384,
    write(chunk: Uint8Array, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      if (options.holdWrites) pendingWrite = () => done();
      else done();
    },
    final(done) { responseFinalCalls++; done(); },
    destroy(error, done) { responseDestroyCalls++; done(error); }
  }) as Response;
  response.headersSent = false;
  response.writeHead = (status, headers) => {
    if (response.headersSent) throw new Error("Headers already sent.");
    heads.push({ status, headers });
    // Node writeHead stores _header; headersSent reads !!_header before body flush.
    response.headersSent = true;
    return response;
  };
  response.on("error", error => { responseErrors.push(error); });
  response.on("finish", () => { responseFinishEvents++; });
  const createReadStream = (file: string): Readable => {
    openedPaths.push(file);
    if (options.openError) throw options.openError;
    const record: Reader = { stream: undefined as unknown as Readable, destroyCalls: 0, readCalls: 0, errors: [] };
    const stream = new Readable({
      highWaterMark: 4,
      construct(done) {
        if (options.deferOpen) record.completeOpen = () => { record.completeOpen = undefined; done(); };
        else done();
      },
      read() {
        record.readCalls++;
        if (options.sourceError) this.destroy(options.sourceError);
        else if (options.body !== undefined && record.readCalls === 1) {
          if (options.body) this.push(Buffer.from(options.body));
          this.push(null);
        }
      },
      destroy(error, done) { record.destroyCalls++; done(error); }
    });
    record.stream = stream;
    stream.on("error", error => { record.errors.push(error); });
    readers.push(record);
    return stream;
  };
  const context = createContext({
    fs: {
      realpath: async (value: string) => options.resolvedPath ?? value,
      stat: async () => {
        statCalls++;
        await options.statGate;
        if (options.statError) throw options.statError;
        return { isFile: () => options.isFile ?? true };
      }
    },
    path: path.posix,
    realRoot: "/inert/site",
    entry: "index.html",
    createReadStream,
    pipeline
  }, { codeGeneration: { strings: false, wasm: false } });
  script.runInContext(context, { timeout: 1000 });
  const handler = context.handler as (request: Request, response: Response) => void;
  return {
    readers, openedPaths, heads, response, responseErrors,
    async start(request: Partial<Request> = {}) {
      handler({ method: "GET", url: "/index.html", ...request }, response);
      await settle();
    },
    async cleanup() {
      for (const reader of readers) { reader.stream.destroy(); reader.completeOpen?.(); }
      response.destroy();
      pendingWrite?.();
      pendingWrite = undefined;
      await settle();
    },
    body: () => Buffer.concat(chunks).toString("utf8"),
    get statCalls() { return statCalls; },
    get responseDestroyCalls() { return responseDestroyCalls; },
    get responseFinalCalls() { return responseFinalCalls; },
    get responseFinishEvents() { return responseFinishEvents; }
  };
}
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function readerClosedOnce(f: ReturnType<typeof fixture>): void {
  assert.equal(f.readers.length, 1);
  assert.equal(f.readers[0]!.stream.destroyed, true);
  assert.equal(f.readers[0]!.stream.closed, true);
  assert.equal(f.readers[0]!.destroyCalls, 1);
}

test("closing an unfinished response destroys its owned source", async () => {
  const f = fixture();
  try {
    await f.start();
    const reader = f.readers[0]!;
    reader.stream.push(Buffer.from("partial"));
    await settle();
    assert.equal(f.body(), "partial");
    assert.equal(reader.stream.readableEnded, false);
    f.response.destroy();
    await settle();
    readerClosedOnce(f);
    assert.equal(f.responseFinalCalls, 0);
    assert.equal(f.heads.length, 1);
  } finally { await f.cleanup(); }
});

test("closing a backpressured response destroys the paused source", async () => {
  const f = fixture({ holdWrites: true });
  try {
    await f.start();
    f.readers[0]!.stream.push(Buffer.from("partial"));
    await settle();
    assert.equal(f.response.writableNeedDrain, true);
    assert.equal(f.readers[0]!.stream.isPaused(), true);
    f.response.destroy();
    await settle();
    readerClosedOnce(f);
    assert.equal(f.responseFinalCalls, 0);
  } finally { await f.cleanup(); }
});

test("destination failure also destroys the unfinished source exactly once", async () => {
  const f = fixture();
  const error = new Error("response failed");
  try {
    await f.start();
    f.response.destroy(error);
    await settle();
    readerClosedOnce(f);
    assert.equal(f.responseDestroyCalls, 1);
    assert.deepEqual(f.responseErrors, [error]);
    assert.equal(f.heads.length, 1);
    assert.equal(f.responseFinalCalls, 0);
  } finally { await f.cleanup(); }
});

test("destination close before asynchronous source construction releases the later resource", async () => {
  const f = fixture({ deferOpen: true });
  try {
    await f.start();
    const reader = f.readers[0]!;
    assert.equal(typeof reader.completeOpen, "function");
    f.response.destroy();
    await settle();
    assert.equal(reader.stream.destroyed, true);
    assert.equal(reader.destroyCalls, 0, "destruction waits for source construction");
    reader.completeOpen!();
    await settle();
    readerClosedOnce(f);
    assert.equal(reader.readCalls, 0);
    assert.equal(f.responseFinalCalls, 0);
  } finally { await f.cleanup(); }
});

for (const timing of ["before request", "during stat"] as const) {
  test(`already closed response ${timing} never opens a source or writes headers`, async () => {
    const gate = deferred();
    const f = fixture({ statGate: gate.promise });
    try {
      if (timing === "before request") f.response.destroy();
      await f.start();
      assert.equal(f.statCalls, 1);
      assert.equal(f.readers.length, 0);
      if (timing === "during stat") f.response.destroy();
      await settle();
      gate.resolve();
      await settle();
      assert.equal(f.readers.length, 0);
      assert.equal(f.openedPaths.length, 0);
      assert.equal(f.heads.length, 0);
      assert.equal(f.responseFinalCalls, 0);
    } finally { gate.resolve(); await f.cleanup(); }
  });
}

for (const body of ["<html>complete</html>", ""]) {
  test(`successful ${body ? "nonempty" : "empty"} GET keeps bytes and closes once`, async () => {
    const f = fixture({ body });
    try {
      await f.start({ destroyed: true, complete: true });
      assert.equal(f.body(), body);
      assert.equal(f.heads.length, 1);
      assert.equal(f.heads[0]!.status, 200);
      assert.equal(f.heads[0]!.headers?.["Content-Type"], "text/html; charset=utf-8");
      assert.equal(f.heads[0]!.headers?.["Cache-Control"], "no-cache");
      assert.equal(f.heads[0]!.headers?.["X-Content-Type-Options"], "nosniff");
      assert.deepEqual(f.openedPaths, ["/inert/site/index.html"]);
      readerClosedOnce(f);
      assert.equal(f.responseFinalCalls, 1);
      assert.equal(f.responseFinishEvents, 1);
      assert.equal(f.responseDestroyCalls, 1);
      assert.deepEqual(f.responseErrors, []);
    } finally { await f.cleanup(); }
  });
}

test("HEAD preserves headers and ends once without opening a source", async () => {
  const f = fixture();
  try {
    await f.start({ method: "HEAD" });
    assert.equal(f.heads.length, 1);
    assert.equal(f.heads[0]!.status, 200);
    assert.equal(f.readers.length, 0);
    assert.equal(f.responseFinalCalls, 1);
    assert.equal(f.responseFinishEvents, 1);
    assert.equal(f.body(), "");
    assert.deepEqual(f.responseErrors, []);
  } finally { await f.cleanup(); }
});

test("source failure closes both ends without a second response or normal end", async () => {
  const error = new Error("source failed");
  const f = fixture({ sourceError: error });
  try {
    await f.start();
    readerClosedOnce(f);
    assert.deepEqual(f.readers[0]!.errors, [error]);
    assert.equal(f.response.destroyed, true);
    assert.equal(f.responseDestroyCalls, 1);
    assert.equal(f.heads.length, 1);
    assert.equal(f.heads[0]!.status, 200);
    assert.equal(f.responseFinalCalls, 0);
    assert.equal(f.responseFinishEvents, 0);
    assert.ok(f.responseErrors.length <= 1);
  } finally { await f.cleanup(); }
});

for (const closed of [false, true]) {
  test(`stat failure ${closed ? "after disconnect sends nothing" : "before headers returns 500"}`, async () => {
    const gate = deferred();
    const f = fixture({ statGate: gate.promise, statError: new Error("stat failed") });
    try {
      await f.start();
      if (closed) f.response.destroy();
      await settle();
      gate.resolve();
      await settle();
      assert.equal(f.readers.length, 0);
      assert.equal(f.heads.length, closed ? 0 : 1);
      if (!closed) assert.equal(f.heads[0]!.status, 500);
      assert.equal(f.responseFinalCalls, closed ? 0 : 1);
      assert.equal(f.responseFinishEvents, closed ? 0 : 1);
    } finally { gate.resolve(); await f.cleanup(); }
  });
}

test("synchronous source factory failure after writeHead destroys instead of writing another status", async () => {
  const f = fixture({ openError: new Error("reader creation failed") });
  try {
    await f.start();
    assert.equal(f.openedPaths.length, 1);
    assert.equal(f.readers.length, 0);
    assert.equal(f.heads.length, 1);
    assert.equal(f.heads[0]!.status, 200);
    assert.equal(f.response.destroyed, true);
    assert.equal(f.responseDestroyCalls, 1);
    assert.equal(f.responseFinalCalls, 0);
  } finally { await f.cleanup(); }
});

for (const asset of [
  { url: "/", file: "index.html", mime: "text/html; charset=utf-8", body: "entry" },
  { url: "/pages/style.css?version=1", file: "pages/style.css", mime: "text/css; charset=utf-8", body: "body{}" },
  { url: "/pages/game.js", file: "pages/game.js", mime: "text/javascript; charset=utf-8", body: "ready()" },
  { url: "/model.data", file: "model.data", mime: "application/octet-stream", body: "asset bytes" }
]) {
  test(`successful asset ${asset.url} preserves resolved path, bytes, and MIME`, async () => {
    const f = fixture({ body: asset.body });
    try {
      await f.start({ url: asset.url });
      assert.equal(f.body(), asset.body);
      assert.equal(f.heads.length, 1);
      assert.equal(f.heads[0]!.status, 200);
      assert.equal(f.heads[0]!.headers?.["Content-Type"], asset.mime);
      assert.deepEqual(f.openedPaths, [`/inert/site/${asset.file}`]);
      readerClosedOnce(f);
    } finally { await f.cleanup(); }
  });
}

for (const rejected of [
  { method: "POST", url: "/index.html", status: 405 },
  { method: "GET", url: "/%", status: 400 },
  { method: "GET", url: "/.env", status: 403 },
  { method: "GET", url: "/%00", status: 403 },
  { method: "GET", url: "/a%5Cb", status: 403 },
  { method: "GET", url: "/../outside.html", status: 403 },
  { method: "GET", url: "/escape.html", status: 403, resolvedPath: "/inert/private/escape.html" },
  { method: "GET", url: "/directory", status: 404, isFile: false }
]) {
  test(`rejected ${rejected.method} ${rejected.url} keeps status and never opens a source`, async () => {
    const f = fixture({ resolvedPath: rejected.resolvedPath, isFile: rejected.isFile });
    try {
      await f.start({ method: rejected.method, url: rejected.url });
      assert.equal(f.heads.length, 1);
      assert.equal(f.heads[0]!.status, rejected.status);
      assert.equal(f.readers.length, 0);
      assert.equal(f.openedPaths.length, 0);
      assert.equal(f.responseFinishEvents, 1);
    } finally { await f.cleanup(); }
  });
}
