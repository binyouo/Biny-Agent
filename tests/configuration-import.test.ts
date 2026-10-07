/** Configuration imports preserve source files and current Biny choices; credentials stay behind the store. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { discoverConfigurationImports } from "../src/imports/configuration.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { configSchema } from "../src/config/schema.js";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-import-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "project");
  await fs.mkdir(home); await fs.mkdir(workspace);
  const values = new Map<string, string>();
  const store = createFileConfigStore(workspace, { globalDir: path.join(root, "biny"), credentialStore: {
    persistent: true, get: async account => values.get(account), set: async (account, value) => { values.set(account, value); },
    delete: async account => { values.delete(account); }
  } });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const write = async (relative: string, value: unknown) => {
    const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return file;
  };
  return { root, home, workspace, store, write, values };
}

test("Claude model and global MCP imports use credential store, remain disabled and keep default/source files", async t => {
  const f = await fixture(t);
  const files = [await f.write(".claude/settings.json", { model: "claude-sonnet-4-5-20250929", env: { ANTHROPIC_API_KEY: "private-api-key", ANTHROPIC_BASE_URL: "https://proxy.example/api" }, hooks: { ignored: true } }),
    await f.write(".claude.json", { mcpServers: { files: { command: "node", args: ["server.js"], env: { TOKEN: "private-env-value" } }, remote: { type: "http", url: "https://mcp.example/rpc", headers: { Authorization: "private-header-value" } } }, projects: { ignored: {} } })];
  const originals = await Promise.all(files.map(file => fs.readFile(file, "utf8")));
  const before = await f.store.load();
  const candidates = await discoverConfigurationImports("claude", f.home);
  assert.equal(candidates.length, 3);
  for (const secret of ["private-api-key", "private-env-value", "private-header-value"]) assert.equal(JSON.stringify(candidates).includes(secret), false);
  for (const candidate of candidates) assert.equal((await candidate.apply(f.workspace, f.store)).status, "imported");
  const current = await f.store.load();
  assert.equal(current.defaultModel, before.defaultModel);
  assert.deepEqual(current.models[before.defaultModel], before.models[before.defaultModel]);
  assert.equal(current.providers["imported-claude"]?.apiKey, "private-api-key");
  assert.equal(current.providers["imported-claude"]?.baseUrl, "https://proxy.example/api/v1");
  assert.equal(current.models["imported-claude"]?.model, "claude-sonnet-4-5-20250929");
  assert.equal(current.extensions.mcp.files?.enabled, false);
  assert.equal(current.extensions.mcp.files?.env?.TOKEN, "private-env-value");
  assert.equal(current.extensions.mcp.remote?.headers?.Authorization, "private-header-value");
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, "utf8"))), originals);
  assert.equal(JSON.stringify(configSchema.parse(current)).includes("ignored"), false);
  const stored = await fs.readFile(f.store.configPath!(), "utf8");
  for (const secret of ["private-api-key", "private-env-value", "private-header-value"]) assert.equal(stored.includes(secret), false);
});

test("Codex TOML selected provider/model, API-key auth and MCP map without executing or importing unrelated fields", async t => {
  const f = await fixture(t);
  await f.write(".codex/config.toml", `model = "gpt-5.2"\nmodel_provider = "custom"\napproval_policy = "never"\n[model_providers.custom]\nbase_url = "https://api.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n[mcp_servers.files]\ncommand = "node"\nargs = ["server.js"]\n[mcp_servers.files.env]\nTOKEN = "codex-env-secret"\n[mcp_servers.remote]\nurl = "https://mcp.example/rpc"\nhttp_headers = { Authorization = "codex-header-secret" }\n`);
  await f.write(".codex/auth.json", { auth_mode: "apikey", OPENAI_API_KEY: "codex-api-secret" });
  const candidates = await discoverConfigurationImports("codex", f.home);
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) assert.equal((await candidate.apply(f.workspace, f.store)).status, "imported");
  const current = await f.store.load();
  assert.equal(current.providers["imported-codex"]?.apiKey, "codex-api-secret");
  assert.equal(current.providers["imported-codex"]?.apiBackend, "responses");
  assert.equal(current.models["imported-codex"]?.model, "gpt-5.2");
  assert.equal(current.extensions.mcp.files?.enabled, false);
  assert.equal(current.extensions.mcp.remote?.enabled, false);
  assert.equal(current.extensions.mcp.remote?.headers?.Authorization, "codex-header-secret");
});

test("fresh current config conflicts are skipped without replacing same-name entries or chosen default", async t => {
  const f = await fixture(t);
  await f.write(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "new-private" } });
  await f.write(".claude.json", { mcpServers: { files: { command: "new-command" } } });
  const candidates = await discoverConfigurationImports("claude", f.home);
  await updateConfig(f.store, f.workspace, current => ({ ...current,
    providers: { ...current.providers, "imported-claude": { type: "anthropic", apiKey: "existing-private" } },
    models: { ...current.models, "imported-claude": { provider: "imported-claude", model: "existing-model" } },
    extensions: { ...current.extensions, mcp: { files: { command: "existing-command", args: [], stderr: "ignore", enabled: true } } }
  }));
  for (const candidate of candidates) assert.equal((await candidate.apply(f.workspace, f.store)).status, "skipped");
  const current = await f.store.load();
  assert.equal(current.providers["imported-claude"]?.apiKey, "existing-private");
  assert.equal(current.extensions.mcp.files?.command, "existing-command");
});

test("unsupported OAuth and unexpressible fields give safe skipped results; no credential fields are guessed", async t => {
  const f = await fixture(t);
  await f.write(".codex/config.toml", `model = "gpt-5.2"\n[mcp_servers.remote]\nurl = "https://mcp.example"\nenv_http_headers = { Authorization = "SECRET_ENV_NAME" }\n`);
  await f.write(".codex/auth.json", { auth_mode: "chatgpt", tokens: { access_token: "oauth-private", refresh_token: "refresh-private" } });
  const candidates = await discoverConfigurationImports("codex", f.home);
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) assert.equal((await candidate.apply(f.workspace, f.store)).status, "skipped");
  assert.equal(JSON.stringify(candidates).includes("oauth-private"), false);
  assert.equal(JSON.stringify(candidates).includes("SECRET_ENV_NAME"), false);
  assert.equal((await f.store.load()).providers["imported-codex"], undefined);
});

test("source reads reject symlink/hardlink/oversize and malformed configuration without secret diagnostics", async t => {
  const f = await fixture(t);
  const file = await f.write(".claude/settings.json", '{"env":{"ANTHROPIC_API_KEY":"do-not-report-secret"}, invalid}');
  await assert.rejects(discoverConfigurationImports("claude", f.home), error => error instanceof Error && !error.message.includes("do-not-report-secret"));
  await fs.unlink(file); await fs.symlink(path.join(f.root, "missing"), file);
  await assert.rejects(discoverConfigurationImports("claude", f.home), /configuration_import_source_invalid/u);
  await fs.unlink(file); const outside = path.join(f.root, "outside"); await fs.writeFile(outside, "{}"); await fs.link(outside, file);
  await assert.rejects(discoverConfigurationImports("claude", f.home), /configuration_import_source_invalid/u);
  await fs.unlink(file); await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(discoverConfigurationImports("claude", f.home), /configuration_import_source_invalid/u);
});

test("fingerprints remain stable and credential/source changes invalidate prior choices without leaking values", async t => {
  const f = await fixture(t);
  await f.write(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "first-secret" } });
  const [first] = await discoverConfigurationImports("claude", f.home);
  const [same] = await discoverConfigurationImports("claude", f.home);
  assert.ok(first); assert.equal(same?.fingerprint, first.fingerprint);
  await f.write(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "second-secret" } });
  const [next] = await discoverConfigurationImports("claude", f.home);
  assert.notEqual(next?.fingerprint, first.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal((await first.apply(f.workspace, f.store)).status, "imported", "coordinator supplies a validated fresh snapshot; apply does not reread source");
  assert.equal((await f.store.load()).providers["imported-claude"]?.apiKey, "first-secret");
});

test("config write failures expose only a fixed safe message, even if storage errors contain credentials", async t => {
  const f = await fixture(t);
  await f.write(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "private-key-in-error" } });
  const [candidate] = await discoverConfigurationImports("claude", f.home);
  assert.ok(candidate);
  const store = { ...f.store, saveVersioned: async () => { throw new Error("storage private-key-in-error private-env-value"); } };
  await assert.rejects(candidate.apply(f.workspace, store), error => error instanceof Error && error.message === "configuration_import_apply_failed" && error.cause === undefined);
  assert.equal((await f.store.load()).providers["imported-claude"], undefined);
});

test("CAS retry rechecks newly conflicting MCP configuration and preserves the other writer", async t => {
  const f = await fixture(t);
  await f.write(".claude.json", { mcpServers: { test: { command: "source-command" } } });
  const [candidate] = await discoverConfigurationImports("claude", f.home);
  assert.ok(candidate);
  const saveVersioned = f.store.saveVersioned!.bind(f.store);
  let injected = false;
  const competingStore = { ...f.store, saveVersioned: async (...args: Parameters<typeof saveVersioned>) => {
    if (!injected) {
      injected = true;
      const latest = await f.store.load();
      latest.extensions.mcp.test = { command: "competing-command", args: [], stderr: "ignore", enabled: true };
      await f.store.save(latest);
    }
    return await saveVersioned(...args);
  } };
  assert.equal((await candidate.apply(f.workspace, competingStore)).status, "skipped");
  assert.equal((await f.store.load()).extensions.mcp.test?.command, "competing-command");
  assert.equal((await f.store.load()).extensions.mcp.test?.enabled, true);
});

test("parent symlinks are rejected and absent configurations discover no candidates", async t => {
  const f = await fixture(t);
  assert.deepEqual(await discoverConfigurationImports("claude", f.home), []);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "settings.json"), JSON.stringify({ model: "claude-test", env: { ANTHROPIC_API_KEY: "outside-secret" } }));
  await fs.symlink(outside, path.join(f.home, ".claude"));
  await assert.rejects(discoverConfigurationImports("claude", f.home), error => error instanceof Error && error.message === "configuration_import_source_invalid" && error.cause === undefined);
});

test("MCP labels sanitize controls and hide credentials embedded in source names", async t => {
  const f = await fixture(t);
  await f.write(".claude.json", { mcpServers: { "server secret-in-label\ncontrol": { command: "node", env: { TOKEN: "secret-in-label" } } } });
  const [candidate] = await discoverConfigurationImports("claude", f.home);
  assert.ok(candidate);
  assert.equal(candidate.label.includes("secret-in-label"), false);
  assert.equal(/[\u0000-\u001f]/u.test(candidate.label), false);
  assert.equal((await candidate.apply(f.workspace, f.store)).status, "skipped", "control characters in persistent names cannot be installed");
});

test("selected Codex local provider and environment-key reference map without copying process environment", async t => {
  const f = await fixture(t);
  await f.write(".codex/config.toml", `model = "local-test"\nmodel_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:8000/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  let [candidate] = await discoverConfigurationImports("codex", f.home);
  assert.ok(candidate); assert.equal((await candidate.apply(f.workspace, f.store)).status, "imported");
  assert.equal((await f.store.load()).providers["imported-codex"]?.requiresApiKey, false);
  assert.equal((await f.store.load()).providers["imported-codex"]?.apiKey, undefined);
  const second = await fixture(t);
  await second.write(".codex/config.toml", `model = "api-model"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.example/v1"\nenv_key = "IMPORTED_API_KEY"\nwire_api = "responses"\n`);
  [candidate] = await discoverConfigurationImports("codex", second.home);
  assert.ok(candidate); assert.equal((await candidate.apply(second.workspace, second.store)).status, "imported");
  assert.equal((await second.store.load()).providers["imported-codex"]?.apiKeyEnv, "IMPORTED_API_KEY");
  assert.equal((await second.store.load()).providers["imported-codex"]?.apiKey, undefined);
});

test("unmapped selected profiles and MCP execution restrictions are skipped instead of silently discarded", async t => {
  const f = await fixture(t);
  await f.write(".codex/config.toml", `model = "base-model"\nprofile = "selected"\n[profiles.selected]\nmodel = "different-profile-model"\n[mcp_servers.restricted]\ncommand = "node"\ndisabled_tools = ["dangerous"]\n`);
  await f.write(".codex/auth.json", { OPENAI_API_KEY: "profile-secret" });
  const candidates = await discoverConfigurationImports("codex", f.home);
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) assert.equal((await candidate.apply(f.workspace, f.store)).status, "skipped");
  assert.equal((await f.store.load()).providers["imported-codex"], undefined);
  assert.equal((await f.store.load()).extensions.mcp.restricted, undefined);
});


test("imported Claude gateway config reaches the source-equivalent v1/messages endpoint through ProviderRuntime", async t => {
  const f = await fixture(t);
  await f.write(".claude/settings.json", { model: "claude-test", env: { ANTHROPIC_API_KEY: "gateway-secret", ANTHROPIC_BASE_URL: "https://gateway.example/prefix/" } });
  const [candidate] = await discoverConfigurationImports("claude", f.home);
  assert.ok(candidate); assert.equal((await candidate.apply(f.workspace, f.store)).status, "imported");
  const current = await f.store.load();
  let requested: string | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requested = String(input);
    assert.equal(new Headers(init?.headers).get("x-api-key"), "gateway-secret");
    return Response.json({ id: "msg-fixture", type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "text", text: "fixture response" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const settings = new ProviderRegistry(current, [], undefined, undefined, fetcher).createModelSettings("imported-claude");
  assert.ok(settings.vercelModel);
  await settings.vercelModel.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture request" }] }], maxOutputTokens: 16 });
  assert.equal(requested, "https://gateway.example/prefix/v1/messages");
});
