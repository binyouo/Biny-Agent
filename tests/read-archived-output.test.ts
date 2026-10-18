import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createSubagentTools } from "../src/extensions/subagent.js";
import { archiveToolResult } from "../src/session/toolResultArchive.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createToolRegistry } from "../src/tools/registry.js";

async function fixture(run: (root: string, reference: string, output: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-read-archive-"));
  try {
    const output = "😀证据\r\n" + "x".repeat(220_000);
    const archived = await archiveToolResult({ workspaceRoot: root, sessionId: path.basename(root), toolCallId: "result", sequence: 1, tool: "Bash", result: output });
    await run(root, archived.archivePath, output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("Read retrieves long single-line archived output without hashline edit anchors", async () => {
  await fixture(async (root, reference, output) => {
    const reader = createReadFileTool({ workspaceRoot: root, ignore: defaultConfig.workspace.ignore }, true);
    let offset = 0;
    let restored = "";
    do {
      const page = await reader.resolveExecution({ path: reference, offset, length: 200_000 }).execute({});
      assert.ok("nextOffset" in page);
      assert.equal(page.path, reference);
      assert.equal(page.offset, offset);
      assert.ok(page.content.isWellFormed());
      restored += page.content;
      offset = page.nextOffset;
      if (!page.hasMore) break;
    } while (offset < output.length);
    assert.equal(restored, output);
    for (const input of [reference, `./${reference}`, reference.replaceAll("/", "\\"), ` ${reference} `]) {
      const first = await reader.resolveExecution({ path: input, length: 2 }).execute({});
      assert.equal(first.content, "😀");
    }
  });
});

await test("Read keeps file line paging and validates the archive paging protocol", async () => {
  await fixture(async (root, reference) => {
    await writeFile(path.join(root, "source.txt"), "first\nsecond\nthird");
    const reader = createReadFileTool({ workspaceRoot: root, ignore: defaultConfig.workspace.ignore });
    assert.deepEqual(await reader.resolveExecution({ path: "source.txt", startLine: 2, lineCount: 1 }).execute({}), {
      path: "source.txt", content: "second", startLine: 2, endLine: 2, hasMore: true, nextStartLine: 3
    });
    assert.throws(() => reader.resolveExecution({ path: reference, startLine: 1 }), /offset and length/u);
    assert.throws(() => reader.resolveExecution({ path: "source.txt", offset: 0 }), /startLine and lineCount/u);
    assert.throws(() => reader.schema.parse({ path: reference, offset: -1 }));
    assert.throws(() => reader.schema.parse({ path: reference, length: 200_001 }));
    for (const input of [".biny/config.json", reference.replace("tool-results/", "tool-results/../"), reference + "/extra"]) {
      assert.throws(() => reader.resolveExecution({ path: input }));
    }
  });
});

await test("the registered tool catalog has one Read entry and no independent archive reader", async () => {
  await fixture(async (root) => {
    const registry = createToolRegistry({ workspaceRoot: root, ignore: defaultConfig.workspace.ignore });
    assert.equal(registry.list().filter((tool) => tool.name === "Read").length, 1);
    assert.equal(registry.list().some((tool) => tool.name === "read_tool_result"), false);
  });
});

await test("subagent Read cannot use the parent archive route, including normalized paths", async () => {
  await fixture(async (root, reference) => {
    const context = { workspaceRoot: root, ignore: [] };
    const registry = createToolRegistry(context);
    for (const accessMode of ["read-only", "workspace"] as const) {
      for (const input of [reference, `./${reference}`, reference.replaceAll("/", "\\"), ` ${reference} `]) {
        const tools = createSubagentTools(registry, ["Read"], { accessMode, editing: { mode: "hashline", context } });
        const reader = tools.find((tool) => tool.name === "Read");
        assert.ok(reader);
        const denied = await reader.execute("parent-archive", { path: input });
        assert.equal(denied.isError, true);
        assert.match(JSON.stringify(denied.content), /protected path/u);
        assert.equal(denied.details, undefined);
      }
    }
  });
});
