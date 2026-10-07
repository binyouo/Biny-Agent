import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { querySessionCatalog } from "../src/session/catalog.js";
import { ensureAgentDirs, listSessionFilePaths, listSessionFiles } from "../src/session/store.js";

async function fixture(run: (workspace: string, directory: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-list-metadata-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await ensureAgentDirs(workspace);
    await run(workspace, projectSessionsDir(await fs.realpath(workspace)));
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function history(id: string): string {
  return JSON.stringify({ type: "user_message", content: id, time: "2026-10-06T00:00:00Z" }) + "\n"
    + JSON.stringify({ type: "assistant_message", content: `answer ${id}`, time: "2026-10-06T00:01:00Z" }) + "\n";
}

test("catalog enumeration preserves flat and nested histories with bounded metadata work and no writes", { timeout: 15_000 }, async () => {
  await fixture(async (workspace, directory) => {
    const paths: string[] = [];
    const names = Array.from({ length: 24 }, (_, index) => `session-${String(index).padStart(2, "0")}.jsonl`);
    for (const [index, name] of names.entries()) {
      const file = path.join(directory, index % 4 === 0 ? "2026/10/06" : "", name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, history(name));
      paths.push(file);
    }
    await fs.mkdir(path.join(directory, ".catalog", ".locks"), { recursive: true });
    await fs.writeFile(path.join(directory, "index.json"), "not a session");
    await fs.writeFile(path.join(directory, ".catalog", "unrelated.json"), "not a session");
    const originalStat = fs.lstat;
    let active = 0;
    let maximum = 0;
    const sourcePaths = new Set(paths);
    fs.lstat = new Proxy(originalStat, { async apply(target, receiver, args: Parameters<typeof fs.lstat>) {
      if (!sourcePaths.has(String(args[0]))) return await Reflect.apply(target, receiver, args);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await nextTurn();
        return await Reflect.apply(target, receiver, args);
      } finally { active--; }
    } });
    try {
      assert.deepEqual(await listSessionFiles(workspace), names);
      assert.deepEqual(await listSessionFilePaths(workspace), paths);
      const page = await querySessionCatalog(workspace, { limit: 50 });
      assert.deepEqual(page.items.map(item => item.id), names.map(name => name.slice(0, -6)).reverse());
      for (const item of page.items) {
        assert.equal(item.summary.firstUserMessage, item.fileName);
        assert.equal(item.summary.lastAssistantMessage, `answer ${item.fileName}`);
        assert.equal(item.summary.eventCount, 2);
        assert.equal(item.hasChildren, false);
      }
      assert.equal(page.nextCursor, undefined);
      assert.ok(maximum > 0 && maximum <= 8, "one enumeration must not multiply its metadata worker bound when traversing nested directories");
      assert.equal(active, 0, "the returned query must not leave metadata reads running");
    } finally { fs.lstat = originalStat; }
    for (const file of paths) assert.equal(await fs.readFile(file, "utf8"), history(path.basename(file)));
  });
});

test("enumeration reports the first traversal error and drains started metadata reads before rejecting", { timeout: 15_000 }, async () => {
  await fixture(async (workspace, directory) => {
    const names = Array.from({ length: 24 }, (_, index) => `session-${String(index).padStart(2, "0")}.jsonl`);
    for (const name of names) await fs.writeFile(path.join(directory, name), history(name));
    const ordered = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.name.endsWith(".jsonl"));
    const firstFile = path.join(directory, ordered[0]!.name);
    const laterFile = path.join(directory, ordered[1]!.name);
    const firstError = Object.assign(new Error("first metadata failure"), { code: "EIO" });
    const laterError = Object.assign(new Error("later metadata failure"), { code: "EACCES" });
    const originalStat = fs.lstat;
    let active = 0;
    let started = 0;
    let waitingOthers = 0;
    const firstReady = gate();
    const firstRelease = gate();
    const othersRelease = gate();
    fs.lstat = new Proxy(originalStat, { async apply(target, receiver, args: Parameters<typeof fs.lstat>) {
      const file = String(args[0]);
      if (!file.endsWith(".jsonl")) return await Reflect.apply(target, receiver, args);
      active++;
      started++;
      try {
        if (file === firstFile) {
          firstReady.resolve();
          await firstRelease.promise;
          throw firstError;
        }
        if (file === laterFile) throw laterError;
        waitingOthers++;
        await othersRelease.promise;
        return await Reflect.apply(target, receiver, args);
      } finally { active--; }
    } });
    let settled = false;
    const result = listSessionFiles(workspace).then(
      () => { settled = true; return { error: undefined }; },
      (error: unknown) => { settled = true; return { error }; }
    );
    try {
      await firstReady.promise;
      firstRelease.resolve();
      // 让被控制的失败沿 Promise 链传播；其它文件仍由门闩保持未完成。
      await nextTurn();
      if (waitingOthers > 0) assert.equal(settled, false, "a failure must await in-flight metadata work");
      othersRelease.resolve();
      assert.equal((await result).error, firstError);
      assert.equal(active, 0, "failure must drain started metadata reads before returning");
      assert.ok(started <= 8, "a failed initial worker group must not admit another group");
    } finally {
      firstRelease.resolve();
      othersRelease.resolve();
      await result;
      fs.lstat = originalStat;
    }
    assert.deepEqual(await listSessionFiles(workspace), names, "a failed read must not poison the next enumeration");
  });
});

test("enumeration still rejects hardlinks and root replacement instead of publishing an unsafe partial list", { timeout: 15_000 }, async () => {
  await fixture(async (workspace, directory) => {
    const first = path.join(directory, "first.jsonl");
    await fs.writeFile(first, history("first"));
    await fs.link(first, path.join(workspace, "linked"));
    await assert.rejects(listSessionFiles(workspace), /single-link/u);
    await fs.unlink(path.join(workspace, "linked"));
    const moved = `${directory}.moved`;
    const originalStat = fs.lstat;
    let replaced = false;
    fs.lstat = new Proxy(originalStat, { async apply(target, receiver, args: Parameters<typeof fs.lstat>) {
      const value = await Reflect.apply(target, receiver, args);
      if (String(args[0]) === first && !replaced) {
        replaced = true;
        await fs.rename(directory, moved);
        await fs.mkdir(directory);
        await fs.writeFile(first, history("replacement"));
      }
      return value;
    } });
    try {
      await assert.rejects(listSessionFiles(workspace), /Project session storage changed/u);
      assert.equal(replaced, true);
    } finally { fs.lstat = originalStat; }
    assert.equal(await fs.readFile(path.join(moved, "first.jsonl"), "utf8"), history("first"));
    assert.equal(await fs.readFile(first, "utf8"), history("replacement"));
  });
});
