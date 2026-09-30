/** 配置文档与凭据必须属于同一快照；屏障固定交错，不依赖 sleep 猜测调度。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CREDENTIAL_TRANSACTION_JOURNAL, type CredentialStore, providerCredentialAccount } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { ConfigRevisionConflictError, configDocumentRevision, type VersionedConfigSnapshot } from "../src/config/versioned.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";

const alias = "deepseek";
const account = providerCredentialAccount(alias, "apiKey");
const oldEndpoint = "https://old.invalid/v1";
const newEndpoint = "https://new.invalid/v1";
const oldCredential = "synthetic-old-credential";
const newCredential = "synthetic-new-credential";

for (const writerKind of ["desktop", "file"] as const) {
  await testReaderBeforeWriter(writerKind);
}
for (const failWrite of [false, true]) await testWriterBeforeReader(failWrite);
await testDeferredRollbackAndFinalize();
for (const side of ["before", "target"] as const) await testJournalRecovery(side);
for (const name of ["Error", "AbortError"]) await testReadFailureReleasesLock(name);
console.log("desktop config snapshot tests passed");

async function testReaderBeforeWriter(writerKind: "desktop" | "file"): Promise<void> {
  const fixture = await createFixture();
  const entered = barrier();
  const release = barrier();
  const contention = observeLockContention(fixture.root);
  let reading: Promise<VersionedConfigSnapshot> | undefined;
  let writing: Promise<VersionedConfigSnapshot> | undefined;
  try {
    let armed = true;
    const reader = new DesktopConfigStore(fixture.root, {
      ...fixture.credentials,
      get: async (key) => {
        if (armed && key === account) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return await fixture.credentials.get(key);
      }
    });
    const writer = writerKind === "desktop"
      ? new DesktopConfigStore(fixture.root, fixture.credentials)
      : createFileConfigStore(fixture.root, { globalDir: fixture.root, credentialStore: fixture.credentials });
    assert.ok(writer.loadVersioned && writer.saveVersioned);
    const before = await writer.loadVersioned();
    reading = reader.loadVersioned();
    await bounded(entered.promise);
    // 读者已取得旧 config，尚未完成凭据 get。旧实现此时允许 writer 完整提交并删除 journal。
    writing = writer.saveVersioned(targetConfig(before.config), before.revision);
    await bounded(Promise.race([writing, contention.promise]));
    release.resolve();
    const snapshot = await reading;
    const saved = await writing;
    assert.deepEqual(snapshotFields(snapshot.config), snapshotFields(before.config),
      `${writerKind} writer must not pair an old endpoint/generation with a new credential`);
    assert.equal(snapshot.revision, before.revision);
    const after = await reader.loadVersioned();
    assert.deepEqual(snapshotFields(after.config), snapshotFields(saved.config));
    assert.equal(after.config.providers[alias]?.baseUrl, newEndpoint);
    assert.equal(after.config.providers[alias]?.apiKey, newCredential);
    assert.notEqual(after.config.credentialRevisions?.[account], before.config.credentialRevisions?.[account]);
    await assert.rejects(reader.saveVersioned(targetConfig(before.config), before.revision), ConfigRevisionConflictError);
    await assertUnlocked(fixture.root);
  } finally {
    release.resolve();
    await Promise.allSettled([reading, writing]);
    contention.restore();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testWriterBeforeReader(failWrite: boolean): Promise<void> {
  const fixture = await createFixture();
  const entered = barrier();
  const release = barrier();
  const contention = observeLockContention(fixture.root);
  let reading: Promise<VersionedConfigSnapshot> | undefined;
  let writing: Promise<void> | undefined;
  try {
    const reader = new DesktopConfigStore(fixture.root, fixture.credentials);
    const before = await reader.loadVersioned();
    let armed = true;
    const writer = new DesktopConfigStore(fixture.root, {
      ...fixture.credentials,
      set: async (key, value) => {
        await fixture.credentials.set(key, value);
        if (armed && key === account && value === newCredential) {
          armed = false;
          entered.resolve();
          await release.promise;
          if (failWrite) throw new Error("Injected credential write failure");
        }
      }
    });
    const saving = writer.save(targetConfig(before.config));
    writing = failWrite ? assert.rejects(saving, /Injected credential write failure/u) : saving;
    await bounded(entered.promise);
    reading = reader.loadVersioned();
    const first = await bounded(Promise.race([
      reading.then(() => "read"),
      contention.promise.then(() => "blocked")
    ]));
    release.resolve();
    await writing;
    const snapshot = await reading;
    assert.equal(first, "blocked", "reader must wait for credential commit or compensation");
    if (failWrite) {
      assert.deepEqual(snapshotFields(snapshot.config), snapshotFields(before.config));
      assert.equal(snapshot.revision, before.revision);
    } else {
      assert.equal(snapshot.config.providers[alias]?.baseUrl, newEndpoint);
      assert.equal(snapshot.config.providers[alias]?.apiKey, newCredential);
      assert.notEqual(snapshot.config.credentialRevisions?.[account], before.config.credentialRevisions?.[account]);
    }
    await assert.rejects(fs.access(path.join(fixture.root, CREDENTIAL_TRANSACTION_JOURNAL)), { code: "ENOENT" });
    await assertUnlocked(fixture.root);
    // 写失败不能污染该实例的队列；后续 CAS 保存仍能获得锁并提交。
    await writer.saveVersioned(targetConfig(snapshot.config), snapshot.revision);
  } finally {
    release.resolve();
    await Promise.allSettled([reading, writing]);
    contention.restore();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testDeferredRollbackAndFinalize(): Promise<void> {
  const fixture = await createFixture();
  const entered = barrier();
  const release = barrier();
  const contention = observeLockContention(fixture.root);
  let reading: Promise<VersionedConfigSnapshot> | undefined;
  let rollingBack: Promise<"not_needed" | "completed" | "failed"> | undefined;
  try {
    let pauseRollback = false;
    const writer = new DesktopConfigStore(fixture.root, {
      ...fixture.credentials,
      set: async (key, value) => {
        await fixture.credentials.set(key, value);
        if (pauseRollback && key === account && value === oldCredential) {
          pauseRollback = false;
          entered.resolve();
          await release.promise;
        }
      }
    });
    const reader = new DesktopConfigStore(fixture.root, fixture.credentials);
    const before = await writer.loadVersioned();
    const saved = await writer.saveVersionedDeferred(targetConfig(before.config), before.revision, "outer-rollback");
    assert.equal(await reader.deferredCredentialStatus("outer-rollback"), "target");
    assert.deepEqual(snapshotFields(await reader.load()), snapshotFields(saved.config));
    pauseRollback = true;
    rollingBack = writer.rollbackVersionedDeferred(before.config, saved.revision, "outer-rollback");
    await bounded(entered.promise);
    reading = reader.loadVersioned();
    const first = await bounded(Promise.race([
      reading.then(() => "read"),
      contention.promise.then(() => "blocked")
    ]));
    release.resolve();
    assert.equal(await rollingBack, "completed");
    assert.equal(first, "blocked", "reader must wait for deferred rollback to restore both sides");
    assert.deepEqual(snapshotFields((await reading).config), snapshotFields(before.config));
    const committed = await writer.saveVersionedDeferred(targetConfig(before.config), before.revision, "outer-finalize");
    await reader.finalizeDeferredCredentials("outer-finalize");
    assert.deepEqual(snapshotFields(await reader.load()), snapshotFields(committed.config));
    assert.equal(await reader.deferredCredentialStatus("outer-finalize"), "missing");
    await assertUnlocked(fixture.root);
  } finally {
    release.resolve();
    await Promise.allSettled([reading, rollingBack]);
    contention.restore();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testJournalRecovery(side: "before" | "target"): Promise<void> {
  const fixture = await createFixture();
  try {
    const store = new DesktopConfigStore(fixture.root, fixture.credentials);
    const before = await store.loadVersioned();
    const target = targetConfig(before.config);
    target.credentialRevisions = { ...target.credentialRevisions, [account]: "recovered-generation" };
    const beforeAccount = "settings-tx:recovery:provider:before";
    const targetAccount = "settings-tx:recovery:provider:target";
    await fixture.credentials.set(beforeAccount, oldCredential);
    await fixture.credentials.set(targetAccount, newCredential);
    // 模拟进程在凭据已改写、journal 尚未清理时退出。
    await fixture.credentials.set(account, newCredential);
    if (side === "target") await saveConfigFile(fixture.root, target);
    await fs.writeFile(path.join(fixture.root, CREDENTIAL_TRANSACTION_JOURNAL), JSON.stringify({
      version: 1,
      id: "recovery",
      stage: "credentials_applied",
      beforeRevision: before.revision,
      targetRevision: configDocumentRevision(target),
      mutations: [{ account, beforeAccount, beforePresent: true, targetAccount, targetPresent: true }]
    }), { mode: 0o600 });
    let failOnce = true;
    const recovering = new DesktopConfigStore(fixture.root, {
      ...fixture.credentials,
      get: async (key) => {
        if (failOnce && key === (side === "before" ? beforeAccount : targetAccount)) {
          failOnce = false;
          throw new Error("Injected recovery read failure");
        }
        return await fixture.credentials.get(key);
      }
    });
    await assert.rejects(recovering.load(), /Injected recovery read failure/u);
    await assertUnlocked(fixture.root);
    await fs.access(path.join(fixture.root, CREDENTIAL_TRANSACTION_JOURNAL));
    const recovered = await recovering.loadVersioned();
    const expected = side === "before" ? before.config : target;
    assert.deepEqual(snapshotFields(recovered.config), snapshotFields(expected));
    assert.equal(recovered.revision, configDocumentRevision(expected));
    assert.equal(fixture.values.has(beforeAccount), false);
    assert.equal(fixture.values.has(targetAccount), false);
    await assert.rejects(fs.access(path.join(fixture.root, CREDENTIAL_TRANSACTION_JOURNAL)), { code: "ENOENT" });
    await assertUnlocked(fixture.root);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function testReadFailureReleasesLock(name: string): Promise<void> {
  const fixture = await createFixture();
  try {
    let failOnce = true;
    const error = Object.assign(new Error("Injected credential read failure"), { name });
    const reader = new DesktopConfigStore(fixture.root, {
      ...fixture.credentials,
      get: async (key) => {
        if (failOnce && key === account) {
          failOnce = false;
          throw error;
        }
        return await fixture.credentials.get(key);
      }
    });
    await assert.rejects(reader.load(), (actual: unknown) => actual === error);
    await assertUnlocked(fixture.root);
    const next = await reader.loadVersioned();
    assert.equal(next.config.providers[alias]?.apiKey, oldCredential);
    await reader.saveVersioned(targetConfig(next.config), next.revision);
    const other = new DesktopConfigStore(fixture.root, fixture.credentials);
    assert.equal((await other.load()).providers[alias]?.apiKey, newCredential);
    await assertUnlocked(fixture.root);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture(): Promise<{ root: string; credentials: CredentialStore; values: Map<string, string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-desktop-config-snapshot-"));
  const config = structuredClone(defaultConfig);
  config.providers[alias]!.baseUrl = oldEndpoint;
  config.credentialRevisions = { [account]: "old-generation" };
  await saveConfigFile(root, config);
  const values = new Map([[account, oldCredential]]);
  const credentials: CredentialStore = {
    persistent: true,
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); }
  };
  return { root, credentials, values };
}

function targetConfig(before: AgentConfig): AgentConfig {
  const target = structuredClone(before);
  target.providers[alias]!.baseUrl = newEndpoint;
  target.providers[alias]!.apiKey = newCredential;
  return target;
}

function snapshotFields(config: AgentConfig): unknown[] {
  return [config.providers[alias]?.baseUrl, config.providers[alias]?.apiKey, config.credentialRevisions?.[account]];
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => { throw new Error("Barrier has not initialized"); };
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

/** 只观察真实锁竞争，不替换文件操作或锁语义；无锁旧实现会先完整提交。 */
function observeLockContention(root: string): { promise: Promise<void>; restore: () => void } {
  const originalOpen = fs.open;
  const originalExec = DatabaseSync.prototype.exec;
  const contended = barrier();
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    try {
      return await originalOpen(...args);
    } catch (error) {
      if (args[0] === path.join(root, ".config.write.lock")
        && typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        contended.resolve();
      }
      throw error;
    }
  };
  // 新文件锁先竞争 SQLite kernel gate；旧协议则在 owner marker 的 open 上竞争。
  // 两种观察点都只转发原调用，确保同一固定交错可验证修复前后的快照行为。
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
    try {
      originalExec.call(this, sql);
    } catch (error) {
      if (sql.includes("BEGIN IMMEDIATE") && error instanceof Error && /database (?:table )?is locked/u.test(error.message)) {
        contended.resolve();
      }
      throw error;
    }
  };
  return {
    promise: contended.promise,
    restore: () => {
      fs.open = originalOpen;
      DatabaseSync.prototype.exec = originalExec;
    }
  };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Snapshot test barrier timed out")), 4_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertUnlocked(root: string): Promise<void> {
  await assert.rejects(fs.access(path.join(root, ".config.write.lock")), { code: "ENOENT" });
}
