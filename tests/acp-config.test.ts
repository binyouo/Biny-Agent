import { acpMcpServers } from "../src/acp/client.js";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolModelAlias } from "../src/llm/toolModel.js";
import { acpConfigSchema, configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { modelConfigurationSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";

test("ACP connections retain a launch specification and are available without an HTTP endpoint or API key", () => {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: "agent-acp", args: ["--stdio"] } } },
    models: { external: { provider: "external", model: "default" } }
  });
  assert.deepEqual(config.providers.external?.acp, {
    command: "agent-acp", args: ["--stdio"], env: {}, mcpServers: [], allowMemory: false, promptTimeoutMs: 1_800_000, maxOutputBytes: 16_777_216
  });
  const runtime = new ModelRuntime(config);
  assert.equal(runtime.listModels().find((model) => model.alias === "external")?.available, true);
  assert.equal(runtime.createModelSettings().model.provider, "acp");
});

test("Desktop ACP settings preserve command arguments across the validated save boundary", () => {
  const result = modelConfigurationSchema.parse({ alias: "external", displayName: "External", providerAlias: "external", providerType: "acp",
    model: "default", supportsTools: true, acp: { command: "agent", args: ["argument with spaces"] } });
  assert.deepEqual(result.acp?.args, ["argument with spaces"]);
});

test("external Agents never become background tool models and require a launch command", () => {
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: { command: "agent" } } },
    models: { external: { provider: "external", model: "default" } } });
  assert.equal(resolveToolModelAlias(config), undefined);
  assert.equal(resolveToolModelAlias({ ...config, toolModel: "external" }), undefined);
  assert.equal(configSchema.safeParse({ ...config, providers: { external: { type: "acp" } } }).success, false);
});

test("ACP sends only selected MCP connections and refuses hidden-tool policies that cannot be enforced remotely", () => {
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
    chosen: { command: "node", args: ["server.mjs"] }, unused: { command: "unused" },
    restricted: { command: "restricted", toolExposure: { secret: "hidden" } }
  } } });
  assert.deepEqual(acpMcpServers(config, acpConfigSchema.parse({ command: "agent", mcpServers: ["chosen"] })), [
    { name: "chosen", command: "node", args: ["server.mjs"], env: [] }
  ]);
  assert.throws(() => acpMcpServers(config, acpConfigSchema.parse({ command: "agent", mcpServers: ["restricted"] })), /隐藏/u);
});

test("ACP refuses direct MCP delegation under restrictive permission modes or file-change contracts", () => {
  const launch = acpConfigSchema.parse({ command: "agent", mcpServers: ["chosen"] });
  for (const mode of ["ask", "read-only", "auto"] as const) {
    const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode },
      extensions: { ...defaultConfig.extensions, mcp: { chosen: { command: "server" } } } });
    assert.throws(() => acpMcpServers(config, launch), /完全访问/u);
  }
  const config = configSchema.parse({ ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: { chosen: { command: "server", toolContracts: { edit: "file-change-v1" } } } } });
  assert.throws(() => acpMcpServers(config, launch), /文件变更/u);
});
