import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopPreferenceRevisionConflictError,
  DesktopStateStore,
  type DesktopWindowBounds
} from "../src/desktop/electron/main/DesktopStateStore.js";

const initialBounds: DesktopWindowBounds = { x: 20, y: 30, width: 1_000, height: 700 };
const changedBounds: DesktopWindowBounds = { x: 120, y: 130, width: 1_100, height: 800 };

interface StateFixture {
  state: DesktopStateStore;
  statePath: string;
}

interface PublicationGate {
  failure: Error;
  start<T>(operation: Promise<T>): Promise<T>;
  waitForFirstPublication(): Promise<void>;
  release(): void;
  publicationCount(): number;
  failureCount(): number;
}

test("failed theme publication cannot leak into a queued window-bounds save", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 1, async gate => {
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      // The native window move/resize timer calls this public method independently
      // of the settings renderer, including while the theme IPC is still pending.
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      gate.release();
      await assert.rejects(theme, error => error === gate.failure);
      await bounds;

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.deepEqual(state.settingsPreferences(), before);
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.windowBounds(), changedBounds);
      assert.deepEqual(restored.settingsPreferences(), before,
        "a successful bounds save must persist the rolled-back preferences, not its queued uncommitted theme snapshot");
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
    });
  });
});

test("failed theme publication cannot leak into a queued sidebar-width IPC save", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 1, async gate => {
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      const sidebar = gate.start(state.setSidebarWidth(320));
      gate.release();
      await assert.rejects(theme, error => error === gate.failure);
      await sidebar;

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.deepEqual(state.settingsPreferences(), before);
      assert.equal(state.sidebarWidth(), 320);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.equal(restored.sidebarWidth(), 320);
      assert.deepEqual(restored.windowBounds(), initialBounds);
      assert.deepEqual(restored.settingsPreferences(), before,
        "the independent sidebar IPC must not resurrect an unsuccessfully saved theme");
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
    });
  });
});

test("successful theme and queued window-bounds publications retain both changes", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, undefined, async gate => {
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      gate.release();
      await Promise.all([theme, bounds]);

      assert.equal(gate.failureCount(), 0);
      assert.equal(gate.publicationCount(), 2);
      assert.equal(state.themePreference(), "dark");
      assert.equal(state.settingsPreferences().revision, before.revision + 1);
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), changedBounds);
    });
  });
});

test("an older failed theme cannot roll back a newer successful theme publication", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 1, async gate => {
      const older = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      const newer = gate.start(state.setThemePreference("light"));
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      gate.release();
      await assert.rejects(older, error => error === gate.failure);
      await Promise.all([newer, bounds]);

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 3);
      assert.equal(state.themePreference(), "light");
      assert.ok(state.settingsPreferences().revision > before.revision);
      assert.deepEqual(state.settingsPreferences().fontPreference, before.fontPreference);
      assert.deepEqual(state.settingsPreferences().appearancePreference, before.appearancePreference);
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), changedBounds);
    });
  });
});

test("a preceding window-bounds publication excludes a later failed theme", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 2, async gate => {
      // Start both public methods in the same synchronous turn, before either
      // queued writer executes. A lazy stringify of mutable state would let the
      // earlier bounds publication include this later uncommitted preference.
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      gate.release();
      await bounds;
      await assert.rejects(theme, error => error === gate.failure);

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.deepEqual(state.settingsPreferences(), before);
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), before,
        "bounds published before a failed theme must contain only the earlier committed preferences");
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), changedBounds);
    });
  });
});

test("explicit preference CAS permits only one successful writer for the same revision", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    const font = { ...before.fontPreference, size: 17 };
    await withPublicationGate(statePath, undefined, async gate => {
      const first = gate.start(state.applySettingsPreferences({ themePreference: "dark" }, before.revision));
      await gate.waitForFirstPublication();
      const stale = gate.start(state.applySettingsPreferences({ fontPreference: font }, before.revision));
      gate.release();
      const committed = await first;
      await assert.rejects(stale, error => error instanceof DesktopPreferenceRevisionConflictError
        && error.expectedRevision === before.revision
        && error.actualRevision === committed.revision);

      assert.equal(gate.failureCount(), 0);
      assert.equal(gate.publicationCount(), 1, "the stale CAS must perform no publication");
      assert.equal(committed.themePreference, "dark");
      assert.equal(committed.revision, before.revision + 1);
      assert.deepEqual(committed.fontPreference, before.fontPreference);
      assert.deepEqual(state.settingsPreferences(), committed);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), committed);
      assert.deepEqual(restored.windowBounds(), initialBounds);
    });
  });
});

test("concurrent convenience setters preserve both successfully published preference fields", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    const font = { ...before.fontPreference, size: 17 };
    await withPublicationGate(statePath, undefined, async gate => {
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      const fontWrite = gate.start(state.setFontPreference(font));
      gate.release();
      await Promise.all([theme, fontWrite]);

      assert.equal(gate.failureCount(), 0);
      assert.equal(gate.publicationCount(), 2);
      assert.equal(state.themePreference(), "dark");
      assert.deepEqual(state.fontPreference(), font);
      assert.equal(state.settingsPreferences().revision, before.revision + 2);
      assert.deepEqual(state.appearancePreference(), before.appearancePreference);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), initialBounds);
    });
  });
});

test("a successful font patch does not commit an earlier failed theme patch", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    const font = { ...before.fontPreference, size: 17 };
    await withPublicationGate(statePath, 1, async gate => {
      const theme = gate.start(state.setThemePreference("dark"));
      await gate.waitForFirstPublication();
      const fontWrite = gate.start(state.setFontPreference(font));
      gate.release();
      await assert.rejects(theme, error => error === gate.failure);
      await fontWrite;

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.equal(state.themePreference(), before.themePreference,
        "a later font-only patch must not adopt a failed theme change as its baseline");
      assert.deepEqual(state.fontPreference(), font);
      assert.deepEqual(state.appearancePreference(), before.appearancePreference);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.equal(restored.themePreference(), before.themePreference);
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), initialBounds);
    });
  });
});

async function withStateFixture(operation: (fixture: StateFixture) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-desktop-state-publication-")));
  const statePath = path.join(root, "desktop-state.json");
  try {
    const state = new DesktopStateStore(statePath);
    await state.load();
    // Persist the baseline before installing the one-shot I/O fault. No real
    // user state, global config, runtime, model transport or SQLite is involved.
    await state.setWindowBounds(initialBounds);
    await operation({ state, statePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withPublicationGate(
  statePath: string,
  failPublication: number | undefined,
  operation: (gate: PublicationGate) => Promise<void>
): Promise<void> {
  const originalRename = fs.rename;
  const entered = deferred();
  const released = deferred();
  const pending: Promise<unknown>[] = [];
  const failure = Object.assign(new Error("Injected desktop-state rename failure"), { code: "EIO" });
  let publications = 0;
  let failures = 0;
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    // Substitute only the actual publication I/O for this isolated fixture.
    // Neither product methods nor in-memory state are patched or inspected.
    if (args[0] === `${statePath}.tmp` && args[1] === statePath) {
      publications += 1;
      const publication = publications;
      if (publication === 1) {
        entered.resolve();
        await released.promise;
      }
      if (publication === failPublication) {
        failures += 1;
        throw failure;
      }
    }
    await originalRename(...args);
  };
  try {
    await operation({
      failure,
      start<T>(request: Promise<T>): Promise<T> {
        pending.push(request);
        // Attach immediately, before the fault is released; the assertions below
        // still observe the original rejection and require the exact error.
        void request.catch(() => undefined);
        return request;
      },
      async waitForFirstPublication(): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            entered.promise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error("Desktop state did not reach its publication boundary")), 5_000);
            })
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      },
      release: released.resolve,
      publicationCount: () => publications,
      failureCount: () => failures
    });
  } finally {
    released.resolve();
    // Keep the patch and fixture alive until every admitted public operation has
    // settled, even when an earlier assertion fails.
    await Promise.allSettled(pending);
    fs.rename = originalRename;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a successful theme publication excludes a later failed window-bounds save", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 2, async gate => {
      // Start both operations before the queue runs. The preference write must
      // retain its invocation-time non-preference snapshot, even though bounds
      // are changed in memory before its queued callback begins.
      const theme = gate.start(state.setThemePreference("dark"));
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      await gate.waitForFirstPublication();
      gate.release();
      await theme;
      await assert.rejects(bounds, error => error === gate.failure);

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.equal(state.themePreference(), "dark");
      assert.equal(state.settingsPreferences().revision, before.revision + 1);
      assert.deepEqual(state.fontPreference(), before.fontPreference);
      assert.deepEqual(state.appearancePreference(), before.appearancePreference);
      // Ordinary setters retain their existing eager in-memory semantics.
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
      assert.deepEqual(restored.windowBounds(), initialBounds,
        "the earlier successful theme save must not publish a later failed bounds update");
    });
  });
});

test("a successful sidebar publication excludes a later failed window-bounds save", async () => {
  await withStateFixture(async ({ state, statePath }) => {
    const before = state.settingsPreferences();
    await withPublicationGate(statePath, 2, async gate => {
      // Independent ordinary fields still use invocation-time snapshots. Moving
      // their snapshot into the queue would publish the later bounds too soon.
      const sidebar = gate.start(state.setSidebarWidth(320));
      const bounds = gate.start(state.setWindowBounds(changedBounds));
      await gate.waitForFirstPublication();
      gate.release();
      await sidebar;
      await assert.rejects(bounds, error => error === gate.failure);

      assert.equal(gate.failureCount(), 1);
      assert.equal(gate.publicationCount(), 2);
      assert.equal(state.sidebarWidth(), 320);
      assert.deepEqual(state.settingsPreferences(), before);
      // Failure rollback for ordinary setters is not part of this repair.
      assert.deepEqual(state.windowBounds(), changedBounds);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.equal(restored.sidebarWidth(), 320);
      assert.deepEqual(restored.settingsPreferences(), before);
      assert.deepEqual(restored.windowBounds(), initialBounds,
        "the earlier successful sidebar save must not publish a later failed bounds update");
    });
  });
});
