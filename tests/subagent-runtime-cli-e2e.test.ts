import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";

test("CLI named worker selection survives Host persistence and executes the selected ACP model", { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-worker-cli-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "data");
  let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
  try {
    await mkdir(path.join(root, ".biny/agents"), { recursive: true });
    await writeFile(path.join(root, ".biny/agents/coder.md"), "---\nname: coder\ndescription: External coder\nruntime: acp\nmodel: external\n---\nReport the result.");
    await saveConfig(root, configSchema.parse({ ...defaultConfig,
      defaultModel: "external", providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } },
      models: { external: { provider: "external", model: "test" } },
      permission: { ...defaultConfig.permission, mode: "full-access", denyPaths: [] },
      extensions: { ...defaultConfig.extensions, subagent: { enabled: true } },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false }, checkpoints: { enabled: false }
    }));
    host = await startRuntimeHost(root, async (resourceRegistry) => await createInteractiveAgentHost(root, { resourceRegistry }), { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
    const cli = path.resolve("src/cli/index.ts");
    const run = async (args: string[]) => (await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "task", ...args], { cwd: root, timeout: 10000 })).stdout;
    const created = JSON.parse(await run(["create", "finite inspection", "--agent", "coder", "--json"]));
    assert.equal(created.task.agent, "coder");
    const result = JSON.parse(await run(["run", created.taskRunId, "--json"]));
    assert.match(JSON.stringify(result), /Reply 1/);
    assert.match(await run(["get", created.taskRunId]), /completed/);
  } finally {
    await host?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
