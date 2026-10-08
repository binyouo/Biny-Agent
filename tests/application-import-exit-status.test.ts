import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Existing import tests check result bodies; scripts also need a failing exit status for partial failures.
await test("registered import CLI fails partial imports without hiding history or duplicating successful items", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-import-exit-")));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    const script = path.join(root, "cli.mts");
    await writeFile(script, `import { Command } from ${JSON.stringify(path.resolve("node_modules/commander/esm.mjs"))};
import { registerApplicationImportCommands } from ${JSON.stringify(path.resolve("src/cli/commands/applicationImports.ts"))};
const program = new Command(); registerApplicationImportCommands(program, process.cwd()); await program.parseAsync(process.argv);`);
    let agentRoot = path.join(root, "agent");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), script, ...args], {
        cwd: workspace, env: { ...process.env, HOME: root, BINY_AGENT_DIR: agentRoot }, encoding: "utf8", timeout: 15_000
      });
      assert.equal(result.error, undefined);
      return result;
    };
    const file = path.join(root, "conversations.json");
    const valid = { id: "good", title: "Good", current_node: "u", mapping: {
      u: { parent: null, message: { author: { role: "user" }, content: { content_type: "text", parts: ["Keep this imported text"] } } }
    } };
    const invalid = { id: "bad", title: "Bad", current_node: "absent", mapping: valid.mapping };
    const source = JSON.stringify([valid, invalid]);
    await writeFile(file, source);
    const previewResult = run("imports", "preview", "chatgpt", "--file", file, "--json");
    assert.equal(previewResult.status, 0, previewResult.stderr);
    const preview = JSON.parse(previewResult.stdout) as { id: string; items: { id: string }[] };
    assert.equal(preview.items.length, 2);
    const args = ["imports", "run", preview.id, "--item", ...preview.items.map(item => item.id), "--json"];
    const imported = run(...args);
    const history = JSON.parse(imported.stdout) as { results: { status: string; sessionId?: string }[] };
    assert.deepEqual(history.results.map(item => item.status), ["imported", "failed"]);
    assert.equal(imported.status, 1, "a partial import must not signal success to shell scripts");
    const retried = run(...args);
    assert.equal(retried.status, 1);
    const retryHistory = JSON.parse(retried.stdout) as typeof history;
    assert.deepEqual(retryHistory.results.map(item => item.status), ["skipped", "failed"]);
    assert.equal(retryHistory.results[0]?.sessionId, history.results[0]?.sessionId);
    const status = run("imports", "--json");
    assert.equal(status.status, 0, "viewing a previous failure is not another failed operation");
    assert.equal((JSON.parse(status.stdout) as { history: unknown[] }).history.length, 2);
    assert.equal(await readFile(file, "utf8"), source);
    const successfulRetry = run("imports", "run", preview.id, "--item", preview.items[0]!.id, "--json");
    assert.equal(successfulRetry.status, 0, "deduplicated imports remain successful");
    assert.equal(run("imports", "enable-sync", "--json").status, 0);
    await rm(file);
    const sync = run("imports", "sync", "--json");
    assert.ok((JSON.parse(sync.stdout) as { sync: { lastError?: string } }).sync.lastError);
    assert.equal(sync.status, 1, "unavailable selected sources must fail the sync command");
    assert.equal(run("imports", "--json").status, 0);
    assert.equal(run("imports", "disable-sync", "--json").status, 0);
    assert.equal(run("imports", "sync", "--json").status, 0, "disabled sync does not fail because of an old error");
    assert.equal(run("imports", "enable-sync", "--json").status, 0);
    await writeFile(file, source);
    assert.equal(run("imports", "sync", "--json").status, 0, "recovered unchanged selected content is a successful sync");
    agentRoot = path.join(root, "failed-storage-agent");
    const storagePreview = JSON.parse(run("imports", "preview", "chatgpt", "--file", file, "--json").stdout) as typeof preview;
    await writeFile(path.join(agentRoot, "workspaces"), "blocked destination");
    const uncertainArgs = ["imports", "run", storagePreview.id, "--item", storagePreview.items[0]!.id, "--json"];
    const uncertain = run(...uncertainArgs);
    assert.equal(uncertain.status, 1, "an unknown write outcome must not signal successful import");
    assert.equal((JSON.parse(uncertain.stdout) as typeof history).results[0]?.status, "unknown");
    await rm(path.join(agentRoot, "workspaces"));
    const refusedReplay = run(...uncertainArgs);
    assert.equal(refusedReplay.status, 1);
    assert.equal((JSON.parse(refusedReplay.stdout) as typeof history).results[0]?.status, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
