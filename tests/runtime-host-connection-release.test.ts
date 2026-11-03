import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/host/bootstrap.js";
import { connectRuntimeHost } from "../src/runtime/host/connection.js";
import { acquireHostLock, readRegistration, removeRegistration, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { createHostTestStores } from "./helpers/hostStores.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";
import { readyHostClient } from "./helpers/readyHostClient.js";

for (const outcome of ["blocked", "failed"] as const) {
  test(`disconnected preparation retains owner while cleanup is ${outcome}`, { timeout: 10_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-disconnect-")));
    const paths = runtimeHostPaths(root);
    const closingPrepared = Promise.withResolvers<void>();
    const releasePrepared = Promise.withResolvers<void>();
    const runtimes = new Map<string, InteractiveAgentRuntime>();
    let preparedCloseCount = 0;
    const create = async (sessionId = "primary") => {
      const commands = {
        ...await createHostTestStores(root),
        agent: { getInfo: () => ({ sessionId, workspaceRoot: root }), getPermissionMode: () => "ask" },
        close: async () => {
          if (sessionId === "primary") return;
          preparedCloseCount += 1;
          closingPrepared.resolve();
          await releasePrepared.promise;
          if (outcome === "failed") throw new Error("Prepared resource disposal failed");
        }
      } as unknown as CommandRuntime;
      const runtime = new InteractiveAgentRuntime(commands);
      runtimes.set(sessionId, runtime);
      return { runtime, commands };
    };
    const server = await startRuntimeHost(root, () => create(), { createRuntime: create, shutdownDrainMs: 100 });
    const client = await readyHostClient(await connectRuntimeHost(root));
    const observer = await readyHostClient(await connectRuntimeHost(root));
    assert.ok(client);
    assert.ok(observer);
    try {
      const prepared = await client.ensureSession({ runOptions: { headless: true }, writeIntent: true });
      await client.close();
      await closingPrepared.promise;
      assert.ok(!(await observer.request<Array<{ sessionId: string }>>("session.list"))
        .some(entry => entry.sessionId === prepared.sessionId), "the closing runtime has already left the session registry");
      if (outcome === "failed") releasePrepared.resolve();
      await assert.rejects(server.close(), outcome === "blocked"
        ? /shutdown exceeded/u
        : /execution cleanup failed/u);
      assert.ok(await readRegistration(paths), "failed or unfinished disposal must retain registration");
      await assert.rejects(acquireHostLock(paths, root), /already running or starting/u);
      assert.equal(preparedCloseCount, 1, "disconnect and Host shutdown must share the same disposal");
    } finally {
      releasePrepared.resolve();
      await client.close();
      await observer.close();
      await server.close().catch(() => undefined);
      await Promise.allSettled([...runtimes.values()].map(runtime => runtime.close()));
      await server.waitForRequests();
      // A failed Host deliberately retains ownership until process exit. This
      // in-process fixture releases it only after its gated resources settle.
      await removeRegistration(server.registration);
      await server.lock.close();
      await removeTestRoot(root, { recursive: true, force: true });
    }
  });
}
