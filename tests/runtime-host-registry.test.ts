import assert from "node:assert/strict";
import {
  SessionRuntimeRegistry
} from "../src/runtime/host/registry.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

function fakeRuntime(sessionId: string, state: "idle" | "runs" = "idle"): InteractiveRuntimeHandle {
  const snapshot = {
    revision: 0,
    info: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      workspaceRoot: "/tmp/biny-registry-test",
      provider: "test",
      modelAlias: "test",
      modelLabel: "Test",
      reasoningLabel: "Off",
      thinking: "off",
      skills: []
    },
    permissionMode: "ask",
    state: state === "idle" ? { kind: "idle" } : {
      kind: "runs",
      activeRun: { runId: `run-${sessionId}`, status: "thinking" }
    }
  } as unknown as InteractiveRuntimeSnapshot;
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
    runExclusiveOperation: async () => { throw new Error("not used"); },
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined
  };
}

const commands = {} as CommandRuntime;

// 同一个 session 的并发 ensure 必须复用一份 factory promise。
{
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let created = 0;
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 3,
      createRuntime: async (sessionId) => {
        created += 1;
        await gate;
        return { runtime: fakeRuntime(sessionId ?? "missing"), commands };
      },
      onUpdate: () => undefined
    }
  );
  const first = registry.ensure("session-a");
  const second = registry.ensure("session-a");
  release();
  assert.strictEqual(await first, await second);
  assert.equal(created, 1);
}

// 不同 session 可以并发创建；全部缓存都被占用时仍应允许新会话。
{
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 2,
      createRuntime: async (sessionId) => {
        await gate;
        return { runtime: fakeRuntime(sessionId ?? "missing"), commands };
      },
      onUpdate: () => undefined
    }
  );
  const first = registry.ensure("session-a");
  const second = registry.ensure("session-b");
  release();
  await Promise.all([first, second]);
  assert.ok(registry.get("session-a"));
  assert.ok(registry.get("session-b"));
}

// 超限只回收 idle 的非主 runtime，并按最久未使用顺序回收；忙 runtime 和 primary 都不能动。
{
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 3,
      createRuntime: async (sessionId) => ({ runtime: fakeRuntime(sessionId ?? "missing"), commands }),
      onUpdate: () => undefined
    }
  );
  const first = await registry.ensure("session-a");
  const second = await registry.ensure("session-b");
  first.lastActiveAt = 1;
  second.lastActiveAt = 2;
  const next = await registry.ensure("session-c");
  assert.equal(next.sessionId, "session-c");
  assert.equal(registry.get("session-a"), undefined);
  assert.ok(registry.get("primary"));
  assert.ok(registry.get("session-b"));
}

{
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 2,
      createRuntime: async (sessionId) => ({ runtime: fakeRuntime(sessionId ?? "missing", sessionId === "session-a" ? "runs" : "idle"), commands }),
      onUpdate: () => undefined
    }
  );
  await registry.ensure("session-a");
  assert.equal((await registry.ensure("session-b")).sessionId, "session-b");
  assert.ok(registry.get("primary"), "容量不足时 primary 必须保留");
  assert.ok(registry.get("session-a"), "忙 runtime 不能被 LRU 回收");
  registry.get("session-a")!.runtime.getSnapshot().state = { kind: "idle" };
  await registry.ensure("session-c");
  assert.deepEqual(registry.list().map((entry) => entry.sessionId), ["primary", "session-c"], "超额会话空闲后，下次创建应回收至缓存目标");
}

// 被外部 surface claim 的 idle runtime 也不能被容量回收，否则另一个客户端仍持有的 session 会被静默关闭。
{
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 2,
      createRuntime: async (sessionId) => ({ runtime: fakeRuntime(sessionId ?? "missing"), commands }),
      canEvict: (entry) => entry.sessionId !== "session-a",
      onUpdate: () => undefined
    }
  );
  await registry.ensure("session-a");
  assert.equal((await registry.ensure("session-b")).sessionId, "session-b");
  assert.ok(registry.get("session-a"), "被 writer claim 的 session 不能被 LRU 回收");
}

// 回收多个空闲实例时，后面的候选可能在 await 期间重新运行，不能因此关闭它或拒绝新会话。
{
  const runtimes = new Map<string, InteractiveRuntimeHandle>();
  const registry = new SessionRuntimeRegistry(
    { runtime: fakeRuntime("primary"), commands },
    {
      sessionRuntimeCacheTarget: 3,
      createRuntime: async (sessionId) => {
        const runtime = fakeRuntime(sessionId!);
        runtimes.set(sessionId!, runtime);
        return { runtime, commands };
      },
      onUpdate: () => undefined
    }
  );
  const first = await registry.ensure("session-a");
  const second = await registry.ensure("session-b");
  first.lastActiveAt = 1;
  second.lastActiveAt = 2;
  runtimes.get("session-a")!.close = async () => {
    runtimes.get("session-b")!.getSnapshot().state = fakeRuntime("session-b", "runs").getSnapshot().state;
  };
  assert.deepEqual(await registry.evictIdle(2), ["session-a"]);
  assert.equal(registry.get("session-b")?.runtime.getSnapshot().state.kind, "runs");
}

console.log("runtime-host registry tests passed");
