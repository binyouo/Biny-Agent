import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CheckpointStore, type Checkpoint } from "../src/session/checkpointStore.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { globalConfigDir } from "../src/config/paths.js";

const run = promisify(execFile);
type Fixture = { root: string; directory: string; git: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string> };
async function fixture(operation: (input: Fixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-portable-"));
  const root = path.join(directory, "repo");
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "external-state");
  const git = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> => (await run("git", args, { cwd: root, env })).stdout;
  try {
    await fs.mkdir(root);
    await git(["init", "-q"]);
    await git(["config", "user.name", "Checkpoint test"]);
    await git(["config", "user.email", "checkpoint@example.invalid"]);
    await fs.writeFile(path.join(root, "source.txt"), "original source\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "initial"]);
    await operation({ root, directory, git });
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function message(root: string, content: string): Promise<string> {
  const recorder = new SessionRecorder(root, "portable-state-history");
  try { await recorder.recordAndFlush({ type: "user_message", content }); return recorder.filePath; }
  finally { await recorder.close(); }
}
async function legacyCheckpoint(root: string, git: Fixture["git"], store: CheckpointStore): Promise<Checkpoint> {
  const index = path.join(root, ".git", "legacy-checkpoint-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await fs.copyFile(path.join(root, ".git", "index"), index);
    await git(["--literal-pathspecs", "add", "-A", "--", "."], env);
    const tree = (await git(["write-tree"], env)).trim();
    const commit = (await git(["commit-tree", tree, "-m", "legacy state capture"], env)).trim();
    const checkpoint = { id: commit.slice(0, 12), commit, label: "legacy", createdAt: new Date().toISOString() };
    await git(["update-ref", `refs/biny/checkpoints/${checkpoint.id}`, commit]);
    await fs.writeFile(path.join(agentDir(root), "checkpoints.json"), JSON.stringify({ version: 1, checkpoints: [...await store.list(), checkpoint] }));
    return checkpoint;
  } finally { await fs.rm(index, { force: true }); }
}
async function verifyStatePreserved(input: Fixture, legacy = false): Promise<void> {
  const { root, git } = input;
  await ensureAgentDirs(root);
  const log = await message(root, "first user message");
  const config = path.join(globalConfigDir(), "config.json");
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, "before configuration\n");
  // Even accidentally tracked state must be removed from the snapshot index,
  // without modifying the user's real staging index.
  await git(["--literal-pathspecs", "add", "-A", "--", "."]);
  const gitIndex = await fs.readFile(path.join(root, ".git", "index"));
  const store = await CheckpointStore.open(root);
  assert.ok(store);
  await store.create("first");
  const checkpoint = legacy ? await legacyCheckpoint(root, git, store) : await store.create("second");
  await message(root, "later user message must survive undo");
  await fs.writeFile(config, "current configuration\n");
  const indexPath = path.join(agentDir(root), "checkpoints.json");
  const [expectedLog, expectedIndex] = await Promise.all([fs.readFile(log), fs.readFile(indexPath)]);
  await fs.writeFile(path.join(root, "source.txt"), "changed source\n");
  await store.restore(checkpoint.id);
  assert.deepEqual(await fs.readFile(log), expectedLog, "Undo must not rewind the session transcript");
  assert.deepEqual(await fs.readFile(indexPath), expectedIndex, "Undo must not rewrite its own checkpoint index");
  assert.equal(await fs.readFile(config, "utf8"), "current configuration\n");
  assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "original source\n");
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), gitIndex);
  if (!legacy) {
    const files = (await git(["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean);
    assert.deepEqual(files, ["source.txt"], "State paths must not be captured at all");
  }
}

for (const stateName of ["portable-state", "nested/state", "[state]"]) {
  test(`checkpoint protects custom in-workspace state at ${stateName}`, async () => fixture(async input => {
    process.env.BINY_AGENT_DIR = path.join(input.root, stateName);
    await verifyStatePreserved(input);
  }));
}
test("restore filters state out of existing legacy snapshots too", async () => fixture(async input => {
  process.env.BINY_AGENT_DIR = path.join(input.root, "portable-state");
  await verifyStatePreserved(input, true);
}));

test("an outside state root does not exclude an ordinary same-named project directory", async () => fixture(async ({ root, directory, git }) => {
  process.env.BINY_AGENT_DIR = path.join(directory, "portable-state");
  await fs.mkdir(path.join(root, "portable-state"));
  const ordinary = path.join(root, "portable-state", "user.txt");
  await fs.writeFile(ordinary, "original user file");
  const store = await CheckpointStore.open(root); assert.ok(store);
  const checkpoint = await store.create("outside state");
  await fs.writeFile(ordinary, "edited");
  await store.restore(checkpoint.id);
  assert.equal(await fs.readFile(ordinary, "utf8"), "original user file");
  assert.ok((await git(["ls-tree", "-r", "--name-only", checkpoint.commit])).includes("portable-state/user.txt"));
}));
test("state exclusion does not swallow a sibling with the same path prefix", async () => fixture(async ({ root }) => {
  process.env.BINY_AGENT_DIR = path.join(root, "portable-state");
  await fs.mkdir(path.join(root, "portable-state-notes"));
  const ordinary = path.join(root, "portable-state-notes", "user.txt");
  await fs.writeFile(ordinary, "original user file");
  const store = await CheckpointStore.open(root); assert.ok(store);
  const checkpoint = await store.create("prefix boundary");
  await fs.writeFile(ordinary, "edited");
  await store.restore(checkpoint.id);
  assert.equal(await fs.readFile(ordinary, "utf8"), "original user file");
}));

for (const alias of ["outside-to-inside", "inside-to-outside", "inside-parent-to-outside"]) {
  test(`configured state aliases remain protected: ${alias}`, { skip: process.platform === "win32" }, async () => fixture(async input => {
    const { root, directory } = input;
    if (alias === "outside-to-inside") {
      const target = path.join(root, "real-state"); await fs.mkdir(target);
      const link = path.join(directory, "state-link"); await fs.symlink(target, link);
      process.env.BINY_AGENT_DIR = link;
      await verifyStatePreserved(input);
    } else {
      const target = path.join(directory, "real-state"); await fs.mkdir(target);
      const link = path.join(root, "state-link"); await fs.symlink(target, link);
      process.env.BINY_AGENT_DIR = alias === "inside-parent-to-outside" ? path.join(link, "nested-state") : link;
      await verifyStatePreserved(input);
      assert.equal(await fs.readlink(link), target);
    }
  }));
}

for (const relation of ["same", "ancestor"]) {
  test(`checkpoint rejects a ${relation} global-state root rather than snapshotting itself`, async () => fixture(async ({ root, directory }) => {
    process.env.BINY_AGENT_DIR = relation === "same" ? root : directory;
    const store = await CheckpointStore.open(root); assert.ok(store);
    const before = await fs.readFile(path.join(root, "source.txt"));
    await assert.rejects(store.create("overlap"), /own global state\/configuration root/);
    assert.deepEqual(await fs.readFile(path.join(root, "source.txt")), before);
  }));
}

test("a first snapshot cannot move aside the state created while publishing that snapshot", async () => fixture(async ({ root, git }) => {
  process.env.BINY_AGENT_DIR = path.join(root, "not-yet-created", "state");
  const store = await CheckpointStore.open(root); assert.ok(store);
  const checkpoint = await store.create("first portable checkpoint");
  const indexPath = path.join(agentDir(root), "checkpoints.json");
  const index = await fs.readFile(indexPath);
  await fs.writeFile(path.join(root, "source.txt"), "edited");
  const result = await store.restore(checkpoint.id);
  assert.deepEqual(await fs.readFile(indexPath), index);
  assert.deepEqual(result.movedAside, []);
  assert.equal((await store.list()).at(-1)?.id, checkpoint.id);
  assert.deepEqual((await git(["ls-tree", "-r", "-z", "--name-only", checkpoint.commit])).split("\0").filter(Boolean), ["source.txt"]);
}));

test("canonical workspace identity protects a state path configured through a workspace alias", { skip: process.platform === "win32" }, async () => fixture(async input => {
  const alias = path.join(input.directory, "workspace-alias");
  await fs.symlink(input.root, alias);
  process.env.BINY_AGENT_DIR = path.join(alias, "portable-state");
  await verifyStatePreserved({ ...input, root: alias });
}));

test("undo does not retarget a configured state symlink after a state-directory migration", { skip: process.platform === "win32" }, async () => fixture(async ({ root, directory }) => {
  const oldState = path.join(directory, "old-state"); const newState = path.join(directory, "new-state");
  await fs.mkdir(oldState);
  const link = path.join(root, "state-link"); await fs.symlink(oldState, link);
  process.env.BINY_AGENT_DIR = link;
  await ensureAgentDirs(root); await message(root, "old state message");
  const store = await CheckpointStore.open(root); assert.ok(store);
  const checkpoint = await store.create("before relocation");
  await fs.cp(oldState, newState, { recursive: true });
  await fs.unlink(link); await fs.symlink(newState, link);
  const log = await message(root, "message after relocation");
  const expected = await fs.readFile(log);
  await fs.writeFile(path.join(root, "source.txt"), "edited");
  await store.restore(checkpoint.id);
  assert.equal(await fs.readlink(link), newState, "Undo must not retarget the active state root");
  assert.deepEqual(await fs.readFile(log), expected);
  assert.equal((await store.list()).at(-1)?.id, checkpoint.id);
}));

test("default global configuration is protected separately from the default runtime root", async context => fixture(async input => {
  const previousHome = process.env.HOME; const previousProfile = process.env.USERPROFILE;
  const previousState = process.env.BINY_AGENT_DIR;
  process.env.HOME = input.root; process.env.USERPROFILE = input.root; delete process.env.BINY_AGENT_DIR;
  try {
    if (path.resolve(os.homedir()) !== input.root) { context.skip("platform does not support isolated home injection"); return; }
    assert.equal(globalConfigDir(), path.join(input.root, ".config", "biny"));
    await verifyStatePreserved(input);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    if (previousState === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousState;
  }
}));

test("an external state root containing only the workspace alias does not disable real-workspace snapshots", { skip: process.platform === "win32" }, async () => fixture(async ({ root, directory }) => {
  const external = path.join(directory, "external-state"); await fs.mkdir(external);
  const alias = path.join(external, "workspace-alias"); await fs.symlink(root, alias);
  process.env.BINY_AGENT_DIR = external;
  const store = await CheckpointStore.open(alias); assert.ok(store);
  const checkpoint = await store.create("external alias parent");
  await fs.writeFile(path.join(root, "source.txt"), "edited");
  await store.restore(checkpoint.id);
  assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "original source\n");
}));

for (const relation of ["same", "ancestor"]) {
  test(`restore refuses a ${relation} state root before moving or overwriting anything`, async () => fixture(async ({ root, directory }) => {
    const store = await CheckpointStore.open(root); assert.ok(store);
    const checkpoint = await store.create("before root relocation");
    const storedIndex = await fs.readFile(path.join(agentDir(root), "checkpoints.json"));
    process.env.BINY_AGENT_DIR = relation === "same" ? root : directory;
    await ensureAgentDirs(root);
    const indexPath = path.join(agentDir(root), "checkpoints.json");
    await fs.writeFile(indexPath, storedIndex);
    await fs.writeFile(path.join(root, "source.txt"), "current source\n");
    await fs.writeFile(path.join(root, "new-user-file.txt"), "new user work\n");
    assert.equal((await store.list()).at(-1)?.id, checkpoint.id);
    await assert.rejects(store.restore(checkpoint.id), /own global state\/configuration root/);
    assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "current source\n");
    assert.equal(await fs.readFile(path.join(root, "new-user-file.txt"), "utf8"), "new user work\n");
    assert.deepEqual(await fs.readFile(indexPath), storedIndex);
    await assert.rejects(fs.lstat(path.join(root, ".biny", "undo-trash")), { code: "ENOENT" });
  }));
}
