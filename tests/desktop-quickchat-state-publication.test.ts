import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import type { DesktopQuickChatSettings } from "../src/desktop/protocol.js";

const initial: DesktopQuickChatSettings = {
  autoHideOnBlur: false, injectScreenContext: false, clickThrough: false
};
const changed: DesktopQuickChatSettings = {
  autoHideOnBlur: true, injectScreenContext: true, clickThrough: true
};
const other: DesktopQuickChatSettings = {
  autoHideOnBlur: false, injectScreenContext: false, clickThrough: true
};

for (const writer of ["ordinary", "preferences", "quickchat"] as const) {
  for (const quickFirst of [true, false]) {
    for (const failAt of [0, 1, 2]) {
      test(`${writer}, QuickChat ${quickFirst ? "first" : "second"}, failure ${failAt}`, async () => {
        await withFixture(async (state, statePath) => {
          const before = state.settingsPreferences();
          await withGate(statePath, failAt, async gate => {
            const quick = () => state.setQuickChatSettings(changed);
            const companion = () => writer === "ordinary"
              ? state.setSidebarWidth(320)
              : writer === "preferences" ? state.setThemePreference("dark")
                : state.setQuickChatSettings(other);
            const first = gate.start(quickFirst ? quick() : companion());
            await gate.entered();
            const second = gate.start(quickFirst ? companion() : quick());
            gate.release();
            for (const [index, pending] of [first, second].entries()) {
              if (index + 1 === failAt) await assert.rejects(pending, error => error === gate.failure);
              else await pending;
            }
            let expected = initial;
            const quickIndex = quickFirst ? 1 : 2;
            const companionIndex = quickFirst ? 2 : 1;
            for (const index of [1, 2]) {
              if (index === failAt) continue;
              if (index === quickIndex) expected = changed;
              else if (writer === "quickchat") expected = other;
            }
            const restored = new DesktopStateStore(statePath);
            await restored.load();
            assert.deepEqual(state.quickChatSettings(), expected);
            assert.deepEqual(restored.quickChatSettings(), expected);
            if (writer === "preferences") {
              assert.equal(state.themePreference(), companionIndex === failAt ? before.themePreference : "dark");
              assert.equal(state.settingsPreferences().revision, before.revision + (companionIndex === failAt ? 0 : 1));
            }
            assert.deepEqual(restored.settingsPreferences(), state.settingsPreferences());
            if (writer === "ordinary" && companionIndex !== failAt) assert.equal(restored.sidebarWidth(), 320);
          });
        });
      });
    }
  }
}

test("pending QuickChat publication stays invisible until rename succeeds", async () => {
  await withFixture(async (state, statePath) => {
    await withGate(statePath, 0, async gate => {
      const request = gate.start(state.setQuickChatSettings(changed));
      await gate.entered();
      assert.deepEqual(state.quickChatSettings(), initial);
      gate.release();
      await request;
      assert.deepEqual(state.quickChatSettings(), changed);
    });
  });
});

test("failed QuickChat opt-in preserves bytes and cannot leak through a later ordinary save; retry succeeds", async () => {
  await withFixture(async (state, statePath) => {
    const bytes = await fs.readFile(statePath);
    await withGate(statePath, 1, async gate => {
      const request = gate.start(state.setQuickChatSettings(changed));
      await gate.entered();
      gate.release();
      await assert.rejects(request, error => error === gate.failure);
    });
    assert.deepEqual(await fs.readFile(statePath), bytes);
    assert.deepEqual(state.quickChatSettings(), initial);
    await state.setSidebarWidth(310);
    const restored = new DesktopStateStore(statePath);
    await restored.load();
    assert.deepEqual(restored.quickChatSettings(), initial);
    await state.setQuickChatSettings(changed);
    await restored.load();
    assert.deepEqual(restored.quickChatSettings(), changed);
  });
});

test("QuickChat preserves invocation-time ordinary fields and captures the complete settings replacement", async () => {
  await withFixture(async (state, statePath) => {
    const width = state.sidebarWidth();
    await withGate(statePath, 2, async gate => {
      const input = { ...changed };
      const quick = gate.start(state.setQuickChatSettings(input));
      input.clickThrough = false;
      const ordinary = gate.start(state.setSidebarWidth(330));
      await gate.entered();
      gate.release();
      await quick;
      await assert.rejects(ordinary, error => error === gate.failure);
      const restored = new DesktopStateStore(statePath);
      await restored.load();
      assert.equal(restored.sidebarWidth(), width, "earlier QuickChat write must not persist a later failed width change");
      assert.deepEqual(restored.quickChatSettings(), changed);
      assert.deepEqual(state.quickChatSettings(), changed);
    });
    await state.setQuickChatSettings(initial);
    assert.deepEqual(state.quickChatSettings(), initial, "API replaces the whole settings object");
  });
});

async function withFixture(operation: (state: DesktopStateStore, statePath: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickchat-publication-"));
  try {
    const statePath = path.join(root, "desktop-state.json");
    const state = new DesktopStateStore(statePath);
    await state.setQuickChatSettings(initial);
    await operation(state, statePath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

interface Gate {
  failure: Error;
  start<T>(request: Promise<T>): Promise<T>;
  entered(): Promise<void>;
  release(): void;
}

async function withGate(statePath: string, failAt: number, operation: (gate: Gate) => Promise<void>): Promise<void> {
  const originalRename = fs.rename;
  const entered = deferred();
  const released = deferred();
  const pending: Promise<unknown>[] = [];
  const failure = Object.assign(new Error("Synthetic publication failure"), { code: "EIO" });
  let count = 0;
  fs.rename = async (...args: Parameters<typeof fs.rename>) => {
    if (args[0] === `${statePath}.tmp` && args[1] === statePath) {
      count += 1;
      if (count === 1) {
        entered.resolve();
        await released.promise;
      }
      if (count === failAt) throw failure;
    }
    await originalRename(...args);
  };
  try {
    await operation({
      failure,
      start<T>(request: Promise<T>): Promise<T> {
        pending.push(request);
        void request.catch(() => undefined);
        return request;
      },
      async entered(): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([entered.promise, new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Publication boundary not reached")), 5_000);
          })]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      },
      release: released.resolve
    });
  } finally {
    released.resolve();
    await Promise.allSettled(pending);
    fs.rename = originalRename;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
