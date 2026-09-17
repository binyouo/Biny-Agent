import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";

let draftCounter = 0;
const run = promisify(execFile);

function fakeRuntime(sessionId: string, workspaceRoot: string, permissionMode: "ask" | "full-access" = "ask"): InteractiveRuntimeHandle & { setState(state: "idle" | "runs"): void } {
  let snapshot = createSnapshot(sessionId, workspaceRoot, permissionMode);
  const listeners = new Set<(update: { snapshot: InteractiveRuntimeSnapshot }) => void>();
  const setState = (state: "idle" | "runs"): void => {
    snapshot = {
      ...snapshot,
      state: state === "idle" ? { kind: "idle" } : {
        kind: "runs",
        activeRun: { runId: `run-${sessionId}`, status: "thinking" }
      }
    } as InteractiveRuntimeSnapshot;
    for (const listener of listeners) listener({ snapshot });
  };
  return {
    submitPrompt: () => { throw new Error("not used"); },
    steer: () => { throw new Error("not used"); },
    enqueue: () => { throw new Error("not used"); },
    continueInterruptedTurn: async () => undefined,
    startInterruptedTurn: async () => undefined,
    waitForIdle: async () => undefined,
    cancelCurrentRun: () => undefined,
    cancelRun: () => false,
    answerPermission: () => undefined,
    claimSession: async () => undefined,
    releaseSessionClaim: async () => undefined,
    resumeSession: async () => { throw new Error("not used"); },
    startDraft: async () => {
      const nextSessionId = `draft-${String(++draftCounter)}`;
      snapshot = {
        ...snapshot,
        revision: 0,
        info: {
          ...snapshot.info,
          sessionId: nextSessionId,
          sessionFile: `/tmp/${nextSessionId}.jsonl`
        }
      };
      for (const listener of listeners) listener({ snapshot });
      return snapshot.info;
    },
    runExclusiveOperation: async <T>(_operation: string, execute: (signal: AbortSignal) => Promise<T>) => await execute(new AbortController().signal),
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => snapshot,
    setState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined
  };
}

function createSnapshot(sessionId: string, workspaceRoot: string, permissionMode: "ask" | "full-access"): InteractiveRuntimeSnapshot {
  return {
    revision: 0,
    info: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      workspaceRoot,
      provider: "test",
      modelAlias: "test",
      modelLabel: "Test",
      reasoningLabel: "Off",
      thinking: "off",
      skills: []
    },
    permissionMode,
    state: { kind: "idle" }
  };
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-client-"));
await run("git", ["init", "--quiet", "-b", "main"], { cwd: workspaceRoot });
await run("git", ["config", "user.name", "Biny Tests"], { cwd: workspaceRoot });
await run("git", ["config", "user.email", "biny-tests@example.invalid"], { cwd: workspaceRoot });
await writeFile(path.join(workspaceRoot, "README.md"), "runtime host client test\n");
await run("git", ["add", "README.md"], { cwd: workspaceRoot });
await run("git", ["commit", "--quiet", "-m", "initial"], { cwd: workspaceRoot });
const commands = {} as CommandRuntime;
const primary = fakeRuntime("primary", workspaceRoot, "full-access");
const createdFactoryOptions: Array<{ isolation?: string; workspaceRoot?: string; resourceRegistry?: unknown }> = [];
const createdRuntimes = new Map<string, ReturnType<typeof fakeRuntime>>();
let hostResourceRegistry: unknown;
const host = await startRuntimeHost(workspaceRoot, async (resourceRegistry) => {
  hostResourceRegistry = resourceRegistry;
  return { runtime: primary, commands: commands };
}, {
  workspaceRoot,
  createRuntime: async (sessionId, options) => {
    createdFactoryOptions.push(options ?? {});
    const runtime = fakeRuntime(sessionId ?? `replacement-${String(++draftCounter)}`, options?.workspaceRoot ?? workspaceRoot);
    createdRuntimes.set(runtime.getSnapshot().info.sessionId, runtime);
    return {
      runtime,
      commands
    };
  }
});

try {
  const client = await connectRuntimeHost(workspaceRoot, { clientId: "client-test", surface: "tui" });
  assert.ok(client);
  let writeSessionId: string | undefined;
  const owners = (host as unknown as { sessionWriterOwners: Map<string, { clientId: string }> }).sessionWriterOwners;
  try {
    await assert.rejects(
      client.ensureSession({ sessionId: "primary", isolation: "worktree" }),
      /already configured for shared isolation/u,
      "已有 shared runtime 不能被显式参数静默改成 worktree"
    );
    const created = await client.ensureSession();
    assert.equal(client.runtimeSnapshots().length, 2, "session.ensure 后客户端必须保留主 session 和新 session 的快照");
    assert.ok(client.runtimeSnapshots().some((entry) => entry.sessionId === created.sessionId));

    const writeSession = await client.ensureSession({ writeIntent: true });
    writeSessionId = writeSession.sessionId;
    assert.equal(owners.get(writeSession.sessionId)?.clientId, client.clientId, "writeIntent 必须登记连接级 session owner");
    const writeRuntime = createdRuntimes.get(writeSession.sessionId);
    assert.ok(writeRuntime);
    writeRuntime.setState("runs");
    assert.equal(owners.get(writeSession.sessionId)?.clientId, client.clientId, "运行期间必须保留 writer owner");
    writeRuntime.setState("idle");
    assert.equal(owners.has(writeSession.sessionId), false, "Runtime 回到 idle 后必须释放 writer owner，允许 LRU 回收空闲会话");

    await client.focusSession(created.sessionId);
    primary.setState("runs");
    const draft = await client.startDraft();
    assert.equal(client.getFocusedSessionId(), draft.sessionId, "创建草稿后客户端必须聚焦新 session");
    assert.equal(client.getSnapshot().info.sessionId, draft.sessionId);
    assert.equal(createdFactoryOptions.at(-1)?.isolation, "shared", "并行会话默认共享目录");
    assert.equal(createdFactoryOptions.at(-1)?.resourceRegistry, hostResourceRegistry, "Draft Runtime 必须复用 Host 级资源注册表");
    assert.equal(draft.workspaceRoot, workspaceRoot);
    assert.equal(client.runtimeSnapshots().filter((entry) => entry.primary).length, 1);
    assert.equal(
      client.runtimeSnapshots().find((entry) => entry.primary)?.sessionId,
      "primary",
      "创建草稿不能把旧 primary session 从注册表中改名或移除"
    );
    assert.equal(
      client.runtimeSnapshots().some((entry) => entry.sessionId === draft.sessionId && !entry.primary),
      true,
      "新草稿必须是独立的非主 registry entry"
    );
    assert.equal(
      client.runtimeSnapshots().find((entry) => entry.sessionId === "primary")?.snapshot.state.kind,
      "runs",
      "创建草稿不能中断或替换正在运行的旧 session"
    );
    const isolated = await client.ensureSession({ isolation: "worktree" });
    assert.notEqual(isolated.snapshot.info.workspaceRoot, workspaceRoot);
    await assert.rejects(
      client.ensureSession({ sessionId: isolated.sessionId, isolation: "shared" }),
      /already configured for worktree isolation/u,
      "已有 worktree session 不能被显式参数切回 shared"
    );

    primary.setState("idle");
    await client.focusSession(created.sessionId);
    const restarted = await client.restartRuntime();
    assert.equal(restarted.info.sessionId, "primary", "普通 restart 只能刷新 runtime，不能更换 primary session");
    assert.equal(client.getFocusedSessionId(), restarted.info.sessionId, "重启完成后客户端必须聚焦返回的 session");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (writeSessionId !== undefined) {
      assert.equal(owners.has(writeSessionId), false, "client 断开后必须释放连接级 session owner");
    }
  }
} finally {
  await host.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

// resident 上限只保护内存缓存：旧会话完成后必须能被透明淘汰，不能把缓存槽变成用户会话上限。
const capacityWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-capacity-"));
await run("git", ["init", "--quiet", "-b", "main"], { cwd: capacityWorkspace });
const capacityPrimary = fakeRuntime("capacity-primary", capacityWorkspace);
const capacityRuntimes = new Map<string, ReturnType<typeof fakeRuntime>>();
const capacityHost = await startRuntimeHost(capacityWorkspace, async () => ({ runtime: capacityPrimary, commands }), {
  workspaceRoot: capacityWorkspace,
  maxSessionRuntimes: 2,
  createRuntime: async (sessionId) => {
    const runtime = fakeRuntime(sessionId ?? `capacity-${String(++draftCounter)}`, capacityWorkspace);
    capacityRuntimes.set(runtime.getSnapshot().info.sessionId, runtime);
    return { runtime, commands };
  }
});
try {
  const client = await connectRuntimeHost(capacityWorkspace, { clientId: "capacity-client", surface: "desktop" });
  assert.ok(client);
  try {
    const first = await client.ensureSession({ writeIntent: true, focus: false });
    const firstRuntime = capacityRuntimes.get(first.sessionId);
    assert.ok(firstRuntime);
    firstRuntime.setState("runs");
    firstRuntime.setState("idle");

    const second = await client.ensureSession({ writeIntent: true, focus: false });
    assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === first.sessionId), false);
    assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === second.sessionId), true);
  } finally {
    await client.close();
  }
} finally {
  await capacityHost.close();
  await rm(capacityWorkspace, { recursive: true, force: true });
}

console.log("runtime-host client tests passed");
