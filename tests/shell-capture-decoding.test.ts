import assert from "node:assert/strict";
import { runShellCommand } from "../src/tools/shell/runCommand.js";
import { projectSingleToolResultForModel } from "../src/agent/toolResultProjection.js";
import { serializeToolResult } from "../src/session/toolResultArchive.js";

// Real process wiring regression. The standard runner supplies an isolated data directory.
for (const invalidByte of [0xff, 0xe2]) {
  for (const limit of [3, 4]) {
    const script = `process.stdout.write(Buffer.from([65,${invalidByte}]));process.stderr.write(Buffer.from([65,${invalidByte}]));`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const captured = await runShellCommand(process.cwd(), command, {
      captureFullOutput: true, maxCapturedOutputBytes: limit
    });
    assert.equal(captured.status, "completed");
    for (const stream of ["stdout", "stderr"] as const) {
      assert.equal(captured[stream], limit === 3 ? "�" : "A�");
      assert.equal(captured[`${stream}Bytes`], 2);
      assert.equal(captured[`${stream}RetainedBytes`], limit);
      assert.equal(captured[`${stream}CaptureOmittedBytes`], limit === 3 ? 1 : 0);
      assert.equal(captured[`${stream}Truncated`], limit === 3);
      assert.equal(captured[`${stream}TruncationDirection`], limit === 3 ? "tail" : undefined);
    }
    for (const value of [captured, JSON.parse(serializeToolResult(captured))]) {
      const projected = await projectSingleToolResultForModel("Bash", { command }, value) as Record<string, unknown>;
      for (const stream of ["stdout", "stderr"] as const) {
        assert.equal(projected[`${stream}CaptureOmittedBytes`], limit === 3 ? 1 : 0);
        assert.equal(projected[`${stream}CaptureTruncated`], limit === 3);
        assert.equal(projected[`${stream}ProjectionTruncated`], false);
        assert.equal(projected[`${stream}TruncationDirection`], limit === 3 ? "tail" : undefined);
      }
      if (limit === 3) assert.match(String(projected.summary), /cannot recover bytes lost before projection/u);
      else assert.equal(projected.summary, undefined);
      assert.strictEqual(await projectSingleToolResultForModel("Bash", { command }, projected), projected);
    }
  }
}
console.log("shell capture decoding integration tests passed");
