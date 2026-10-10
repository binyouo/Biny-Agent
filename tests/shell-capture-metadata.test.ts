import assert from "node:assert/strict";
import { captureMetadata } from "../src/tools/shell/captureMetadata.js";
import { commandStreamFields } from "../src/agent/commandStreamFields.js";
import { shellOutputExcerpt } from "../src/agent/shellOutputProjection.js";
import { redactSensitiveValue } from "../src/utils/secrets.js";

// Decoded UTF-8 accounting is independent of the original process byte count.
for (const fixture of [
  { text: "", raw: 0, decoded: 0, omitted: 0 },
  { text: "A中😀", raw: 8, decoded: 8, omitted: 0 },
  { text: "A�", raw: 2, decoded: 4, omitted: 0 },
  { text: "�", raw: 2, decoded: 4, omitted: 1 },
  { text: "�", raw: 2, decoded: 6, omitted: 3 },
  { text: "a", raw: 4, decoded: 4, omitted: 3 }
]) {
  for (const stream of ["stdout", "stderr"] as const) {
    const retainedBytes = Buffer.byteLength(fixture.text, "utf8");
    const metadata = captureMetadata(fixture.decoded, retainedBytes);
    assert.equal(metadata.omittedBytes, fixture.omitted);
    assert.equal(metadata.truncated, fixture.omitted > 0);
    const record = {
      [stream]: fixture.text,
      [`${stream}Bytes`]: fixture.raw,
      [`${stream}RetainedBytes`]: retainedBytes,
      [`${stream}CaptureOmittedBytes`]: metadata.omittedBytes,
      [`${stream}Truncated`]: metadata.truncated
    };
    for (const saved of [record, JSON.parse(JSON.stringify(record))]) {
      const projected = commandStreamFields(stream, saved, shellOutputExcerpt(fixture.text));
      assert.equal(projected[`${stream}Bytes`], fixture.raw);
      assert.equal(projected[`${stream}CaptureOmittedBytes`], fixture.omitted);
      assert.equal(projected[`${stream}CaptureTruncated`], fixture.omitted > 0);
      assert.equal(projected[`${stream}Truncated`], fixture.omitted > 0);
      assert.equal(projected[`${stream}TruncationDirection`], fixture.omitted > 0 ? "tail" : undefined);
      assert.equal(projected[`${stream}ProjectionOmittedBytes`], 0);
    }
  }
}

const legacy = { stdout: "tail", stdoutBytes: 100, stdoutRetainedBytes: 4, stdoutTruncated: true };
const excerpt = shellOutputExcerpt("tail");
assert.equal(commandStreamFields("stdout", legacy, excerpt).stdoutCaptureOmittedBytes, 96);
assert.equal(commandStreamFields("stdout", { ...legacy, stdoutRetainedBytes: undefined }, excerpt).stdoutCaptureOmittedBytes, 96);
assert.equal(commandStreamFields("stdout", { ...legacy, stdoutTruncated: false }, excerpt).stdoutCaptureOmittedBytes, 0);
assert.equal(commandStreamFields("stdout", { ...legacy, stdoutCaptureOmittedBytes: 0 }, excerpt).stdoutCaptureOmittedBytes, 0,
  "an explicit zero must not fall back to raw input minus retained text");
assert.equal(commandStreamFields("stdout", { ...legacy, stdoutBytes: 2 }, excerpt).stdoutCaptureOmittedBytes, 0);

// Projection loss remains separate and may change the displayed direction.
const large = "x".repeat(20_000);
const projected = commandStreamFields("stderr", {
  stderr: large, stderrBytes: 20_001, stderrRetainedBytes: 20_000,
  stderrCaptureOmittedBytes: 3, stderrTruncated: true
}, shellOutputExcerpt(large));
assert.equal(projected.stderrCaptureOmittedBytes, 3);
assert.equal(projected.stderrCaptureTruncated, true);
assert.equal(projected.stderrProjectionTruncated, true);
assert.equal(projected.stderrTruncationDirection, "head_and_tail");
assert.ok(Number(projected.stderrProjectionOmittedBytes) > 0);

// Persistence redaction changes strings, but must preserve capture loss metadata.
const original = { ...legacy, stdout: "sk-" + "S".repeat(40), stdoutRetainedBytes: 43, stdoutCaptureOmittedBytes: 1 };
const persisted = JSON.parse(JSON.stringify(redactSensitiveValue(original)));
assert.notEqual(persisted.stdout, original.stdout);
assert.equal(persisted.stdoutCaptureOmittedBytes, 1);
assert.equal(commandStreamFields("stdout", persisted, shellOutputExcerpt(persisted.stdout)).stdoutCaptureOmittedBytes, 1);
assert.equal(original.stdout, "sk-" + "S".repeat(40));
console.log("shell capture metadata pure tests passed");
