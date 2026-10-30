import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectProjectContext, formatProjectContext } from "../src/project/ProjectContext.js";

const config = { compilerOptions: { strict: true, jsx: "react-jsx" }, include: ["src"], exclude: ["dist"] };
for (const [name, source] of [
  ["plain BOM JSON", `\uFEFF${JSON.stringify(config)}`],
  ["BOM JSONC with comments and trailing commas", '\uFEFF{/*comment*/"compilerOptions":{"strict":true,"jsx":"react-jsx",},"include":["src",],"exclude":["dist"],}'],
  ["BOM followed by CRLF and line comment", '\uFEFF\r\n// options\r\n{"compilerOptions":{"strict":true,"jsx":"react-jsx"},"include":["src"],"exclude":["dist"]}'],
  ["ordinary JSON without BOM", JSON.stringify(config)]
]) {
  test(`project context accepts ${name}`, async () => {
    await fixture(source!, async root => {
      const context = await collectProjectContext(root, []);
      assert.deepEqual(context.tsconfig, config);
      assert.ok(formatProjectContext(context).includes(`tsconfig.json: ${JSON.stringify(config, null, 2)}`));
    });
  });
}
test("interior literal and escaped BOM inside strings remain data", async () => {
  const source = '\uFEFF{"compilerOptions":{"literal":"before\uFEFFafter","escaped":"before\\uFEFFafter"},"include":["src/\uFEFFfile"]}';
  await fixture(source, async root => {
    const context = await collectProjectContext(root, []);
    assert.deepEqual(context.tsconfig, { compilerOptions: { literal: "before\uFEFFafter", escaped: "before\uFEFFafter" }, include: ["src/\uFEFFfile"], exclude: undefined });
  });
});
for (const source of ['\uFEFF{broken', '\uFEFF', '\uFEFF[1,2]', '\uFEFFnull']) {
  test(`malformed or non-record BOM config degrades: ${JSON.stringify(source)}`, async () => {
    await fixture(source, async root => {
      const context = await collectProjectContext(root, []);
      assert.equal(context.tsconfig, undefined);
      assert.ok(formatProjectContext(context).includes("tsconfig.json: (missing)"));
    });
  });
}
test("ignored BOM config and cancellation remain unchanged", async () => {
  await fixture(`\uFEFF${JSON.stringify(config)}`, async root => {
    assert.equal((await collectProjectContext(root, ["tsconfig.json"])).tsconfig, undefined);
    const controller = new AbortController(); const reason = new Error("synthetic cancellation"); controller.abort(reason);
    await assert.rejects(collectProjectContext(root, [], controller.signal), error => error === reason);
  });
});
async function fixture(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tsconfig-bom-"));
  try {
    const file = path.join(root, "tsconfig.json");
    const bytes = Buffer.from(source, "utf8");
    await writeFile(file, bytes);
    await run(root);
    assert.deepEqual(await readFile(file), bytes, "summary reads must not rewrite the file");
  } finally { await rm(root, { recursive: true, force: true }); }
}
