import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { executeConfigurationCommand } from "../src/config/commands.js";
import type { AgentConfigStore } from "../src/config/store.js";

test("configuration commands mask hydrated MCP references without changing stored values", async () => {
  let config = configSchema.parse({ ...defaultConfig, extensions: { mcp: { fixture: {
    type: "http", url: "https://fixture.invalid/mcp",
    env: { VALUE: "synthetic-private-value", PUBLIC: "public-value" },
    headers: { "X-Auth": "synthetic-private-header" },
    credentialRefs: { env: { VALUE: "fixture-env" }, headers: { "X-Auth": "fixture-header" } }
  } } } });
  const store: AgentConfigStore = {
    load: async () => config,
    save: async next => { config = next; },
    loadVersioned: async () => ({ config, revision: "fixture-revision" }),
    saveVersioned: async (next, revision) => {
      assert.equal(revision, "fixture-revision");
      config = next;
      return { config, revision: "fixture-revision" };
    }
  };
  for (const field of ["env.VALUE", "headers.X-Auth"]) {
    assert.equal(await executeConfigurationCommand(store, "config.get", { path: `extensions.mcp.fixture.${field}` }), "[redacted]");
  }
  assert.equal(await executeConfigurationCommand(store, "config.get", { path: "extensions.mcp.fixture.env.PUBLIC" }), "public-value");
  const root = JSON.stringify(await executeConfigurationCommand(store, "config.get", {}));
  assert.ok(!root.includes("synthetic-private"));
  const receipt = await executeConfigurationCommand(store, "config.set", {
    path: "extensions.mcp.fixture.env.VALUE", value: "synthetic-updated-value"
  });
  assert.deepEqual(receipt, { path: "extensions.mcp.fixture.env.VALUE", value: "[redacted]" });
  assert.equal(config.extensions.mcp.fixture!.env!.VALUE, "synthetic-updated-value");
  assert.equal(config.extensions.mcp.fixture!.headers!["X-Auth"], "synthetic-private-header");
});
