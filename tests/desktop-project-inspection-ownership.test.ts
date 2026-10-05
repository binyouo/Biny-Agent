import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultConfig } from "../src/config/schema.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import type { DesktopProject } from "../src/desktop/protocol.js";

const execFileAsync = promisify(execFile);
const originalAgentDir = process.env.BINY_AGENT_DIR;
const cases: Array<[string, () => Promise<void>]> = [];

type Fixture = {
  root: string;
  workspace: string;
  project: DesktopProject;
  state: DesktopStateStore;
  projects: DesktopProjectService;
  agents: DesktopAgentManager;
  assertPersisted(): Promise<void>;
};

async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-project-inspection-"));
  const workspace = path.join(root, "workspace");
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let agents: DesktopAgentManager | undefined;
  try {
    await mkdir(workspace);
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=audit-main"], { cwd: workspace });
    const stateFile = path.join(root, "desktop-state.json");
    const state = new DesktopStateStore(stateFile);
    await state.load();
    const storage = new DesktopUserDataStore(path.join(root, "desktop"));
    const configStore = { load: async () => structuredClone(defaultConfig), save: async () => undefined };
    const projects = new DesktopProjectService(state, storage, configStore);
    const project = await projects.createProject(workspace);
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    await run({ root, workspace, project, state, projects, agents, async assertPersisted() {
      const raw = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(raw.version, 2);
      assert.deepEqual(raw.projects, JSON.parse(JSON.stringify(state.projects())));
      assert.equal(raw.activeProjectId, state.activeProjectId());
      const restored = new DesktopStateStore(stateFile);
      await restored.load();
      assert.deepEqual(restored.projects(), JSON.parse(JSON.stringify(state.projects())));
    } });
  } finally {
    await agents?.closeAll();
    await rm(root, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = originalAgentDir;
  }
}

function pauseNextInspection(projects: DesktopProjectService) {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inspect = projects.inspectProject.bind(projects);
  let next = true;
  projects.inspectProject = async (project, refreshGit) => {
    const paused = next;
    next = false;
    const result = await inspect(project, refreshGit);
    if (paused) { entered(); await gate; }
    return result;
  };
  return { ready, release };
}

async function startRefresh(value: Fixture, owner: "snapshot" | "stored" | "all") {
  const barrier = pauseNextInspection(value.projects);
  const operation = owner === "snapshot"
    ? value.agents.workspaceSnapshot(value.project.id).then((snapshot) => snapshot.project)
    : owner === "stored"
      ? value.projects.refreshStoredProject(value.project.id)
      : value.projects.refreshAllProjects().then((projects) => projects.find((project) => project.id === value.project.id));
  // Immediately observe a possible rejection; removal can legitimately retire the pending caller.
  const settled = operation.then((project) => ({ project }), (error: unknown) => ({ error }));
  await barrier.ready;
  return { ...barrier, settled };
}

for (const owner of ["snapshot", "stored", "all"] as const) {
  for (const edit of ["rename", "pin"] as const) {
    cases.push([`${owner} preserves completed ${edit}`, () => fixture(async (value) => {
      const pending = await startRefresh(value, owner);
      try {
        if (edit === "rename") await value.agents.renameProject(value.project.id, "User renamed project");
        else await value.agents.setProjectPinned(value.project.id, true);
      } finally { pending.release(); }
      const result = await pending.settled;
      assert.ok("project" in result && result.project);
      const latest = value.state.project(value.project.id)!;
      assert.equal(latest.name, edit === "rename" ? "User renamed project" : value.project.name);
      assert.equal(latest.pinned, edit === "pin");
      assert.equal(result.project.name, latest.name);
      assert.equal(result.project.pinned, latest.pinned);
      await value.assertPersisted();
    })]);
  }
  cases.push([`${owner} cannot resurrect removed projects`, () => fixture(async (value) => {
    const pending = await startRefresh(value, owner);
    try {
      await value.agents.disposeProject(value.project.id);
      await value.state.removeProject(value.project.id);
    } finally { pending.release(); }
    const result = await pending.settled;
    assert.equal(value.state.project(value.project.id), undefined);
    if (owner === "all") assert.ok("project" in result && result.project === undefined);
    else assert.ok("error" in result && result.error instanceof Error && /Unknown project/.test(result.error.message));
    await value.assertPersisted();
  })]);
  cases.push([`${owner} cannot overwrite an explicit re-add`, () => fixture(async (value) => {
    const pending = await startRefresh(value, owner);
    let reopened!: DesktopProject;
    try {
      await value.state.removeProject(value.project.id);
      await writeFile(path.join(value.workspace, "new.txt"), "new incarnation\n");
      reopened = await value.projects.createProject(value.workspace);
      await value.state.setProjectName(reopened.id, "Re-added project");
      await value.state.setProjectPinned(reopened.id, true);
    } finally { pending.release(); }
    const result = await pending.settled;
    assert.ok("project" in result && result.project);
    assert.deepEqual(value.state.project(reopened.id), { ...reopened, name: "Re-added project", pinned: true });
    assert.equal(result.project.dirty, true);
    assert.equal(result.project.name, "Re-added project");
    await value.assertPersisted();
  })]);
}

cases.push(["user-only mutations retain valid Git updates", () => fixture(async (value) => {
  await writeFile(path.join(value.workspace, "new.txt"), "dirty\n");
  const pending = await startRefresh(value, "stored");
  try {
    await value.state.setProjectName(value.project.id, "Latest name");
    await value.state.setProjectPinned(value.project.id, true);
  } finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project);
  assert.equal(result.project.dirty, true);
  assert.equal(result.project.branch, "audit-main");
  assert.equal(result.project.name, "Latest name");
  assert.equal(result.project.pinned, true);
  await value.assertPersisted();
})]);

cases.push(["newer snapshot owns Git metadata over older bulk refresh", () => fixture(async (value) => {
  const pending = await startRefresh(value, "all");
  try {
    await writeFile(path.join(value.workspace, "new.txt"), "newer Git metadata\n");
    const newer = await value.agents.workspaceSnapshot(value.project.id);
    assert.equal(newer.project.dirty, true);
  } finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project);
  assert.equal(result.project.dirty, true);
  assert.equal(value.state.project(value.project.id)?.dirty, true);
  await value.assertPersisted();
})]);

cases.push(["non-Git selection does not retire a valid Git inspection", () => fixture(async (value) => {
  await writeFile(path.join(value.workspace, "new.txt"), "dirty\n");
  const pending = await startRefresh(value, "stored");
  try { await value.agents.workspaceSnapshot(value.project.id, false); }
  finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project);
  assert.equal(result.project.dirty, true);
  assert.equal(result.project.branch, "audit-main");
  await value.assertPersisted();
})]);

cases.push(["bulk refresh retains current order, additions, and selection", () => fixture(async (value) => {
  await value.state.setActiveProject(value.project.id);
  const barrier = pauseNextInspection(value.projects);
  const pending = value.projects.refreshAllProjects();
  await barrier.ready;
  let added!: DesktopProject;
  try {
    const second = path.join(value.root, "second");
    await mkdir(second);
    added = await value.projects.createProject(second);
    await value.state.reorderProjects([added.id, value.project.id]);
    await value.state.setActiveProject(added.id);
  } finally { barrier.release(); }
  const returned = await pending;
  assert.equal(value.state.activeProjectId(), added.id);
  assert.deepEqual(value.state.projects().map((project) => project.id), [added.id, value.project.id]);
  assert.deepEqual(returned.map((project) => project.id), [added.id, value.project.id]);
  await value.assertPersisted();
})]);

cases.push(["newer rejected inspections surface and do not permanently block refresh", () => fixture(async (value) => {
  await writeFile(path.join(value.workspace, "new.txt"), "dirty\n");
  const pending = await startRefresh(value, "stored");
  const inspect = value.projects.inspectProject.bind(value.projects);
  value.projects.inspectProject = async () => { throw new Error("inspection unavailable"); };
  try {
    await assert.rejects(value.projects.refreshStoredProject(value.project.id), /inspection unavailable/);
    await value.state.setProjectName(value.project.id, "Latest name after rejection");
  } finally { pending.release(); }
  await pending.settled;
  assert.equal(value.state.project(value.project.id)?.name, "Latest name after rejection");
  assert.equal(value.state.project(value.project.id)?.dirty, false);
  value.projects.inspectProject = inspect;
  const latest = await value.projects.refreshStoredProject(value.project.id);
  assert.equal(latest.name, "Latest name after rejection");
  assert.equal(latest.dirty, true);
  await value.assertPersisted();
})]);

cases.push(["same-value replacement still retires the older incarnation", () => fixture(async (value) => {
  await writeFile(path.join(value.workspace, "new.txt"), "dirty\n");
  const pending = await startRefresh(value, "stored");
  try {
    await value.state.removeProject(value.project.id);
    // Deliberately reuse every persisted identity field, including the timestamps.
    await value.state.upsertProject({ ...value.project });
  } finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project);
  assert.equal(result.project.dirty, false);
  assert.deepEqual(value.state.project(value.project.id), value.project);
  await value.assertPersisted();
})]);

cases.push(["newer missing inspection clears Git metadata and prevents stale revival", () => fixture(async (value) => {
  const pending = await startRefresh(value, "stored");
  try {
    await rm(value.workspace, { recursive: true, force: true });
    // Existence-only selection still discovers removal without a Git subprocess.
    await value.agents.workspaceSnapshot(value.project.id, false);
  } finally { pending.release(); }
  await pending.settled;
  assert.equal(value.state.project(value.project.id)?.missing, true);
  assert.equal(value.state.project(value.project.id)?.branch, undefined);
  assert.equal(value.state.project(value.project.id)?.dirty, false);
  await value.assertPersisted();
})]);

cases.push(["older inspection rejection cannot disturb a newer successful refresh", () => fixture(async (value) => {
  const inspect = value.projects.inspectProject.bind(value.projects);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  value.projects.inspectProject = async (project, refreshGit) => {
    if (!first) return await inspect(project, refreshGit);
    first = false;
    await inspect(project, refreshGit);
    entered();
    await gate;
    throw new Error("older inspection unavailable");
  };
  const old = value.projects.refreshStoredProject(value.project.id);
  const rejected = assert.rejects(old, /older inspection unavailable/);
  await ready;
  try {
    await writeFile(path.join(value.workspace, "new.txt"), "dirty\n");
    const newer = await value.agents.workspaceSnapshot(value.project.id);
    assert.equal(newer.project.dirty, true);
    await value.state.setProjectName(value.project.id, "Latest name");
  } finally { release(); }
  await rejected;
  assert.equal(value.state.project(value.project.id)?.dirty, true);
  assert.equal(value.state.project(value.project.id)?.name, "Latest name");
  await value.assertPersisted();
})]);

cases.push(["older missing inspection cannot clear newer present metadata", () => fixture(async (value) => {
  await rm(value.workspace, { recursive: true, force: true });
  const pending = await startRefresh(value, "stored");
  try {
    await mkdir(value.workspace);
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=restored-main"], { cwd: value.workspace });
    await value.agents.workspaceSnapshot(value.project.id, false);
  } finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project);
  assert.equal(result.project.missing, false);
  assert.equal(result.project.branch, "audit-main", "existence-only selection preserves the previously known Git metadata");
  const refreshed = await value.projects.refreshStoredProject(value.project.id);
  assert.equal(refreshed.branch, "restored-main");
  assert.equal(refreshed.missing, false);
  await value.assertPersisted();
})]);

cases.push(["bulk refresh cannot restore a removed active selection", () => fixture(async (value) => {
  await value.state.setActiveProject(value.project.id);
  const pending = await startRefresh(value, "all");
  try { await value.state.removeProject(value.project.id); }
  finally { pending.release(); }
  const result = await pending.settled;
  assert.ok("project" in result && result.project === undefined);
  assert.equal(value.state.activeProjectId(), undefined);
  assert.deepEqual(value.state.projects(), []);
  await value.assertPersisted();
})]);

for (const owner of ["snapshot", "stored", "all"] as const) {
  cases.push([`${owner} retires pre-gap Git metadata after a missing-to-present cycle`, () => fixture(async (value) => {
    await writeFile(path.join(value.workspace, "old-dirty.txt"), "old Git metadata\n");
    const pending = await startRefresh(value, owner);
    try {
      await rm(value.workspace, { recursive: true, force: true });
      const missing = await value.agents.workspaceSnapshot(value.project.id, false);
      assert.equal(missing.project.missing, true);
      assert.equal(missing.project.branch, undefined);
      assert.equal(missing.project.dirty, false);
      await mkdir(value.workspace);
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=after-gap"], { cwd: value.workspace });
      const present = await value.agents.workspaceSnapshot(value.project.id, false);
      assert.equal(present.project.missing, false);
      assert.equal(present.project.branch, undefined);
      assert.equal(present.project.dirty, false);
    } finally { pending.release(); }
    const result = await pending.settled;
    assert.ok("project" in result && result.project);
    assert.equal(result.project.missing, false);
    assert.equal(result.project.branch, undefined, "obsolete Git metadata cannot be revived after an owned missing observation");
    assert.equal(result.project.dirty, false);
    assert.equal(value.state.project(value.project.id)?.branch, undefined);
    assert.equal(value.state.project(value.project.id)?.dirty, false);
    await value.assertPersisted();
    const current = await value.projects.refreshStoredProject(value.project.id);
    assert.equal(current.branch, "after-gap", "retirement does not block later valid Git inspections");
    assert.equal(current.dirty, false);
    await value.assertPersisted();
  })]);
}

const failures: string[] = [];
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}`, error); }
}
assert.deepEqual(failures, [], `Failed ${String(failures.length)} of ${String(cases.length)} project-inspection cases`);
