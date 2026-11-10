import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesktopAppearanceSnapshot } from "../src/desktop/protocol.js";
import { AppearancePreviewCoordinator } from "../src/desktop/appearanceCoordinator.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { desktopIpc, type DesktopSettingsSaveInput, type DesktopSettingsSaveResult, type DesktopSettingsSnapshot } from "../src/desktop/protocol.js";

test("settings save refreshes appearance only for its own preferences or changed recovery state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-settings-appearance-"));
  const state = new DesktopStateStore(path.join(root, "state.json"));
  await state.load();
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const nativeChanges: string[] = [];
  const backgrounds: string[] = [];
  const published: DesktopAppearanceSnapshot[] = [];
  const appearance = new AppearancePreviewCoordinator({
    read: () => state.settingsPreferences(),
    publish: snapshot => { published.push(snapshot); }
  });
  let save: (input: DesktopSettingsSaveInput) => Promise<DesktopSettingsSaveResult>;
  const snapshot = () => ({ ...state.settingsPreferences() }) as unknown as DesktopSettingsSnapshot;
  const preferences = () => {
    const saved = state.settingsPreferences();
    return { projectId: "project", hasRunningTasks: false, preferenceRevision: saved.revision,
      themePreference: saved.themePreference, fontPreference: saved.fontPreference };
  };
  const committed = (appliedFields: string[]): DesktopSettingsSaveResult => ({
    status: "committed", journalId: "fixture", appliedFields, snapshot: snapshot()
  });
  Object.assign(globalThis, { __settingsAppearanceElectron: {
    ipcMain: {
      on() {}, removeHandler(channel: string) { handlers.delete(channel); },
      handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) { handlers.set(channel, handler); }
    },
    nativeTheme: { set themeSource(value: string) { nativeChanges.push(value); }, shouldUseDarkColors: false }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,dialog,ipcMain,nativeTheme,shell,systemPreferences,desktopCapturer,screen,nativeImage,Menu}=globalThis.__settingsAppearanceElectron;"
    } : next(url, context);
  } });
  try {
    const { registerDesktopIpc } = await import("../src/desktop/electron/main/ipc.js");
    registerDesktopIpc({
      state, appearance,
      agents: { assertNoRunningTasks() {} },
      settings: { save: async (_project: string, input: DesktopSettingsSaveInput) => await save(input) },
      applicationImports: { withRuntimeAdmission: async (execute: () => Promise<unknown>) => await execute() },
      getWindow: () => ({ isDestroyed: () => false, setBackgroundColor: (value: string) => { backgrounds.push(value); } })
    } as unknown as Parameters<typeof registerDesktopIpc>[0]);
    const handler = handlers.get(desktopIpc.saveSettings)!;
    const submit = async (input: Partial<DesktopSettingsSaveInput>) => await handler({}, "project", {
      expectedPreferenceRevision: state.settingsPreferences().revision,
      expectedConfigRevision: "config:fixture", ...input
    });
    const preview = { ...appearance.snapshot(), themePreference: "dark" as const };
    appearance.preview(7, preview);
    published.length = 0;
    save = async () => committed(["models.toolModel"]);
    await submit({ models: { upserts: [], removeAliases: [], toolModel: { alias: "tool-model" } } });
    assert.deepEqual(nativeChanges, [], "tool-model save must not update native appearance");
    assert.deepEqual(backgrounds, [], "tool-model save must not repaint the window");
    assert.deepEqual(published, [], "tool-model save must not broadcast or discard another page's preview");
    assert.deepEqual(appearance.snapshot(), preview);

    save = async () => ({
      status: "committed", journalId: "fixture", appliedFields: ["models.toolModel"],
      modelSelection: { projectId: "project", hasRunningTasks: false, preferenceRevision: state.settingsPreferences().revision,
        configRevision: "config:next", models: { toolModel: "tool-model" } }
    });
    await submit({ models: { upserts: [], removeAliases: [], toolModel: { alias: "tool-model" } } });
    assert.deepEqual(published, [], "a narrow model receipt cannot discard the appearance preview");

    for (const input of [{ permission: { mode: "ask" as const, criticalAlwaysAsk: true, allowTools: [], allowPaths: [], denyPaths: [] } }, { redaction: { enabled: true } }]) {
      save = async () => committed(Object.keys(input));
      await submit(input);
    }
    assert.deepEqual(published, []);
    assert.deepEqual(nativeChanges, []);

    save = async input => {
      await state.applySettingsPreferences({ themePreference: input.themePreference }, state.settingsPreferences().revision);
      return { status: "committed", journalId: "appearance", appliedFields: ["themePreference"], preferences: preferences() };
    };
    await submit({ themePreference: "dark" });
    assert.equal(published.at(-1)?.themePreference, "dark");
    appearance.release(7);
    assert.equal(published.length, 1, "a successful preference save releases its preview ownership");

    appearance.preview(7, { ...appearance.snapshot(), themePreference: "light" });
    save = async () => ({ status: "rolled_back", draftRetained: true, preferences: preferences() });
    await submit({ themePreference: "light" });
    assert.equal(appearance.snapshot().themePreference, "dark", "failed preference saves restore the persisted appearance");

    const beforeRecovery = published.length;
    save = async () => {
      await state.setThemePreference("light");
      return { status: "recovery_required", journalId: "recovery", message: "cleanup pending", snapshot: snapshot() };
    };
    await submit({ redaction: { enabled: true } });
    assert.equal(published.length, beforeRecovery + 1, "actual preference recovery is published even for another submitted section");
    assert.equal(published.at(-1)?.themePreference, "light");
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__settingsAppearanceElectron");
    await rm(root, { recursive: true, force: true });
  }
});
