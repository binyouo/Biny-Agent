/** Public reference-search options must recognize only declared kind aliases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const entry = path.resolve("src/cli/index.ts");
const loader = import.meta.resolve("tsx");

interface CliResult { code: number | null; stdout: string; stderr: string }
interface ReferenceResult { kind: string; label: string }

async function withFixture(run: (root: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-reference-kind-options-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try { await run(root, workspace); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function invoke(root: string, workspace: string, args: string[], preload?: string): CliResult {
  const child = spawnSync(process.execPath, ["--import", loader, ...(preload === undefined ? [] : ["--import", preload]), entry, "ref", "search", ...args], {
    cwd: workspace,
    env: { ...process.env, HOME: path.join(root, "home"), BINY_AGENT_DIR: path.join(root, "agent"), NODE_NO_WARNINGS: "1" },
    encoding: "utf8", timeout: 15_000
  });
  assert.equal(child.error, undefined);
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

test("reference search rejects inherited object names in plain and JSON mode without creating state", async () => {
  await withFixture(async (root, workspace) => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "toLocaleString",
      "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__lookupGetter__", "missing-kind", "File", "FILE", ""]) {
      for (const output of [[], ["--json"]]) {
        const result = invoke(root, workspace, ["fixture", "--kind", kind, ...output]);
        assert.equal(result.code, 1, `unsupported kind ${JSON.stringify(kind)} must fail`);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.trim(), "Unknown reference kind.");
        assert.deepEqual((await readdir(root)).sort(), ["workspace"], "invalid kind must be rejected before storage opens");
      }
    }
  });
});

test("reference search never evaluates inherited alias accessors", async () => {
  await withFixture(async (root, workspace) => {
    const preload = path.join(root, "inherited-alias.mjs");
    await writeFile(preload, [
      'Object.defineProperty(Object.prototype, "prototype-fixture-kind", {',
      '  configurable: true, get() { throw new Error("Inherited alias accessor was invoked."); }',
      '});',
      ""
    ].join("\n"));
    for (const output of [[], ["--json"]]) {
      const result = invoke(root, workspace, ["fixture", "--kind", "prototype-fixture-kind", ...output], preload);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "Unknown reference kind.");
      assert.deepEqual((await readdir(root)).sort(), ["inherited-alias.mjs", "workspace"]);
    }
  });
});

test("reference search retains English and Chinese aliases, explicit empty queries, and result limits", async () => {
  await withFixture(async (root, workspace) => {
    await Promise.all(Array.from({ length: 34 }, (_, index) =>
      writeFile(path.join(workspace, `cli-option-file-${String(index).padStart(2, "0")}.txt`), "Inert reference fixture.\n")));
    for (const kind of ["file", "文件"]) {
      for (const [query, limit, expectedCount] of [["cli-option-file", "1", 1], ["", "2", 2], ["cli-option-file", "50", 34]] as const) {
        const result = invoke(root, workspace, [query, "--kind", kind, "--limit", limit, "--json"]);
        assert.equal(result.code, 0, result.stderr);
        const references = JSON.parse(result.stdout) as ReferenceResult[];
        assert.equal(references.length, expectedCount);
        assert.equal(references.every((reference) => reference.kind === "file" && reference.label.startsWith("cli-option-file-")), true);
      }
    }
    const unfiltered = invoke(root, workspace, ["cli-option-file", "--json"]);
    assert.equal(unfiltered.code, 0, unfiltered.stderr);
    assert.equal((JSON.parse(unfiltered.stdout) as ReferenceResult[]).length, 30, "omitted kind and limit retain default search behavior");
    const plain = invoke(root, workspace, ["cli-option-file", "--kind", "文件", "--limit", "1"]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /^cli-option-file-\d{2}\.txt\tbiny:\/\/file\/cli-option-file-\d{2}\.txt\n$/u);
  });
});

test("reference search retains invalid result-limit rejection", async () => {
  await withFixture(async (root, workspace) => {
    for (const limit of ["0", "-1", "1.5", "NaN", "", "51"]) {
      const result = invoke(root, workspace, ["fixture", "--kind", "file", "--limit", limit, "--json"]);
      assert.equal(result.code, 1, `invalid limit ${JSON.stringify(limit)} must fail`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, limit === "51" ? /Invalid reference search\./u : /Expected a positive integer/u);
      assert.doesNotMatch(result.stderr, /\n\s+at /u);
      assert.deepEqual((await readdir(root)).sort(), ["workspace"]);
    }
  });
});
