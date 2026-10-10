import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { BoundedUtf8Tail } from "../src/tools/shell/boundedUtf8Tail.js";

// Independent, intentionally simple oracle for small pure-data fixtures: keep
// whole Unicode scalars from the end until adding another exceeds the byte cap.
function scalarTail(text: string, limit: number): string {
  const scalars = Array.from(text);
  let bytes = 0;
  let start = scalars.length;
  while (start > 0) {
    const size = Buffer.byteLength(scalars[start - 1]!, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    start -= 1;
  }
  return scalars.slice(start).join("");
}

function checkTrace(limit: number, chunks: readonly string[]): void {
  const tail = new BoundedUtf8Tail(limit);
  let expected = "";
  for (const chunk of chunks) {
    expected = scalarTail(expected + chunk, limit);
    tail.append(chunk);
    assert.equal(tail.toString(), expected);
    assert.equal(tail.toString(), expected, "materialization is non-destructive");
    assert.equal(tail.retainedBytes, Buffer.byteLength(expected));
    assert.equal(tail.retainedBytes > 0, expected.length > 0);
  }
}

for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 8 * 1024 * 1024 + 1]) {
  assert.throws(() => new BoundedUtf8Tail(bad), RangeError);
}
const empty = new BoundedUtf8Tail(8 * 1024 * 1024);
empty.append("");
assert.equal(empty.toString(), "");
assert.equal(empty.retainedBytes, 0);
assert.equal(empty.allocatedBlockCount, 0);
assert.equal(empty.allocatedBackingBytes, 0);

for (const limit of [1, 2, 3, 4, 5, 7, 8, 31]) {
  checkTrace(limit, ["", "a", "中", "🙂", "é", "", "字尾", "ab", "😀x", "\0\n", "Z".repeat(limit), "x"]);
}
checkTrace(2, ["中", "a", "b", "中", "c"]);
checkTrace(37, ["head", "中🙂".repeat(20_000), "tail"]);
for (const limit of [16_385, 32_771]) {
  checkTrace(limit, ["F".repeat(limit), ...Array.from({ length: 24 }, () => "a中🙂".repeat(512)), "", "中"]);
}

// StringDecoder emits whole scalars even with arbitrary raw byte boundaries.
for (const raw of [Buffer.from("A中🙂éZ"), Buffer.from([0xff, 0xe4, 0xb8, 0xad, 0xc0, 0x80]), Buffer.from([0xf0, 0x9f, 0x99])]) {
  for (let split = 0; split <= raw.length; split += 1) {
    const decoder = new StringDecoder("utf8");
    const chunks = [decoder.write(raw.subarray(0, split)), decoder.write(raw.subarray(split)), decoder.end()];
    assert.equal(chunks.join(""), raw.toString("utf8"));
    for (const limit of [1, 3, 4, 7]) checkTrace(limit, chunks);
  }
  const oneByteDecoder = new StringDecoder("utf8");
  const oneByteChunks = Array.from(raw, (byte) => oneByteDecoder.write(Buffer.from([byte])));
  oneByteChunks.push(oneByteDecoder.end());
  assert.equal(oneByteChunks.join(""), raw.toString("utf8"));
  checkTrace(7, oneByteChunks);
}

// Diagnostic newline depends on the retained tail, not whether raw bytes arrived.
for (const [initial, limit, prefix] of [["中", 2, ""], ["x", 64, "\n"], ["", 64, ""]] as const) {
  const tail = new BoundedUtf8Tail(limit);
  tail.append(initial);
  const text = `${tail.retainedBytes > 0 ? "\n" : ""}Command interrupted.`;
  assert.equal(text, `${prefix}Command interrupted.`);
  const before = tail.toString();
  tail.append(text);
  assert.equal(tail.toString(), scalarTail(before + text, limit));
}
// A diagnostic can arrive before decoder.end; the pending replacement comes last.
const decoder = new StringDecoder("utf8");
const incomplete = Buffer.from([0xf0, 0x9f]);
const diagnosticTail = new BoundedUtf8Tail(64);
const decoded = decoder.write(incomplete);
assert.equal(decoded, "");
diagnosticTail.append(decoded);
const diagnostic = `${diagnosticTail.retainedBytes > 0 ? "\n" : ""}Command interrupted.`;
const rawBytes = incomplete.length + Buffer.byteLength(diagnostic);
diagnosticTail.append(diagnostic);
diagnosticTail.append(decoder.end());
assert.equal(diagnosticTail.toString(), "Command interrupted.\ufffd");
assert.equal(diagnosticTail.retainedBytes, Buffer.byteLength(diagnostic) + 3);
assert.equal(rawBytes > diagnosticTail.retainedBytes, false, "do not replace raw counters with encoded replacement bytes");

// Outside the documented decoded-text contract, native encoding replaces lone
// surrogates per chunk. It intentionally does not pair surrogates across chunks.
const malformed = new BoundedUtf8Tail(8);
malformed.append("\ud800");
malformed.append("\udc00");
assert.equal(malformed.toString(), "\ufffd\ufffd");

const bounded = new BoundedUtf8Tail(32_771);
bounded.append("x".repeat(32_771));
const internal = bounded as unknown as { blocks: Buffer[] };
const blocks = [...internal.blocks];
for (let i = 0; i < 32_768; i += 1) bounded.append("a");
assert.equal(bounded.toString(), "xxx" + "a".repeat(32_768));
assert.equal(bounded.allocatedBlockCount, 3);
assert.equal(bounded.allocatedBackingBytes, 32_771);
assert.ok(internal.blocks.every((block, index) => block === blocks[index]));
assert.deepEqual(internal.blocks.map((block) => block.buffer.byteLength), [16_384, 16_384, 3]);
const huge = new BoundedUtf8Tail(37);
huge.append("中🙂".repeat(20_000));
assert.equal(huge.allocatedBackingBytes, 37, "do not retain a view of the huge encoded input");
assert.equal(huge.allocatedBlockCount, 1);

console.log("bounded UTF-8 tail pure-data tests passed");
