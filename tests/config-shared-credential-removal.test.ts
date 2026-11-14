import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type CredentialStore } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";

for (const removed of ["first", "second"] as const) {
  test(`removing ${removed} MCP server preserves a credential referenced by the survivor`, async () => {
    await fixture(async (store, values, account) => {
      const before = await store.loadVersioned!();
      assert.equal(before.config.extensions.mcp.first!.env!.TOKEN, "synthetic-secret");
      assert.equal(before.config.extensions.mcp.second!.env!.TOKEN, "synthetic-secret");
      const next = structuredClone(before.config);
      delete next.extensions.mcp[removed];
      await store.saveVersioned!(next, before.revision);
      const reloaded = await store.load();
      assert.equal(values.get(account), "synthetic-secret");
      assert.equal(reloaded.extensions.mcp[removed === "first" ? "second" : "first"]!.env!.TOKEN, "synthetic-secret");
    });
  });
}

test("removing the final MCP reference deletes the unreferenced credential", async () => {
  await fixture(async (store, values, account) => {
    const before = await store.loadVersioned!();
    const next = structuredClone(before.config);
    next.extensions.mcp = {};
    await store.saveVersioned!(next, before.revision);
    assert.equal(values.has(account), false);
    assert.deepEqual((await store.load()).extensions.mcp, {});
  });
});

for (const removed of ["TOKEN", "ALIAS"] as const) {
  test(`clearing ${removed} leaves the other field's shared credential intact`, async () => {
    await fixture(async (store, values, account) => {
      const before = await store.loadVersioned!();
      const setup = structuredClone(before.config);
      delete setup.extensions.mcp.second;
      setup.extensions.mcp.first!.env!.ALIAS = "synthetic-secret";
      setup.extensions.mcp.first!.credentialRefs!.env!.ALIAS = account;
      // Persist setup through the same public store, with the shared field added.
      await store.saveVersioned!(setup, before.revision);
      const current = await store.loadVersioned!();
      const next = structuredClone(current.config);
      delete next.extensions.mcp.first!.env![removed];
      delete next.extensions.mcp.first!.credentialRefs!.env![removed];
      await store.saveVersioned!(next, current.revision);
      assert.equal(values.get(account), "synthetic-secret");
      assert.equal((await store.load()).extensions.mcp.first!.env![removed === "TOKEN" ? "ALIAS" : "TOKEN"], "synthetic-secret");
    }, false);
  });
}

async function fixture(
  run: (store: ReturnType<typeof createFileConfigStore>, values: Map<string, string>, account: string) => Promise<void>,
  second = true
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-shared-credential-"));
  const account = "mcp:shared:env:TOKEN";
  const values = new Map([[account, "synthetic-secret"]]);
  const credentials: CredentialStore = {
    persistent: true,
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async key => { values.delete(key); }
  };
  try {
    const config = structuredClone(defaultConfig);
    const server = { command: "node", args: [], enabled: false, stderr: "ignore" as const, credentialRefs: { env: { TOKEN: account } } };
    config.extensions.mcp = { first: structuredClone(server), ...(second ? { second: structuredClone(server) } : {}) };
    await saveConfigFile(root, configSchema.parse(config));
    const store = createFileConfigStore(root, { globalDir: root, credentialStore: credentials });
    await run(store, values, account);
    assert.equal([...values.keys()].some(key => key.startsWith("settings-tx:")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
