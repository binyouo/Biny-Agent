import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";

const budget = 1024;
const marker = "\n[truncated]";

// Independent scalar-prefix oracle: fixtures contain valid Unicode, not lone surrogates.
function expectedContent(value: string, available: number): string {
  if (available <= 0) return "";
  if (Buffer.byteLength(value) <= available) return value;
  const suffix = available > Buffer.byteLength(marker) ? marker : "";
  const target = available - Buffer.byteLength(suffix);
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character) > target) break;
    prefix += character;
  }
  return prefix + suffix;
}

async function inspect(files: Record<string, string | Buffer>, input = "", initializeOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-instruction-unicode-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    // Explicit absent path prevents access to the user's actual global instructions.
    const workspace = new WorkspaceContext(root, [], budget, path.join(root, "global.md"));
    if (initializeOnly) {
      await workspace.initialize();
      return { instructions: [], status: workspace.status() };
    }
    const turn = await workspace.prepareTurn(input);
    const status = workspace.status();
    for (const instruction of turn.instructions) {
      assert.equal(instruction.bytes, Buffer.byteLength(instruction.content), "stored bytes must describe the returned content");
    }
    assert.equal(status.instructionBytes, turn.instructions.reduce((sum, item) => sum + item.bytes, 0));
    assert.ok(status.instructionBytes <= budget, `instruction payload exceeded ${budget}: ${status.instructionBytes}`);
    return { instructions: turn.instructions, status };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [label, character] of [["ASCII", "a"], ["two-byte", "é"], ["three-byte", "中"], ["four-byte", "😀"]] as const) {
  for (let residual = 0; residual <= 17; residual += 1) {
    test(`${label}: cumulative residual ${residual} preserves exact text and byte cap`, async () => {
      const global = "g".repeat(budget - residual);
      const value = character.repeat(40);
      const result = await inspect({ "global.md": global, "AGENTS.md": value });
      assert.deepEqual(result.instructions.map((item) => item.content), [global, expectedContent(value, residual)].filter(Boolean));
      assert.ok(result.instructions.every((item) => !item.content.includes("\ufffd")), "valid input must not acquire replacement characters");
    });
  }
}

for (const location of ["global.md", "AGENTS.md", "src/AGENTS.md"]) {
  for (const pairOffset of [-1, 0, 1]) {
    test(`${location}: pair position ${pairOffset} around suffix prefix endpoint`, async () => {
      // Target prefix is 1012 bytes; high surrogate alone would consume three bytes.
      const value = "a".repeat(budget - Buffer.byteLength(marker) - 3 + pairOffset) + "😀" + "z".repeat(40);
      const result = await inspect({ [location]: value }, "src/main.ts");
      assert.deepEqual(result.instructions.map((item) => item.content), [expectedContent(value, budget)]);
    });
  }
}

for (const value of ["", "ascii", "中😀", "x".repeat(budget), "中".repeat(340) + "😀", "\ufffd literal replacement"]) {
  test(`full-fit instructions remain unchanged (${value.length} units, ${Buffer.byteLength(value)} bytes)`, async () => {
    const result = await inspect({ "AGENTS.md": value });
    assert.deepEqual(result.instructions.map((item) => item.content), value ? [value] : []);
  });
}

test("unused pair bytes remain available to a later nested instruction", async () => {
  const global = "g".repeat(budget - 15);
  const root = "😀".repeat(20);
  const result = await inspect({ "global.md": global, "AGENTS.md": root, "src/AGENTS.md": "abc" }, "src/main.ts");
  assert.deepEqual(result.instructions.map((item) => item.content), [global, marker, "abc"]);
  assert.equal(result.status.instructionBytes, budget);
});

test("tiny residual that cannot fit a pair remains available to nested ASCII", async () => {
  const global = "g".repeat(budget - 1);
  const result = await inspect({ "global.md": global, "AGENTS.md": "😀😀", "src/AGENTS.md": "x" }, "src/main.ts");
  assert.deepEqual(result.instructions.map((item) => item.content), [global, "x"]);
  assert.equal(result.status.instructionBytes, budget);
});

test("root and nested instruction files share exact cumulative byte accounting", async () => {
  const root = "r".repeat(budget - 2);
  const result = await inspect({ "AGENTS.md": root, "src/AGENTS.md": "中中" }, "src/main.ts");
  assert.deepEqual(result.instructions.map((item) => item.content), [root]);
  assert.equal(result.status.instructionBytes, budget - 2);
});

test("initialization obeys the same cumulative instruction cap", async () => {
  const result = await inspect({ "global.md": "g".repeat(budget - 1), "AGENTS.md": "😀😀" }, "", true);
  assert.equal(result.status.instructionBytes, budget - 1);
});

test("existing malformed-file decoding is preserved rather than globally normalized", async () => {
  const result = await inspect({ "AGENTS.md": Buffer.from([0x61, 0xff, 0x62]) });
  assert.deepEqual(result.instructions.map((item) => item.content), ["a\ufffdb"]);
  assert.equal(result.status.instructionBytes, 5);
});
