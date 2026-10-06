import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CredentialStore } from "../src/config/credentials.js";
import { loadConfig, loadConfigFile, saveConfig, saveConfigFile } from "../src/config/loader.js";
import { saveProjectSettings, type ProjectSettings } from "../src/config/projectSettings.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { saveModelSelection } from "../src/llm/ModelManager.js";

type SaveKind = "loader" | "file" | "desktop";

for (const kind of ["loader", "file", "desktop"] as const) {
  for (const globalCommands of [[], [{ extensions: [".js"], command: "global-check", timeoutMs: 45_000 }]]) {
    test(`${kind}: unrelated saves keep normalized project commands out of global settings (${globalCommands.length} global commands)`, async () => {
      await fixture(kind, globalCommands, async ({ workspace, otherWorkspace, globalRoot, save, initial, projectBytes }) => {
        assert.equal(initial.diagnostics.commands[0]?.timeoutMs, 120_000);
        assert.equal(initial.diagnostics.commands[1]?.timeoutMs, 9_000);
        for (const temperature of [0.2, 0.4]) {
          const saved = await save(config => ({ ...config, chat: { ...config.chat, temperature } }));
          assert.equal(saved.chat.temperature, temperature);
          assert.deepEqual(saved.diagnostics.commands, initial.diagnostics.commands);
          assert.deepEqual((await loadConfig(otherWorkspace, { globalDir: globalRoot })).diagnostics.commands, globalCommands,
            "another project must not inherit project-only commands");
          assert.deepEqual((await loadConfigFile(globalRoot)).diagnostics.commands, globalCommands,
            "an unrelated save must preserve the hidden global commands");
          assert.equal(await fs.readFile(path.join(workspace, ".biny", "settings.json"), "utf8"), projectBytes);
        }
      });
    });
  }

  for (const change of ["edit", "delete"] as const) {
    test(`${kind}: explicit command ${change} still updates global settings while project override remains effective`, async () => {
      await fixture(kind, [{ extensions: [".js"], command: "global-check", timeoutMs: 45_000 }], async ({ otherWorkspace, globalRoot, save, initial }) => {
        const commands = change === "delete" ? [] : [{ extensions: [".tsx"], command: "updated-global-check", timeoutMs: 30_000 }];
        const saved = await save(config => ({ ...config, diagnostics: { ...config.diagnostics, commands } }));
        assert.deepEqual((await loadConfigFile(globalRoot)).diagnostics.commands, commands);
        assert.deepEqual((await loadConfig(otherWorkspace, { globalDir: globalRoot })).diagnostics.commands, commands);
        assert.deepEqual(saved.diagnostics.commands, initial.diagnostics.commands);
      });
    });
  }

  for (const project of [
    {},
    { diagnostics: { commands: [] } },
    { diagnostics: { commands: [{ extensions: [".ts"], command: "explicit-timeout-check", timeoutMs: 8_000 }] } }
  ] satisfies ProjectSettings[]) {
    test(`${kind}: unchanged sparse/empty/explicit-timeout overrides preserve global commands (${JSON.stringify(project)})`, async () => {
      const globalCommands = [{ extensions: [".js"], command: "global-check", timeoutMs: 45_000 }];
      await fixture(kind, globalCommands, async ({ save, globalRoot, initial }) => {
        const saved = await save(config => ({ ...config, chat: { ...config.chat, temperature: 0.6 } }));
        assert.deepEqual(saved.diagnostics.commands, initial.diagnostics.commands);
        assert.deepEqual((await loadConfigFile(globalRoot)).diagnostics.commands, globalCommands);
      }, project);
    });
  }

  if (kind !== "loader") {
    test(`${kind}: saving a real model selection does not replace global diagnostics with project commands`, async () => {
      await fixture(kind, [], async ({ workspace, globalRoot, store }) => {
        assert.ok(store);
        const selected = await saveModelSelection(workspace, store, "second-model", "off");
        assert.equal(selected.defaultModel, "second-model");
        assert.equal((await loadConfigFile(globalRoot)).defaultModel, "second-model");
        assert.deepEqual((await loadConfigFile(globalRoot)).diagnostics.commands, []);
      });
    });
  }
}

test("loader: normalization does not prevent saving a repair for an unrelated invalid project model alias", async () => {
  const globalCommands = [{ extensions: [".js"], command: "global-check", timeoutMs: 45_000 }];
  await fixture("loader", globalCommands, async ({ workspace, globalRoot, initial }) => {
    await saveProjectSettings(workspace, {
      defaultModel: "added-model",
      diagnostics: { commands: [{ extensions: [".ts"], command: "project-only-check" }] }
    });
    await assert.rejects(loadConfig(workspace, { globalDir: globalRoot }), /Project defaultModel/u);
    const repaired = {
      ...initial,
      diagnostics: { ...initial.diagnostics, commands: [initial.diagnostics.commands[0]!] },
      models: { ...initial.models, "added-model": { provider: "local", model: "added-model" } }
    };
    await saveConfig(workspace, repaired, { globalDir: globalRoot });
    assert.equal((await loadConfig(workspace, { globalDir: globalRoot })).defaultModel, "added-model");
    assert.deepEqual((await loadConfigFile(globalRoot)).diagnostics.commands, globalCommands);
  });
});

async function fixture(
  kind: SaveKind,
  commands: AgentConfig["diagnostics"]["commands"],
  run: (state: {
    workspace: string;
    otherWorkspace: string;
    globalRoot: string;
    initial: AgentConfig;
    projectBytes: string;
    store: ReturnType<typeof createFileConfigStore> | undefined;
    save: (update: (config: AgentConfig) => AgentConfig) => Promise<AgentConfig>;
  }) => Promise<void>,
  project: ProjectSettings = {
    diagnostics: {
      commands: [
        { extensions: [".ts"], command: "project-only-check" },
        { extensions: [".css"], command: "project-style-check", timeoutMs: 9_000 }
      ]
    }
  }
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-config-normalization-"));
  const workspace = path.join(root, "project-a");
  const otherWorkspace = path.join(root, "project-b");
  const globalRoot = path.join(root, "global");
  const credentials: CredentialStore = {
    persistent: false,
    get: async () => undefined,
    set: async () => { throw new Error("This fixture must not write credentials"); },
    delete: async () => { throw new Error("This fixture must not delete credentials"); }
  };
  try {
    await fs.mkdir(workspace);
    await fs.mkdir(otherWorkspace);
    const globalConfig = configSchema.parse({
      ...defaultConfig,
      defaultModel: "first-model",
      providers: { local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: {
        "first-model": { provider: "local", model: "first-model" },
        "second-model": { provider: "local", model: "second-model" }
      },
      diagnostics: { ...defaultConfig.diagnostics, commands }
    });
    await saveConfigFile(globalRoot, globalConfig);
    await saveProjectSettings(workspace, project);
    const projectBytes = await fs.readFile(path.join(workspace, ".biny", "settings.json"), "utf8");
    const store = kind === "file"
      ? createFileConfigStore(workspace, { globalDir: globalRoot, credentialStore: credentials })
      : kind === "desktop" ? new DesktopConfigStore(globalRoot, credentials) : undefined;
    const initial = await loadConfig(workspace, { globalDir: globalRoot });
    const save = async (update: (config: AgentConfig) => AgentConfig): Promise<AgentConfig> => {
      if (store) return await updateConfig(store, workspace, update);
      await saveConfig(workspace, update(await loadConfig(workspace, { globalDir: globalRoot })), { globalDir: globalRoot });
      return await loadConfig(workspace, { globalDir: globalRoot });
    };
    await run({ workspace, otherWorkspace, globalRoot, initial, projectBytes, store, save });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
