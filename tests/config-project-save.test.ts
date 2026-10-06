import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CredentialStore } from "../src/config/credentials.js";
import { loadConfigFile, saveConfigFile } from "../src/config/loader.js";
import { saveProjectSettings } from "../src/config/projectSettings.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../src/config/store.js";
import { ConfigRevisionConflictError } from "../src/config/versioned.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { ModelManager } from "../src/llm/ModelManager.js";

for (const kind of ["file", "desktop"] as const) {
  await testSavedSnapshotKeepsProjectOverrides(kind);
  await testModelSwitchKeepsProjectSelection(kind);
  await testGlobalSnapshotAndFailedWrite(kind);
  await testReadbackKeepsWriteLock(kind);
}

async function testModelSwitchKeepsProjectSelection(kind: "file" | "desktop"): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-project-model-")));
  try {
    const config = configSchema.parse({
      ...defaultConfig,
      defaultModel: "global-model",
      providers: { local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: {
        "global-model": { provider: "local", model: "global-model" },
        "project-model": { provider: "local", model: "project-model" }
      },
      thinking: { ...defaultConfig.thinking, enabled: false }
    });
    await saveConfigFile(root, config);
    await saveProjectSettings(root, { defaultModel: "project-model" });
    const store = makeStore(kind, root);
    // Constructing/switching the model validates configuration without making a provider request.
    const manager = new ModelManager(root, await store.load(), store);
    assert.equal(manager.getInfo().modelAlias, "project-model");
    const switched = await manager.switchModel("global-model", "off");
    assert.equal(switched.modelAlias, "project-model", `${kind} switch must honor the project override immediately`);
    assert.equal((await loadConfigFile(root)).defaultModel, "global-model");
    assert.equal(manager.getInfo().modelAlias, (await store.load()).defaultModel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
console.log("project-aware config save tests passed");

async function testSavedSnapshotKeepsProjectOverrides(kind: "file" | "desktop"): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-project-save-")));
  const globalRoot = path.join(root, "global");
  const workspace = path.join(root, "project");
  const credentials: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined
  };
  try {
    await fs.mkdir(workspace);
    await saveConfigFile(globalRoot, structuredClone(defaultConfig));
    await saveProjectSettings(workspace, {
      defaultModel: "deepseek-v4-flash",
      thinking: { enabled: false },
      context: { compaction: { reserveTokens: 2_048 } }
    });
    const store = kind === "file"
      ? createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore: credentials })
      : new DesktopConfigStore(globalRoot, credentials);
    assert.ok(store.loadVersioned && store.saveVersioned);
    const before = await store.loadVersioned(workspace);
    const candidate = structuredClone(before.config);
    candidate.defaultModel = "deepseek-v4-pro";
    candidate.thinking.enabled = true;
    candidate.context.compaction.reserveTokens = 4_096;
    const saved = await store.saveVersioned(candidate, before.revision, workspace);
    const reloaded = await store.loadVersioned(workspace);
    const global = await loadConfigFile(globalRoot);
    assert.equal(global.defaultModel, "deepseek-v4-pro");
    assert.equal(global.thinking.enabled, true);
    assert.equal(global.context.compaction.reserveTokens, 4_096);
    assert.equal(reloaded.config.defaultModel, "deepseek-v4-flash");
    assert.equal(reloaded.config.thinking.enabled, false);
    assert.equal(reloaded.config.context.compaction.reserveTokens, 2_048);
    assert.equal(saved.config.defaultModel, reloaded.config.defaultModel,
      `${kind} save must return the effective project model, not the hidden global selection`);
    assert.deepEqual(saved, reloaded, `${kind} saved snapshot must match the next read`);
    const followup = structuredClone(saved.config);
    followup.agent.maxConcurrentTools += 1;
    const next = await store.saveVersioned(followup, saved.revision, workspace);
    assert.deepEqual(next, await store.loadVersioned(workspace));
    assert.equal((await loadConfigFile(globalRoot)).defaultModel, "deepseek-v4-pro",
      "saving an unchanged project override must not overwrite the hidden global value");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testGlobalSnapshotAndFailedWrite(kind: "file" | "desktop"): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-global-save-")));
  const originalRename = fs.rename;
  try {
    await saveConfigFile(root, structuredClone(defaultConfig));
    const store = makeStore(kind, root);
    assert.ok(store.loadVersioned && store.saveVersioned);
    const before = await store.loadVersioned();
    const candidate = structuredClone(before.config);
    candidate.defaultModel = "deepseek-v4-pro";
    candidate.agent.maxConcurrentTools += 1;
    const failure = new Error("Injected config publication failure");
    fs.rename = async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === path.join(root, "config.json")) throw failure;
      return await originalRename(...args);
    };
    await assert.rejects(store.saveVersioned(candidate, before.revision), error => error === failure);
    fs.rename = originalRename;
    assert.deepEqual(await store.loadVersioned(), before,
      `${kind} failed publication must not return or publish the candidate`);
    const saved = await store.saveVersioned(candidate, before.revision);
    assert.deepEqual(saved, await store.loadVersioned());
    assert.equal(saved.config.defaultModel, "deepseek-v4-pro");
    assert.equal(saved.config.agent.maxConcurrentTools, candidate.agent.maxConcurrentTools);
    await store.saveVersioned(saved.config, saved.revision);
  } finally {
    fs.rename = originalRename;
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The read-back stays inside the writer's existing lock, including credential hydration. */
async function testReadbackKeepsWriteLock(kind: "file" | "desktop"): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-save-lock-")));
  const originalRename = fs.rename;
  const originalExec = DatabaseSync.prototype.exec;
  const readingBack = Promise.withResolvers<void>();
  const releaseReadback = Promise.withResolvers<void>();
  const contended = Promise.withResolvers<void>();
  let published = false;
  let paused = false;
  let saving: ReturnType<NonNullable<AgentConfigStore["saveVersioned"]>> | undefined;
  let competing: Promise<void> | undefined;
  try {
    await saveConfigFile(root, structuredClone(defaultConfig));
    const store = makeStore(kind, root, async () => {
      if (published && !paused) {
        paused = true;
        readingBack.resolve();
        await releaseReadback.promise;
      }
      return undefined;
    });
    const other = makeStore(kind === "file" ? "desktop" : "file", root);
    assert.ok(store.loadVersioned && store.saveVersioned && other.saveVersioned);
    const before = await store.loadVersioned();
    const candidate = structuredClone(before.config);
    candidate.agent.maxConcurrentTools += 1;
    fs.rename = async (...args: Parameters<typeof fs.rename>) => {
      await originalRename(...args);
      if (args[1] === path.join(root, "config.json")) published = true;
    };
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
    saving = store.saveVersioned(candidate, before.revision);
    await bounded(readingBack.promise);
    competing = assert.rejects(other.saveVersioned(before.config, before.revision), ConfigRevisionConflictError);
    await bounded(contended.promise);
    releaseReadback.resolve();
    const saved = await saving;
    await competing;
    assert.equal(saved.config.agent.maxConcurrentTools, candidate.agent.maxConcurrentTools);
    assert.deepEqual(saved, await store.loadVersioned());
  } finally {
    releaseReadback.resolve();
    await Promise.allSettled([saving, competing]);
    fs.rename = originalRename;
    DatabaseSync.prototype.exec = originalExec;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function makeStore(
  kind: "file" | "desktop",
  root: string,
  get: CredentialStore["get"] = async () => undefined
): AgentConfigStore {
  const credentials: CredentialStore = {
    persistent: false,
    get,
    set: async () => undefined,
    delete: async () => undefined
  };
  return kind === "file"
    ? createFileConfigStore(root, { globalDir: root, credentialStore: credentials })
    : new DesktopConfigStore(root, credentials);
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Config save barrier timed out")), 4_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
