/** Activity 由本地 CLI/技能查询，普通 Agent 的工具目录不直接暴露录屏资料。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-runtime-surface-"));
const priorAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
// 此用例只检查工具目录；占位凭据使 Runtime 装配不依赖开发机的真实密钥。
const config = configSchema.parse({
  ...defaultConfig,
  providers: {
    ...defaultConfig.providers,
    deepseek: { ...defaultConfig.providers.deepseek, apiKey: "test-only-api-key" }
  }
});
let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
try {
  runtime = await createCommandRuntime(root, {
    configStore: { load: async () => config, save: async () => undefined }
  });
  const names = runtime.listTools().map((tool) => tool.name);
  assert.equal(names.some((name) => name.startsWith("activity_")), false);
} finally {
  await runtime?.close();
  if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = priorAgentDir;
  await rm(root, { recursive: true, force: true });
}
