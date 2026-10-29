import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const moduleUrl = new URL("../src/privacy/store.ts", import.meta.url).href;
const code = `import { RedactionStore } from ${JSON.stringify(moduleUrl)};
const store = new RedactionStore('stable-session');
if (process.argv[1]) console.log(store.restore(process.argv[1]));
else console.log(store.register('PASSWORD', 'synthetic-password-for-restart'));`;
const run = async (dir: string, tag?: string) => (await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, ...(tag ? [tag] : [])], {
  env: { ...process.env, BINY_AGENT_DIR: dir }, timeout: 10_000
})).stdout.trim();

test("independent and concurrent runtimes keep stable placeholders without persisting original values", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-privacy-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tags = await Promise.all(Array.from({ length: 4 }, () => run(dir)));
  assert.equal(new Set(tags).size, 1);
  assert.equal(await run(dir), tags[0]);
  assert.equal(await run(dir, tags[0]), tags[0], "a fresh runtime has no original-value mapping");
  assert.deepEqual(await readdir(dir), ["redact.key"]);
  assert.equal((await readFile(path.join(dir, "redact.key"))).length, 32);
  if (process.platform !== "win32") assert.equal((await stat(path.join(dir, "redact.key"))).mode & 0o777, 0o600);
  const other = await mkdtemp(path.join(os.tmpdir(), "biny-privacy-other-key-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  assert.notEqual(await run(other), tags[0]);
});

test("an invalid saved placeholder key fails without replacing it", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-privacy-invalid-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "redact.key"), "invalid fixture", { mode: 0o600 });
  await assert.rejects(run(dir), /Privacy placeholder key/u);
  assert.equal(await readFile(path.join(dir, "redact.key"), "utf8"), "invalid fixture");
});
