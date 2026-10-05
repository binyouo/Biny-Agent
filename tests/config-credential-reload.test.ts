import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadStoredCredentials, MacKeychainCredentialStore, type KeychainCommand } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";

for (const initial of ["present", "missing"] as const) {
  for (const target of ["rotated", "deleted"] as const) {
    if (initial === "missing" && target === "deleted") continue;
    test(`config reload observes ${target} credential after caching ${initial} slot`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-credential-reload-"));
      const account = "provider:deepseek:apiKey";
      // Two stores share a fake backend, without security commands or provider requests.
      const fake = fakeKeychain(new Map());
      try {
        await saveConfigFile(root, structuredClone(defaultConfig));
        const writerCredentials = new MacKeychainCredentialStore(fake.run);
        if (initial === "present") await writerCredentials.set(account, "fake-initial-value");
        const reader = createFileConfigStore(root, { globalDir: root, credentialStore: new MacKeychainCredentialStore(fake.run) });
        const writer = createFileConfigStore(root, { globalDir: root, credentialStore: writerCredentials });
        const before = await reader.loadVersioned!();
        assert.equal(Boolean(before.config.providers.deepseek?.apiKey), initial === "present");
        const writerBefore = await writer.loadVersioned!();
        const next = structuredClone(writerBefore.config);
        next.providers.deepseek!.apiKey = target === "rotated" ? "fake-replacement-value" : undefined;
        const saved = await writer.saveVersioned!(next, writerBefore.revision);
        const reloaded = await reader.loadVersioned!();
        assert.notEqual(saved.revision, before.revision);
        assert.equal(reloaded.revision, saved.revision, "the reader observed the committed config document");
        assert.equal(reloaded.config.providers.deepseek?.apiKey === saved.config.providers.deepseek?.apiKey, true,
          "a new config credential revision must hydrate its corresponding credential value");
        assert.equal(Boolean(reloaded.config.providers.deepseek?.apiKey), target === "rotated");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}


test("unchanged credential revisions keep cached reads and changed slots evict selectively", async () => {
  const account = "provider:deepseek:apiKey";
  const other = "provider:deepseek:refreshToken";
  const fake = fakeKeychain(new Map([[account, "fake-key"], [other, "fake-refresh"]]));
  const store = new MacKeychainCredentialStore(fake.run);
  const config = structuredClone(defaultConfig);
  config.credentialRevisions = { [account]: "api-1", [other]: "refresh-1" };
  config.providers.deepseek!.oauth = { provider: "fixture-oauth", accountId: "fixture", expiresAt: 1_893_456_000_000 };
  await loadStoredCredentials(config, store);
  await loadStoredCredentials(config, store);
  assert.equal(fake.reads.get(account), 1);
  assert.equal(fake.reads.get(other), 1);
  fake.values.set(other, "fake-new-refresh");
  const changed = structuredClone(config);
  changed.credentialRevisions![other] = "refresh-2";
  const hydrated = await loadStoredCredentials(changed, store);
  assert.equal(hydrated.providers.deepseek!.oauth!.refreshToken === "fake-new-refresh", true);
  assert.equal(fake.reads.get(account), 1, "unchanged accounts retain the fast path");
  assert.equal(fake.reads.get(other), 2);
});

test("a stale overlapping hydration cannot republish its cache after a newer revision", async () => {
  const account = "provider:deepseek:apiKey";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fakeKeychain(new Map([[account, "fake-old-value"]]), async (key, _value) => {
    if (key === account && fake.reads.get(account) === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  const store = new MacKeychainCredentialStore(fake.run);
  const before = structuredClone(defaultConfig);
  before.credentialRevisions = { [account]: "version-1" };
  const after = structuredClone(before);
  after.credentialRevisions![account] = "version-2";
  const oldRead = loadStoredCredentials(before, store);
  try {
    await entered.promise;
    fake.values.set(account, "fake-new-value");
    const current = await loadStoredCredentials(after, store);
    assert.equal(current.providers.deepseek!.apiKey === "fake-new-value", true);
    release.resolve();
    const previous = await oldRead;
    assert.equal(previous.providers.deepseek!.apiKey === "fake-old-value", true);
    const final = await loadStoredCredentials(after, store);
    assert.equal(final.providers.deepseek!.apiKey === "fake-new-value", true,
      "an old read may finish for its caller but must not replace the new cache");
    assert.equal(fake.reads.get(account), 2, "the newer cached read stays reusable");
  } finally {
    release.resolve();
    await oldRead;
  }
});

test("revision invalidation retains stored-value precedence and missing-value fallback", async () => {
  const account = "provider:deepseek:apiKey";
  const reference = "fixture:mcp:header";
  const fake = fakeKeychain(new Map([[account, "fake-stored-value"], [reference, "fake-stored-header"]]));
  const store = new MacKeychainCredentialStore(fake.run);
  const config = structuredClone(defaultConfig);
  config.providers.deepseek!.apiKey = "fake-inline-value";
  config.extensions.mcp.fixture = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { fixture: {
    enabled: false, type: "http", url: "http://127.0.0.1:1/unused", timeoutMs: 1000,
    headers: { Authorization: "fake-inline-header" }, credentialRefs: { headers: { Authorization: reference } }
  } } } }).extensions.mcp.fixture!;
  config.credentialRevisions = { [account]: "1", [reference]: "1" };
  const initial = await loadStoredCredentials(config, store);
  assert.equal(initial.providers.deepseek!.apiKey === "fake-stored-value", true);
  assert.equal(initial.extensions.mcp.fixture!.headers!.Authorization === "fake-stored-header", true);
  fake.values.delete(account);
  fake.values.delete(reference);
  const deleted = structuredClone(config);
  deleted.credentialRevisions = { [account]: "2", [reference]: "2" };
  const fallback = await loadStoredCredentials(deleted, store);
  assert.equal(fallback.providers.deepseek!.apiKey === "fake-inline-value", true);
  assert.equal(fallback.extensions.mcp.fixture!.headers!.Authorization === "fake-inline-header", true);
  assert.equal(config.providers.deepseek!.apiKey === "fake-inline-value", true, "hydration never mutates its input");
});

test("first nonce observation and nonce removal invalidate earlier direct reads", async () => {
  const account = "provider:deepseek:apiKey";
  const fake = fakeKeychain(new Map([[account, "fake-before-observation"]]));
  const store = new MacKeychainCredentialStore(fake.run);
  await store.get(account);
  fake.values.set(account, "fake-first-observed");
  const config = structuredClone(defaultConfig);
  config.credentialRevisions = { [account]: "opaque-first" };
  assert.equal((await loadStoredCredentials(config, store)).providers.deepseek!.apiKey === "fake-first-observed", true);
  fake.values.set(account, "fake-after-removal");
  const withoutNonce = structuredClone(config);
  delete withoutNonce.credentialRevisions;
  assert.equal((await loadStoredCredentials(withoutNonce, store)).providers.deepseek!.apiKey === "fake-after-removal", true);
  assert.equal(fake.reads.get(account), 3);
  await loadStoredCredentials(withoutNonce, store);
  assert.equal(fake.reads.get(account), 3, "an unchanged absent nonce retains cached reads");
});

test("a delayed older caller compares opaque nonces without imposing an order", async () => {
  const account = "provider:deepseek:apiKey";
  const fake = fakeKeychain(new Map([[account, "fake-current"]]));
  const store = new MacKeychainCredentialStore(fake.run);
  const current = structuredClone(defaultConfig);
  current.credentialRevisions = { [account]: "a-current-token" };
  const older = structuredClone(current);
  older.credentialRevisions![account] = "z-previous-token";
  await loadStoredCredentials(current, store);
  const delayed = await loadStoredCredentials(older, store);
  assert.equal(delayed.providers.deepseek!.apiKey === "fake-current", true,
    "old document metadata does not authorize an old cached credential");
  await loadStoredCredentials(current, store);
  assert.equal(fake.reads.get(account), 3, "each changed opaque token invalidates, regardless of lexical order");
  await loadStoredCredentials(current, store);
  assert.equal(fake.reads.get(account), 3);
});

test("an older pending missing read cannot poison a newly populated slot", async () => {
  const account = "provider:deepseek:apiKey";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fakeKeychain(new Map(), async (key, _value) => {
    if (key === account && fake.reads.get(account) === 1) { entered.resolve(); await release.promise; }
  });
  const store = new MacKeychainCredentialStore(fake.run);
  const old = structuredClone(defaultConfig);
  old.credentialRevisions = { [account]: "missing-token" };
  const current = structuredClone(old);
  current.credentialRevisions![account] = "present-token";
  const oldRead = loadStoredCredentials(old, store);
  try {
    await entered.promise;
    fake.values.set(account, "fake-newly-present");
    await loadStoredCredentials(current, store);
    release.resolve();
    assert.equal((await oldRead).providers.deepseek!.apiKey, undefined);
    assert.equal((await loadStoredCredentials(current, store)).providers.deepseek!.apiKey === "fake-newly-present", true);
    assert.equal(fake.reads.get(account), 2);
  } finally { release.resolve(); await oldRead; }
});

function fakeKeychain(values: Map<string, string>, pause?: (account: string, value: string | undefined) => Promise<void>) {
  const reads = new Map<string, number>();
  const run: KeychainCommand = async (_command, args, input) => {
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") {
      reads.set(account, (reads.get(account) ?? 0) + 1);
      const value = values.get(account);
      await pause?.(account, value);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: 44 });
      return { stdout: `${value}\n` };
    }
    if (args[0] === "add-generic-password") values.set(account, input?.trim() ?? "");
    else if (args[0] === "delete-generic-password") values.delete(account);
    else throw new Error("Unexpected fake Keychain operation");
    return { stdout: "" };
  };
  return { run, values, reads };
}
