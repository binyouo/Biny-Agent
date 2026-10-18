import assert from "node:assert/strict";
import filesystem, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectSessionsDir } from "../src/config/paths.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { agentDir, ensureAgentDirs, listSessionFilePaths, sessionFilePath } from "../src/session/store.js";

async function checkSessionStorage(workspace: string, globalRoot: string, canonicalWorkspace: string): Promise<void> {
  await ensureAgentDirs(workspace);
  const canonicalGlobal = await fs.realpath(globalRoot);
  assert.equal(path.dirname(agentDir(workspace)), path.join(canonicalGlobal, "workspaces"));
  assert.equal(path.dirname(projectSessionsDir(canonicalWorkspace)), path.join(canonicalGlobal, "sessions"));
  const recorder = new SessionRecorder(workspace);
  try { await recorder.recordAndFlush({ type: "user_message", content: "persist through the canonical path" }); }
  finally { await recorder.close(); }
  assert.equal(sessionFilePath(workspace, recorder.sessionId), sessionFilePath(canonicalWorkspace, recorder.sessionId));
  assert.deepEqual(await listSessionFilePaths(workspace), [recorder.filePath]);
  const reopened = new SessionRecorder(canonicalWorkspace, recorder.sessionId);
  try { await reopened.recordAndFlush({ type: "assistant_message", content: "reopened the same session" }); }
  finally { await reopened.close(); }
  assert.deepEqual((await readSessionEvents(recorder.filePath)).map((event) => event.type), ["user_message", "assistant_message"]);
}

for (const aliasKind of ["global", "workspace"] as const) {
  test(`session storage keeps one canonical partition when legacy realpath preserves the ${aliasKind} alias`, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-session-canonical-")));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const globalRoot = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    const oldAgentDir = process.env.BINY_AGENT_DIR;
    await fs.mkdir(globalRoot);
    await fs.mkdir(workspace);
    await fs.symlink(aliasKind === "global" ? globalRoot : workspace, alias, "junction");
    const realpath = filesystem.realpathSync;
    const mock = context.mock.method(filesystem, "realpathSync", (...args: Parameters<typeof filesystem.realpathSync>) => {
      if (args[0] === alias) return alias;
      return realpath(...args);
    });
    syncBuiltinESMExports();
    process.env.BINY_AGENT_DIR = aliasKind === "global" ? alias : globalRoot;
    try {
      await checkSessionStorage(aliasKind === "workspace" ? alias : workspace, globalRoot, workspace);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = oldAgentDir;
    }
  });
}

test("native Windows case aliases use the same runtime partition and session file", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-windows-session-")));
  const globalRoot = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const oldAgentDir = process.env.BINY_AGENT_DIR;
  try {
    await fs.mkdir(globalRoot);
    await fs.mkdir(workspace);
    process.env.BINY_AGENT_DIR = globalRoot.toUpperCase();
    await checkSessionStorage(workspace.toUpperCase(), globalRoot, workspace);
    assert.deepEqual(await fs.readdir(path.join(globalRoot, "workspaces")), await fs.readdir(path.join(globalRoot, "sessions")));
  } finally {
    if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = oldAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const redirected of ["workspaces", "sessions", "runs"] as const) {
  test(`canonical session storage still rejects a redirected ${redirected} directory`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "biny-session-boundary-")));
    const globalRoot = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    const oldAgentDir = process.env.BINY_AGENT_DIR;
    try {
      await fs.mkdir(workspace);
      await fs.mkdir(outside);
      process.env.BINY_AGENT_DIR = globalRoot;
      await ensureAgentDirs(workspace);
      const target = redirected === "runs" ? path.join(agentDir(workspace), "runs") : path.join(globalRoot, redirected);
      await fs.rm(target, { recursive: true });
      await fs.symlink(outside, target, "junction");
      await assert.rejects(ensureAgentDirs(workspace), /must be a real directory/u);
      assert.deepEqual(await fs.readdir(outside), []);
    } finally {
      if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = oldAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
