import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { trackCliErrorListener } from "./helpers/cli-error-listener.js";

await test("repeated CLI listener cleanup preserves persistent and raw once identities", () => {
  const stream = new EventEmitter();
  stream.on("error", () => undefined);
  stream.once("error", () => undefined);
  const previous = stream.rawListeners("error");
  for (let index = 0; index < 13; index += 1) {
    const listener = trackCliErrorListener(stream);
    const owned = () => undefined;
    stream.on("error", owned);
    assert.equal(stream.listenerCount("error"), previous.length + 1);
    listener.capture();
    assert.equal(stream.rawListeners("error").includes(owned), true, "capture must not disable the handler");
    assert.equal(listener.dispose(), undefined);
    assert.deepEqual(stream.rawListeners("error"), previous);
  }
});

await test("rejected invocation still captures and disposes its fresh handler", async () => {
  const stream = new EventEmitter();
  const original = new Error("synthetic invocation failure");
  const listener = trackCliErrorListener(stream);
  await assert.rejects(async () => {
    try {
      try {
        stream.on("error", () => undefined);
        throw original;
      } finally {
        listener.capture();
      }
    } finally {
      assert.equal(listener.dispose(), undefined);
    }
  }, (error: unknown) => error === original);
  assert.deepEqual(stream.rawListeners("error"), []);
});

await test("cleanup leaves unrelated listeners added after capture intact", () => {
  const stream = new EventEmitter();
  const before = () => undefined;
  const owned = () => undefined;
  const later = () => undefined;
  stream.on("error", before);
  const listener = trackCliErrorListener(stream);
  stream.on("error", owned);
  listener.capture();
  stream.on("error", later);
  assert.equal(listener.dispose(), undefined);
  assert.deepEqual(stream.rawListeners("error"), [before, later]);
});

await test("ambiguous additions are diagnosed without removing unknown handlers", () => {
  const stream = new EventEmitter();
  const listener = trackCliErrorListener(stream);
  stream.on("error", () => undefined);
  stream.on("error", () => undefined);
  const added = stream.rawListeners("error");
  listener.capture();
  assert.match(listener.dispose()!, /received 2/u);
  assert.deepEqual(stream.rawListeners("error"), added);
});

await test("missing additions and changed preexisting listeners are diagnosed", () => {
  const stream = new EventEmitter();
  const missing = trackCliErrorListener(stream);
  missing.capture();
  assert.match(missing.dispose()!, /received 0/u);
  const before = () => undefined;
  stream.on("error", before);
  const changed = trackCliErrorListener(stream);
  stream.on("error", () => undefined);
  changed.capture();
  stream.removeListener("error", before);
  assert.match(changed.dispose()!, /Preexisting error listeners changed/u);
  assert.deepEqual(stream.rawListeners("error"), []);
});
