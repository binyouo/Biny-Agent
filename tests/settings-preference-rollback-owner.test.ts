/** Real preferences transaction and CLI command services; no config/model/native execution. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DesktopSettingsTransaction, type DesktopSettingsJournal, type DesktopSettingsTransactionAgents } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopCommandService } from "../src/desktop/electron/main/DesktopCommandService.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
for (const mode of ["ordinary", "font", "theme", "pending-command", "command-after-rollback", "unchanged", "unchanged-font"] as const) {
  test(`preferences rollback ownership: ${mode}`, { timeout: 10_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-preference-rollback-"));
    const journalReached = deferred(); const failJournal = deferred();
    const stateReached = deferred(); const releaseState = deferred(); const rollbackAdmitted = deferred();
    const resources: { save?: Promise<unknown>; command?: Promise<unknown> } = {};
    const unexpectedDependencies: string[] = [];
    t.after(async () => {
      failJournal.resolve(); releaseState.resolve();
      await Promise.allSettled([resources.save, resources.command]); t.mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
      assert.deepEqual(unexpectedDependencies, [], "preference-only operations must not call config/model dependencies");
    });
    const file = path.join(root, "state.json");
    const state = new DesktopStateStore(file); await state.load();
    const agents = new Proxy({ hasRunningTasks: () => false }, {
      get(target, key) {
        if (key === "hasRunningTasks") return target.hasRunningTasks;
        unexpectedDependencies.push(String(key));
        throw new Error(`Unexpected non-preference dependency: ${String(key)}`);
      }
    }) as unknown as DesktopSettingsTransactionAgents;
    const transaction = new DesktopSettingsTransaction(state, agents);
    const commands = new DesktopCommandService({ state, appearance: { committed() {} } } as unknown as ConstructorParameters<typeof DesktopCommandService>[0]);
    const initial = state.settingsPreferences(); const unchanged = mode.startsWith("unchanged");
    const restore = state.restoreSettingsPreferences.bind(state);
    t.mock.method(state, "restoreSettingsPreferences", (...args: Parameters<typeof restore>) => {
      const pending = restore(...args); rollbackAdmitted.resolve(); return pending;
    });
    let failed = false; let stateHeld = false;
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]) => {
      if (String(target) === state.settingsTransactionJournalPath() && !failed) {
        const journal = JSON.parse(await fs.readFile(source, "utf8")) as DesktopSettingsJournal;
        if (journal.segments.preferences.state === "committed") {
          failed = true; journalReached.resolve(); await failJournal.promise;
          throw Object.assign(new Error("synthetic committed-journal rename EIO"), { code: "EIO" });
        }
      }
      if (String(target) === file && !stateHeld) {
        const next = JSON.parse(await fs.readFile(source, "utf8")) as { themePreference: string; fontPreference: { size: number }; preferenceRevision: number };
        if (mode === "pending-command" && next.fontPreference.size === 20
          || mode === "command-after-rollback" && next.preferenceRevision === 2 && next.themePreference === initial.themePreference) {
          stateHeld = true; stateReached.resolve(); await releaseState.promise;
        }
      }
      return rename(source, target);
    });
    const save = transaction.save("synthetic-project", {
      expectedPreferenceRevision: initial.revision, expectedConfigRevision: "unused",
      themePreference: unchanged ? initial.themePreference : "dark"
    }); resources.save = save;
    await journalReached.promise;
    const setFont = () => commands.execute({ action: "preferences.set", path: "fontPreference.size", value: 20 });
    const preserved = mode === "font" || mode === "theme" || mode === "pending-command" || mode === "unchanged-font";
    if (mode === "pending-command") {
      resources.command = setFont(); await stateReached.promise;
      failJournal.resolve(); await rollbackAdmitted.promise; releaseState.resolve(); await resources.command;
    } else if (mode === "command-after-rollback") {
      failJournal.resolve(); await stateReached.promise;
      const command = setFont().then(value => ({ value }), error => ({ error })); resources.command = command;
      releaseState.resolve(); const result = await command;
      assert.ok("error" in result, "a command admitted with an obsolete revision must report conflict");
      assert.equal(result.error.name, "DesktopPreferenceRevisionConflictError");
    } else {
      if (preserved) {
        await commands.execute({ action: "preferences.set", path: mode === "theme" ? "themePreference" : "fontPreference.size", value: mode === "theme" ? "light" : 20 });
        const disk = JSON.parse(await fs.readFile(file, "utf8"));
        assert.equal(mode === "theme" ? disk.themePreference : disk.fontPreference.size, mode === "theme" ? "light" : 20,
          "successful concurrent command is confirmed on disk before rollback");
      }
      failJournal.resolve();
    }
    const result = await save;
    const expected = preserved
      ? { ...initial, revision: unchanged ? 1 : 2, themePreference: mode === "theme" ? "light" : unchanged ? initial.themePreference : "dark",
          fontPreference: mode === "theme" ? initial.fontPreference : { ...initial.fontPreference, size: 20 } }
      : { ...initial, revision: unchanged ? 0 : 2 };
    assert.deepEqual(state.settingsPreferences(), expected);
    const persisted = new DesktopStateStore(file); await persisted.load();
    assert.deepEqual(persisted.settingsPreferences(), expected, "result must also survive a fresh store read");
    assert.equal(result.status, preserved ? "recovery_required" : "rolled_back");
    if (preserved) {
      await fs.access(state.settingsTransactionJournalPath());
      const diskBefore = await fs.readFile(file);
      const restarted = new DesktopStateStore(file); await restarted.load();
      const recovery = new DesktopSettingsTransaction(restarted, agents);
      const pendingRecovery = await recovery.recoverAtStartup();
      assert.ok(pendingRecovery, "external revision requires explicit recovery");
      assert.doesNotMatch(pendingRecovery.message, /Unexpected/);
      await assert.rejects(recovery.assertRuntimeReady(), /设置事务尚未恢复/, "unresolved recovery continues to gate new work");
      assert.deepEqual(restarted.settingsPreferences(), expected);
      assert.deepEqual(await fs.readFile(file), diskBefore, "startup recovery preserves newer confirmed preferences");
    } else {
      await assert.rejects(fs.access(state.settingsTransactionJournalPath()), { code: "ENOENT" });
      if (mode === "command-after-rollback") {
        await setFont(); assert.equal(state.fontPreference().size, 20, "fresh-revision command retry succeeds");
        const afterRetry = new DesktopStateStore(file); await afterRetry.load();
        assert.deepEqual(afterRetry.settingsPreferences(), state.settingsPreferences());
      }
    }
  });
}
