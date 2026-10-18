import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("Windows Git checkout preserves reviewed dependency patches and provenance bytes", { timeout: 20_000 }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-patch-checkout-"));
  const git = promisify(execFile);
  try {
    for (const file of [".gitattributes", "patches", "THIRD_PARTY_NOTICES.txt"]) {
      await cp(path.join(root, file), path.join(temporary, file), { recursive: true });
    }
    const entries = await readdir(path.join(root, "patches"), { recursive: true, withFileTypes: true });
    const files = ["THIRD_PARTY_NOTICES.txt", ...entries.filter(entry => entry.isFile())
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))];
    const expected = new Map(await Promise.all(files.map(async file => [file,
      createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")] as const)));
    const run = (args: string[]) => git("git", ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args], {
      cwd: temporary, timeout: 10_000
    });
    await run(["init", "--quiet"]);
    await run(["add", "--", ".gitattributes", "patches", "THIRD_PARTY_NOTICES.txt"]);
    await Promise.all(files.map(file => rm(path.join(temporary, file))));
    await run(["checkout-index", "--force", "--all"]);
    for (const [file, hash] of expected) {
      assert.equal(createHash("sha256").update(await readFile(path.join(temporary, file))).digest("hex"), hash,
        `Git checkout changed reviewed bytes: ${file}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
