import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const source of ["mcp", "plugin", "builtin"] as const) {
  test(`${source} read risk alone ${source === "builtin" ? "permits" : "does not permit"} safe retry`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-safety-"));
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, "retry-safety");
    recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    registry.register({ name: "inspect", description: "inspect", source, risk: "read", parameters: { type: "object" }, schema: z.object({}),
      resolveExecution: () => ({ accesses: ToolAccesses.all(), async execute({ signal }) {
        notifyStarted();
        await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
        return "cancelled";
      } })
    }, source);
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, toolRegistry: registry, recorder }, new PermissionManager(config.permission), () => {});
    const controller = new AbortController();
    const execution = coordinator.createAgentTools().find((tool) => tool.name === "inspect")!.execute("call", {}, controller.signal);
    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => { startTimeout = setTimeout(() => reject(new Error("tool did not start")), 2_000); })]);
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const admitted = events.find((event) => event.type === "tool_execution" && event.state === "admitted");
      assert.equal(admitted?.type === "tool_execution" ? admitted.retrySafety : undefined, source === "builtin" ? "safe" : "unknown");
      assert.equal(replaySessionEvents(events, { sessionId: recorder.sessionId }).recoveredToolResults[0]?.executionStatus, source === "builtin" ? "cancelled" : "unknown");
    } finally {
      clearTimeout(startTimeout);
      controller.abort();
      await execution;
      await coordinator.waitForIdle();
      await recorder.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
