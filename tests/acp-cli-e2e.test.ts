import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";

const execute = promisify(execFile);
test("ACP CLI exposes text and JSON diagnostics using the same external session protocol", { timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-cli-"));
  const data = path.join(root, "data");
  try {
    await mkdir(data);
    await writeFile(path.join(data, "config.json"), JSON.stringify(configSchema.parse({ ...defaultConfig,
      defaultModel: "external", providers: { external: { type: "acp", acp: { command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] } } },
      models: { external: { provider: "external", model: "default" } }
    })));
    const options = { cwd: root, env: { ...process.env, BINY_AGENT_DIR: data, BINY_TEST_PROCESS: "1" }, timeout: 10000 };
    const entry = path.resolve("dist/cli/index.js");
    const result = await execute(process.execPath, [entry, "acp", "check", "external", "--json"], options);
    assert.deepEqual(JSON.parse(result.stdout).models, [{ id: "test", name: "Test model" }]);
    assert.match((await execute(process.execPath, [entry, "acp", "check", "external"], options)).stdout, /ACP 已连接：external/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
