import assert from "node:assert/strict";
import { test } from "node:test";
import { codeModePolicy, executeCodeModeCell } from "../src/agent/codeMode.js";
import type { AgentTool } from "../src/agent/core/types.js";

// Real QuickJS console capture, with in-memory archives and no filesystem,
// network, provider or shell tools. Only the identity check uses an inert tool.
const archivePath = `.biny/tool-results/tool-result-${"a".repeat(64)}.json`;
const archiveError = "Stdout archiving failed: Error: synthetic archive failure. Do not replay this cell.";
const captureMarker = "\n[Console capture limit reached; additional output is not retained.]";
const wellFormed = (value: string): boolean => !/[\ud800-\udfff]/u.test(value);
const previewMarker = (fails: boolean, captured = false): string => fails
  ? "\n[Output truncated; archive unavailable]"
  : `\n[Output truncated. Read ${captured ? "captured" : "full"} stdout at ${archivePath}]`;

const boundaryCases = [
  { name: "pair immediately before the cut", text: "a".repeat(15_998) + "😀tail", preview: "a".repeat(15_998) + "😀" },
  { name: "pair straddling the cut", text: "a".repeat(15_999) + "😀tail", preview: "a".repeat(15_999) },
  { name: "pair immediately after the cut", text: "a".repeat(16_000) + "😀tail", preview: "a".repeat(16_000) },
  { name: "ASCII just above the limit", text: "a".repeat(16_000), preview: "a".repeat(16_000) },
  { name: "CJK", text: "中".repeat(16_004), preview: "中".repeat(16_000) }
];

for (const archiveFails of [false, true]) {
  for (const fixture of boundaryCases) {
    await test(`stdout preview: ${fixture.name}, archive failure=${archiveFails}`, async () => {
      const archives: string[] = [];
      const result = await executeCodeModeCell({
        parentToolCallId: "unicode-preview", tools: [], isCurrent: () => false,
        code: `console.log(${JSON.stringify(fixture.text)}); return 42;`,
        archiveStdout: async (stdout) => {
          archives.push(stdout);
          if (archiveFails) throw new Error("synthetic archive failure");
          return archivePath;
        }
      });
      assert.equal(result.ok, !archiveFails, result.error);
      assert.equal(result.error, archiveFails ? archiveError : undefined);
      assert.equal(result.value, 42);
      assert.deepEqual(result.childCalls, []);
      assert.deepEqual(archives, [fixture.text + "\n"], "archive receives the complete capture exactly once");
      assert.deepEqual(Buffer.from(archives[0]!, "utf8"), Buffer.from(fixture.text + "\n", "utf8"));
      assert.ok(wellFormed(result.stdout!), "preview must not split an otherwise valid surrogate pair");
      assert.equal(result.stdout, fixture.preview + previewMarker(archiveFails));
      assert.ok(fixture.preview.length <= 16_000);
      assert.equal(Buffer.from(result.stdout!, "utf8").toString("utf8"), result.stdout);
    });
  }
}

for (const [name, text] of [
  ["short mixed text", "short 😀中"],
  ["exact ASCII limit", "a".repeat(15_999)],
  ["exact CJK limit", "中".repeat(15_999)],
  ["exact limit with a pair", "a".repeat(15_997) + "😀"]
] as const) {
  await test(`stdout stays complete below or at 16000 UTF-16 units: ${name}`, async () => {
    let archiveCalls = 0;
    const result = await executeCodeModeCell({
      parentToolCallId: "complete-output", tools: [], isCurrent: () => false,
      code: `console.log(${JSON.stringify(text)}); return 42;`,
      archiveStdout: async () => { archiveCalls++; throw new Error("must not archive"); }
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, text + "\n");
    assert.deepEqual(result.childCalls, []);
    assert.equal(archiveCalls, 0);
  });
}

await test("stdout without an archive callback remains complete above the preview limit", async () => {
  const text = "a".repeat(15_999) + "😀tail";
  const result = await executeCodeModeCell({
    parentToolCallId: "no-archive", tools: [], isCurrent: () => false,
    code: `console.log(${JSON.stringify(text)}); return 42;`
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stdout, text + "\n");
  assert.deepEqual(result.childCalls, []);
});

for (const surrogate of ["\ud800", "\udfff"]) {
  await test(`stdout retains the runtime's existing lone-surrogate behavior (${surrogate.charCodeAt(0)})`, async () => {
    const text = "a".repeat(15_999) + surrogate + "tail";
    // The pinned runtime already replaces lone surrogates during console capture.
    const captured = "a".repeat(15_999) + "\ufffdtail\n";
    const archives: string[] = [];
    const result = await executeCodeModeCell({
      parentToolCallId: "lone-surrogate", tools: [], isCurrent: () => false,
      code: `console.log(${JSON.stringify(text)}); return 42;`,
      archiveStdout: async (stdout) => { archives.push(stdout); return archivePath; }
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(archives, [captured]);
    assert.equal(result.stdout, captured.slice(0, 16_000) + previewMarker(false));
    assert.deepEqual(result.childCalls, []);
  });
}

for (const archiveFails of [false, true]) {
  await test(`stdout capture limit retains its markers, archive failure=${archiveFails}`, async () => {
    const archives: string[] = [];
    const result = await executeCodeModeCell({
      parentToolCallId: "capture-limit", tools: [], isCurrent: () => false,
      code: 'console.log("a".repeat(15999) + "😀tail"); console.log("z".repeat(100)); return 42;',
      executionPolicy: { ...codeModePolicy, maxConsoleOutputBytes: 16_010 },
      archiveStdout: async (stdout) => {
        archives.push(stdout);
        if (archiveFails) throw new Error("synthetic archive failure");
        return archivePath;
      }
    });
    assert.equal(result.ok, !archiveFails, result.error);
    assert.equal(result.value, 42, "console capture exhaustion must not stop the cell");
    assert.equal(result.error, archiveFails ? archiveError : undefined);
    assert.deepEqual(archives, ["a".repeat(15_999) + "😀tail\nzz" + captureMarker]);
    assert.equal(result.stdout, "a".repeat(15_999) + previewMarker(archiveFails, true));
    assert.deepEqual(result.childCalls, []);
  });

  await test(`stdout archiving preserves completed child IDs without replay, archive failure=${archiveFails}`, async () => {
    const calls: string[] = [];
    const inert: AgentTool = {
      name: "Read", description: "In-memory identity fixture", parameters: { type: "object" },
      async execute(id) { calls.push(id); return { content: [], details: calls.length }; }
    };
    const archives: string[] = [];
    const result = await executeCodeModeCell({
      parentToolCallId: "child-identity", tools: [inert], isCurrent: (name, entry) => name === "Read" && entry === inert,
      code: 'await tools.Read({}); console.log("a".repeat(15999) + "😀tail"); return await tools.Read({});',
      archiveStdout: async (stdout) => {
        archives.push(stdout);
        if (archiveFails) throw new Error("synthetic archive failure");
        return archivePath;
      }
    });
    assert.equal(result.ok, !archiveFails, result.error);
    assert.equal(result.value, 2);
    assert.equal(result.error, archiveFails ? archiveError : undefined);
    assert.deepEqual(calls, ["child-identity:nested:1", "child-identity:nested:2"]);
    assert.deepEqual(result.childCalls, calls.map(toolCallId => ({ tool: "Read", toolCallId })));
    assert.deepEqual(archives, ["a".repeat(15_999) + "😀tail\n"]);
    assert.equal(result.stdout, "a".repeat(15_999) + previewMarker(archiveFails));
  });
}
