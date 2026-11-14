import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { AgentSession } from "../src/agent/AgentSession.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";

// Real Runtime and lease store; the command/model and UI boundaries are inert.
const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-maintenance-claim-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(suiteRoot, "agent");
const [{ InteractiveAgentRuntime }, { SessionLeaseStore, SessionLeaseError }, { sessionFilePath }] = await Promise.all([
  import("../src/runtime/InteractiveAgentRuntime.js"),
  import("../src/runtime/SessionLease.js"),
  import("../src/session/store.js")
]);
after(async () => {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(suiteRoot, "case-"));
  const leases = await SessionLeaseStore.open(root);
  const competitor = await SessionLeaseStore.open(root);
  const sessionId = "maintenance-session";
  const sessionFile = sessionFilePath(root, sessionId);
  await fs.writeFile(sessionFile, "");
  const agent = {
    getInfo: () => ({ workspaceRoot: root, sessionId, sessionFile, provider: "inert",
      modelLabel: "inert", reasoningLabel: "off", modelAlias: "inert", thinking: "off" as const }),
    getPermissionMode: () => "ask" as const
  } satisfies Pick<AgentSession, "getInfo" | "getPermissionMode">;
  const commands = { agent, persistenceRoot: root, close: async () => {} };
  const runtime = new InteractiveAgentRuntime(commands as unknown as CommandRuntime, { sessionLeases: leases });
  t.after(async () => {
    await runtime.close();
    competitor.close();
    leases.close();
  });
  const assertLocked = () => assert.throws(() => competitor.acquire(sessionId), SessionLeaseError);
  const assertReleased = () => { competitor.acquire(sessionId).close(); };
  return { runtime, competitor, sessionId, assertLocked, assertReleased };
}

for (const mode of ["exclusive", "background"] as const) {
  for (const failed of [false, true]) {
    for (const handoff of ["promote", "release", "release-reclaim", "preclaimed", "unclaimed"] as const) {
      test(`${mode} ${failed ? "failure" : "success"} preserves current ${handoff} lease ownership`, async t => {
        const f = await fixture(t);
        if (["release", "release-reclaim", "preclaimed"].includes(handoff)) await f.runtime.claimSession(f.sessionId);
        const gate = deferred();
        const entered = deferred();
        const execute = async () => { entered.resolve(); await gate.promise; };
        const completion = mode === "exclusive"
          ? f.runtime.runExclusiveOperation("mcp", execute)
          : f.runtime.startBackgroundOperation("mcp", () => ({ completion: execute() })).completion;
        // Observe rejection before releasing the controlled operation.
        const settled = completion.then(() => undefined, (error: unknown) => error);
        try {
          await entered.promise;
          f.assertLocked();
          if (handoff === "promote") await f.runtime.claimSession(f.sessionId);
          if (handoff === "release" || handoff === "release-reclaim") await f.runtime.releaseSessionClaim(f.sessionId);
          if (handoff === "release-reclaim" || handoff === "preclaimed") await f.runtime.claimSession(f.sessionId);
          f.assertLocked();
        } finally {
          if (failed) gate.reject(new Error("Controlled maintenance failure"));
          else gate.resolve();
        }
        const error = await settled;
        if (failed) assert.match(String(error), /Controlled maintenance failure/u);
        else assert.equal(error, undefined);
        // Check at operation completion: waitForIdle's final cleanup must not
        // mask a lease left behind by the operation's own release path.
        assert.equal(f.runtime.getSnapshot().state.kind, "idle");
        if (handoff === "release" || handoff === "unclaimed") f.assertReleased();
        else {
          f.assertLocked();
          // Reusing the claim must keep the real lease, not a closed JS handle.
          await f.runtime.runExclusiveOperation("mcp", async () => { f.assertLocked(); });
          f.assertLocked();
          await f.runtime.releaseSessionClaim(f.sessionId);
          f.assertReleased();
        }
        await f.runtime.waitForIdle();
        const foreignLease = f.competitor.acquire(f.sessionId);
        try {
          await assert.rejects(f.runtime.runExclusiveOperation("mcp", async () => {
            assert.fail("must not execute while another writer owns the lease");
          }), SessionLeaseError);
        } finally { foreignLease.close(); }
      });
    }
  }
}

for (const mode of ["exclusive", "background"] as const) {
  test(`${mode} idle listener can synchronously hand off to new maintenance`, async t => {
    const f = await fixture(t);
    const firstGate = deferred();
    const secondGate = deferred();
    const secondEntered = deferred();
    let secondCompletion: Promise<void> | undefined;
    let started = false;
    const start = (execute: () => Promise<void>) => mode === "exclusive"
      ? f.runtime.runExclusiveOperation("mcp", execute)
      : f.runtime.startBackgroundOperation("mcp", () => ({ completion: execute() })).completion;
    const unsubscribe = f.runtime.subscribe(update => {
      if (update.snapshot.state.kind !== "idle" || started) return;
      started = true;
      // beginMaintenanceOperation runs synchronously, inside the first
      // operation's idle notification, before its release callback returns.
      secondCompletion = start(async () => {
        secondEntered.resolve();
        await secondGate.promise;
      });
    });
    const firstCompletion = start(async () => { await firstGate.promise; });
    let idleResolved = false;
    const idle = f.runtime.waitForIdle().then(() => { idleResolved = true; });
    try {
      f.assertLocked();
      firstGate.resolve();
      await firstCompletion;
      await secondEntered.promise;
      assert.ok(secondCompletion);
      assert.equal(f.runtime.getSnapshot().state.kind, "maintenance");
      // Old completion and an already waiting waitForIdle must neither
      // release the successor's lease nor report idle while it is running.
      f.assertLocked();
      assert.equal(idleResolved, false);
      secondGate.resolve();
      await secondCompletion;
      await idle;
      assert.equal(idleResolved, true);
      assert.equal(f.runtime.getSnapshot().state.kind, "idle");
      f.assertReleased();
    } finally {
      unsubscribe();
      firstGate.resolve();
      secondGate.resolve();
      await firstCompletion;
      await secondCompletion;
      await idle;
    }
  });
}
