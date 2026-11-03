import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { SoulStorage } from "../src/agent/context/soulStorage.js";
import { runSoulCommand } from "../src/agent/context/soulCommands.js";

const parser = unified().use(remarkParse);
const date = new Date("2026-10-30T12:00:00Z");
const newEntry = "- [2026-10-30] New actual trait";
const examples = Array.from({ length: 15 }, (_, index) => `- Example ${index + 1}`).join("\n");
const suffix = "\n\n## Preferences\n\nKeep this section unchanged.";

async function fixture(content: string, run: (storage: SoulStorage, original: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-soul-ownership-"));
  try {
    const storage = new SoulStorage({ configDir: root, now: () => date });
    await storage.set(content);
    await run(storage, await readFile(storage.path, "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function rootTraitLines(content: string): string[] {
  const lines = content.split("\n");
  const result: string[] = [];
  let inside = false;
  for (const block of parser.parse(content).children) {
    if (block.type === "heading" && block.depth <= 2) {
      const line = lines[block.position!.start.line - 1];
      if (inside) break;
      inside = line?.trim().toLowerCase() === "## evolved traits";
    } else if (inside && block.type === "list" && !block.ordered) {
      for (const item of block.children) result.push(lines[item.position!.start.line - 1]!);
    }
  }
  return result;
}

for (const fence of ["```", "~~~~"] as const) {
  test(`${fence} examples above the real section are neither pruned nor selected`, async () => {
    const core = `# Soul\n\nCore stays here.\n\n${fence}markdown\n## Evolved Traits\n${examples}\n${fence}\n\n`;
    await fixture(`${core}## Evolved Traits\n\n- Existing actual trait${suffix}`, async (storage) => {
      assert.match(await runSoulCommand(storage, ["append-trait", "New actual trait"]), /Soul trait appended/u);
      const result = await readFile(storage.path, "utf8");
      assert.ok(result.startsWith(core));
      assert.ok(result.endsWith(`${suffix}\n`));
      assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
    });
  });
}

test("fenced bullets, fake duplicate and legacy marker inside the real section remain literal", async () => {
  const code = `\`\`\`markdown\n${examples}\n- New actual trait\n<!-- biny-soul-growth:2026-10-01 -->\n\`\`\``;
  await fixture(`# Soul\n\n## Evolved Traits\n\n${code}\n\n- Existing actual trait${suffix}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.includes(code));
    assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
  });
});

for (const example of [
  "> ## Evolved Traits\n> - Example",
  "- Container\n\n  ## Evolved Traits\n\n  - Example",
  "<!--\n## Evolved Traits\n- Example\n-->",
  "    ## Evolved Traits\n    - Example"
]) {
  test(`a non-root heading is not an owned section: ${example.split("\n")[0]}`, async () => {
    const core = `# Soul\n\n${example}\n\n`;
    await fixture(`${core}## Evolved Traits\n\n- Existing actual trait${suffix}`, async (storage) => {
      const result = (await storage.appendTrait("New actual trait")).content;
      assert.ok(result.startsWith(core));
      assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
    });
  });
}

test("headings inside a code block do not prematurely end the real section", async () => {
  const code = "```markdown\n## Example only\n- Example\n```";
  await fixture(`# Soul\n\n## Evolved Traits\n\n${code}\n\n- Existing actual trait${suffix}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.includes(code));
    assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
    assert.ok(result.endsWith(suffix));
  });
});

test("pruning removes the oldest actual multi-line item, not nested or quoted bullets", async () => {
  const quoted = "> - Quoted example\n> - Another example";
  const old = "- Old actual trait\n  Its continuation belongs to the same item.\n  - Nested explanation";
  const keep = Array.from({ length: 14 }, (_, index) => `- Actual ${index + 1}`);
  await fixture(`# Soul\n\n## Evolved Traits\n\n${quoted}\n\n${old}\n${keep.join("\n")}${suffix}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.includes(quoted));
    assert.ok(!result.includes("Old actual trait"));
    assert.ok(!result.includes("Its continuation"));
    assert.ok(!result.includes("Nested explanation"));
    assert.deepEqual(rootTraitLines(result), [...keep, newEntry]);
  });
});

test("ordinary root entries retain the fifteen-trait limit, legacy cleanup and duplicate idempotency", async () => {
  const core = "# Soul\n\nCore stays here.\n\n";
  const entries = Array.from({ length: 15 }, (_, index) => `- Trait ${index + 1}`);
  await fixture(`${core}## Evolved Traits\n\n<!-- biny-soul-growth:2026-10-01 -->\n${entries.join("\n")}${suffix}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.startsWith(core));
    assert.ok(result.endsWith(suffix));
    assert.ok(!result.includes("biny-soul-growth"));
    assert.deepEqual(rootTraitLines(result), [...entries.slice(1), newEntry]);
    const bytes = await readFile(storage.path, "utf8");
    await storage.appendTrait("New actual trait");
    assert.equal(await readFile(storage.path, "utf8"), bytes);
  });
});

for (const tail of ["```markdown\n- Example", "~~~\n- Example", "<!--\n- Example", "<script>\nExample"]) {
  for (const hasSection of [false, true]) {
    test(`unclosed Markdown preserves file and releases lock (${hasSection ? "existing" : "missing"} section, ${tail.split("\n")[0]})`, async () => {
      const head = `# Soul\n\n${hasSection ? "## Evolved Traits\n\n- Existing actual trait\n\n" : ""}`;
      await fixture(head + tail, async (storage, original) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await assert.rejects(storage.appendTrait("New actual trait"), /Cannot append a Soul trait/u);
          assert.equal(await readFile(storage.path, "utf8"), original);
          await assert.rejects(access(path.join(storage.directory, ".soul.lock")), { code: "ENOENT" });
        }
        await storage.set("# Soul\n\n## Evolved Traits\n\n- Existing actual trait");
        assert.deepEqual(rootTraitLines((await storage.appendTrait("New actual trait")).content), ["- Existing actual trait", newEntry]);
      });
    });
  }
}

test("a later unrelated unclosed block does not prevent updating an earlier complete section", async () => {
  const tail = "\n\n## Other\n\n```markdown\nUnfinished example";
  await fixture(`# Soul\n\n## Evolved Traits\n\n- Existing actual trait${tail}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
    assert.ok(result.endsWith(tail));
  });
});

test("a list-contained unclosed fence ends with its container before the real heading", async () => {
  const core = "# Soul\n\n- Example\n  ```markdown\n  Code\n\n";
  await fixture(`${core}## Evolved Traits\n\n- Existing actual trait`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.startsWith(core));
    assert.deepEqual(rootTraitLines(result), ["- Existing actual trait", newEntry]);
  });
});

test("closed HTML blocks can precede a visible new root entry", async () => {
  const html = "<div>Keep this example.</div>";
  await fixture(`# Soul\n\n## Evolved Traits\n\n${html}`, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.includes(html));
    assert.deepEqual(rootTraitLines(result), [newEntry]);
  });
});

test("a missing genuine section is created after, not inside, a closed code example", async () => {
  const core = "# Soul\n\n```markdown\n## Evolved Traits\n- Example\n```";
  await fixture(core, async (storage) => {
    const result = (await storage.appendTrait("New actual trait")).content;
    assert.ok(result.startsWith(core));
    assert.deepEqual(rootTraitLines(result), [newEntry]);
  });
});
