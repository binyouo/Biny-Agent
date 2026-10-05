import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { WorkspaceContext, extractPathReferences } from "../src/agent/context/WorkspaceContext.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const exactPaths = ["src/App.tsx", "src/View.jsx", "package.json", "src/core.ts", "src/legacy.js"];
const unsupportedPaths = [
  "src/App.tsx.map", "src/core.tsbuildinfo", "data.jsonl", "src/legacy.js-backup",
  "src.ts/App.tsx.map", "foo.json/cache.jsonl", "src/App.tsx.-backup", "src/App.tsx..backup",
  String.raw`old.ts\cache.jsonl`
];

const summary = [
  "## Goal", "- Continue the work. <!-- evidence:m0 -->",
  "## Constraints & Preferences", "- (none recorded)",
  "## Progress", "### Done", "- (none verified)",
  "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
  "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
  "## All User Messages", "- (none recorded)", "## Next Steps", "- (none recorded)",
  "## Critical Context", "- (none recorded)"
].join("\n");

const model: AgentModel = {
  provider: "context-path-test", modelId: "context-path-test",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: summary };
    yield { type: "finish", reason: "stop" };
  })()
};

test("explicit paths preserve complete supported extensions and reject longer suffixes", () => {
  assert.deepEqual(extractPathReferences("`src/App.tsx`, (src/View.jsx); package.json. src/core.ts... src/legacy.js!"), exactPaths);
  assert.deepEqual(extractPathReferences(unsupportedPaths.join(" ")), []);
  // Preserve the existing leaf-only convention for backslash-separated input.
  assert.deepEqual(extractPathReferences(String.raw`C:\src\App.tsx C:\src\View.jsx C:\repo\package.json`), ["App.tsx", "View.jsx", "package.json"]);
});

test("prepareTurn injects the exact user-referenced filenames", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-context-paths-"));
  try {
    await mkdir(path.join(root, "src"));
    for (const filePath of exactPaths) await writeFile(path.join(root, filePath), "");
    const memory = new ContextMemory(() => model, new WorkspaceContext(root, [], 32_768, path.join(root, "missing-global.md")), undefined, 8_000, 32_768);
    const prepared = await memory.prepareTurn(exactPaths.join(" "), "system", undefined, [], false);
    const explicitPaths = prepared.systemPrompt?.match(/Explicit paths mentioned by the task:\n([\s\S]*?)(?=\n\n|$)/u)?.[1];
    assert.equal(explicitPaths, exactPaths.map((filePath) => `- ${filePath}`).join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction file claims keep exact tool paths without inventing suffix-truncated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-paths-"));
  try {
    const memory = new ContextMemory(() => model, new WorkspaceContext(root, [], 32_768, path.join(root, "missing-global.md")), undefined, 8_000, 32_768, undefined, undefined, { keepRecentTokens: 1 });
    const paths = [...exactPaths, "src/module.mjs", "src/module.cjs", ...unsupportedPaths];
    const messages: AgentMessage[] = [{ role: "user", content: "Update the requested files" }];
    for (const [index, filePath] of paths.entries()) {
      const toolName = index % 2 ? "Write" : "Read";
      const toolCallId = `file-${index}`;
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path: filePath } }] },
        { role: "toolResult", toolName, toolCallId, content: [{ type: "text", text: "ok" }] }
      );
    }
    messages.push({ role: "user", content: "Continue" });
    memory.replaceHistory(messages);
    const compacted = await memory.compact();
    assert.equal(compacted.compacted, true);
    const expectedClaims = paths.slice(0, exactPaths.length + 2).map((filePath, index) => `${index % 2 ? "Modified" : "Read"} file: ${filePath}`);
    assert.deepEqual(compacted.checkpoint?.state.criticalContext.toSorted(), expectedClaims.toSorted());
    const fileClaims = compacted.checkpoint?.evidence.filter((entry) => entry.field === "criticalContext") ?? [];
    assert.equal(fileClaims.length, expectedClaims.length);
    for (const claim of fileClaims) {
      const source = messages[claim.references[0]!.relativeMessageIndex!];
      assert.ok(source?.role === "assistant" && source.content[0]?.type === "toolCall");
      assert.ok(compacted.checkpoint!.state.criticalContext[claim.itemIndex]!.endsWith((source.content[0].arguments as { path: string }).path));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
