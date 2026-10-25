/** Portable actual-source closure proof. Copy into tests/ before use. Never imports product code. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

type Provider = "claude-code" | "openai-codex";
interface Catalog { loginProvider?: Provider; value: string; label: string; baseUrl: string }
interface Request { authRequestId: string; method: "paste-code" | "browser-callback" }
interface Result { handle: string; models: Array<{ id: string; displayName: string; supportsThinking: boolean }> }
interface Save { status: string; message?: string }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function between(text: string, from: string, until: string): string {
  assert.equal(text.split(from).length, 2, `unique start: ${from}`);
  const start = text.indexOf(from);
  const end = text.indexOf(until, start + from.length);
  assert.ok(end > start, `source end: ${until}`);
  return text.slice(start, end);
}
const source = readFileSync(new URL("../src/desktop/renderer/src/components/settings/ProviderSettings.tsx", import.meta.url), "utf8");
const closeSource = between(source, "  const cancelLoginRef = useRef<() => void>", "\n\n  // ── 测试连接");
const loginSource = between(source, "  const loginViewKey = catalog?.loginProvider", "\n  const usesOAuth = connection?.authMode");
const wrapped = `(function controls() {
type DesktopModelLoginProvider = "claude-code" | "openai-codex";
interface DesktopModelLoginStartResult { authRequestId: string; method: "paste-code" | "browser-callback" }
interface ProviderCatalogItem { loginProvider?: DesktopModelLoginProvider; value: string; label: string; baseUrl: string }
${closeSource}
${loginSource}
return { startLogin, submitLogin, completeLoginRequest, relogin,
  state: { stage: loginStage, error: loginError, request: loginRequest, code: authorizationCode },
  generation: loginGenerationRef.current, locked: loginActionRef.current };
})()`;
interface Controls {
  startLogin(catalog: Catalog): Promise<void>;
  submitLogin(catalog: Catalog): Promise<void>;
  completeLoginRequest(catalog: Catalog, request: Request, code?: string): Promise<void>;
  relogin(catalog: Catalog): void;
  state: { stage: string; error?: string; request?: Request; code: string };
  generation: number;
  locked: boolean;
}
interface EffectSlot { kind: "layout" | "passive"; deps: unknown[]; effect(): void | (() => void); cleanup?: () => void }
interface MemoSlot<T> { deps: unknown[]; value: T }
const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const claude: Catalog = { loginProvider: "claude-code", value: "claude", label: "Claude", baseUrl: "synthetic" };
const request = (id: string, method: Request["method"] = "paste-code"): Request => ({ authRequestId: id, method });
const result = (id: string): Result => ({ handle: `opaque-${id}`, models: [] });

function fixture() {
  const slots: unknown[] = [];
  const effectSlots = new Set<EffectSlot>();
  let pending: EffectSlot[] = [];
  let cursor = 0;
  let controls!: Controls;
  let writes = 0;
  const starts: Array<{ provider: Provider; gate: Deferred<Request> }> = [];
  const completions: Array<{ provider: Provider; id: string; gate: Deferred<Result> }> = [];
  const cancels: Array<{ provider: Provider; id: string }> = [];
  const adds: string[] = [];
  const releases: string[] = [];
  const saves: Array<{ input: unknown; gate: Deferred<Save> }> = [];
  const notices: string[] = [];
  const activeKeys: string[] = [];
  function useState<T>(initial?: T): [T, (next: T | ((old: T) => T)) => void] {
    const i = cursor++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i] as T, next => { writes++; slots[i] = typeof next === "function" ? (next as (old: T) => T)(slots[i] as T) : next; }];
  }
  function useRef<T>(initial: T): { current: T } {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: initial };
    return slots[i] as { current: T };
  }
  function useCallback<T>(value: T, deps: unknown[]): T {
    const i = cursor++;
    const old = slots[i] as MemoSlot<T> | undefined;
    if (old && same(old.deps, deps)) return old.value;
    slots[i] = { value, deps } satisfies MemoSlot<T>;
    return value;
  }
  function effect(kind: EffectSlot["kind"], body: EffectSlot["effect"], deps: unknown[]): void {
    const i = cursor++;
    const old = slots[i] as EffectSlot | undefined;
    if (old && same(old.deps, deps)) return;
    const next: EffectSlot = { kind, deps, effect: body };
    if (old) { next.cleanup = old.cleanup; effectSlots.delete(old); }
    slots[i] = next; effectSlots.add(next); pending.push(next);
  }
  const dependencies = {
    useState, useRef, useCallback,
    useEffect: (body: EffectSlot["effect"], deps: unknown[]) => effect("passive", body, deps),
    useLayoutEffect: (body: EffectSlot["effect"], deps: unknown[]) => effect("layout", body, deps),
    catalog: claude, providerAlias: "claude", active: true, defaultModelAlias: "existing-default",
    setActiveKey: (key: string): void => { activeKeys.push(key); },
    providerAliasFor: (catalog: Catalog): string => catalog.value,
    modelAliasFor: (alias: string, model: string): string => `${alias}-${model}`,
    onNotify: (message: string): void => { notices.push(message); },
    onStartLogin: async (provider: Provider): Promise<Request> => {
      const gate = deferred<Request>(); starts.push({ provider, gate }); return await gate.promise;
    },
    onCompleteLogin: async (provider: Provider, id: string): Promise<Result> => {
      const gate = deferred<Result>(); completions.push({ provider, id, gate }); return await gate.promise;
    },
    onCancelLogin: async (provider: Provider, id: string): Promise<void> => { cancels.push({ provider, id }); },
    settingsDraft: {
      addOauthCredentialHandle: (handle: string): void => { adds.push(handle); },
      releaseCredential: async (handle: string): Promise<void> => { releases.push(handle); },
      saveModels: async (input: unknown): Promise<Save> => {
        const gate = deferred<Save>(); saves.push({ input, gate }); return await gate.promise;
      }
    }
  };
  const factory = new Function(...Object.keys(dependencies), `return ${stripTypeScriptTypes(wrapped, { mode: "strip" })}`) as (...args: unknown[]) => Controls;
  function render(): Controls { cursor = 0; controls = factory(...Object.values(dependencies)); return controls; }
  function flush(kind: EffectSlot["kind"]): void {
    const batch = pending.filter(slot => slot.kind === kind);
    pending = pending.filter(slot => slot.kind !== kind);
    for (const slot of batch) { slot.cleanup?.(); const cleanup = slot.effect(); slot.cleanup = cleanup || undefined; }
  }
  function rerender(): Controls { render(); flush("layout"); flush("passive"); return render(); }
  function cleanup(kind: EffectSlot["kind"]): void {
    for (const slot of effectSlots) if (slot.kind === kind) { slot.cleanup?.(); slot.cleanup = undefined; }
  }
  function unmount(): void { cleanup("layout"); cleanup("passive"); }
  function replay(): void {
    unmount();
    for (const kind of ["layout", "passive"] as const) for (const slot of effectSlots) if (slot.kind === kind) {
      const cleanup = slot.effect(); slot.cleanup = cleanup || undefined;
    }
  }
  rerender();
  return { get controls() { return controls; }, render, rerender, cleanup, unmount, replay,
    starts, completions, cancels, adds, releases, saves, notices, activeKeys, get writes() { return writes; } };
}
async function turns(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function noSave(h: ReturnType<typeof fixture>): void { assert.deepEqual([...h.adds], []); assert.deepEqual([...h.saves], []); assert.deepEqual([...h.notices], []); }

test("actual source has conditional model tab and keyed scope, not a retained model tab", () => {
  const overlay = readFileSync(new URL("../src/desktop/renderer/src/components/settings/SettingsOverlay.tsx", import.meta.url), "utf8");
  assert.match(overlay, /<SettingsDraftProvider\s+key=\{scope\}/u);
  assert.match(overlay, /\{activeTab === "模型" \? <ProviderSettings/u);
  const navigation = between(overlay, "  const selectTab = async", "  const discardAndClose");
  assert.match(navigation, /flushModelEdits/u);
  assert.doesNotMatch(navigation, /[Cc]ancel.*Login/u);
});
test("committed unmount retires generation before passive cleanup", () => {
  const h = fixture(); const before = h.controls.generation; h.cleanup("layout");
  assert.ok(h.render().generation > before); assert.deepEqual(h.cancels, []);
});
for (const method of ["paste-code", "browser-callback"] as const) {
  test(`late ${method} start after unmount cancels returned request without completing`, async () => {
    const h = fixture(); const task = h.controls.startLogin(claude); h.cleanup("layout"); const writes = h.writes;
    h.starts[0]!.gate.resolve(request("old", method)); await task;
    assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "old" }]);
    assert.deepEqual(h.completions, []); noSave(h); assert.equal(h.writes, writes);
  });
}
test("late start rejection after unmount has no UI writes", async () => {
  const h = fixture(); const task = h.controls.startLogin(claude); h.cleanup("layout"); const writes = h.writes;
  h.starts[0]!.gate.reject(new Error("synthetic")); await task;
  assert.equal(h.writes, writes); assert.deepEqual(h.cancels, []); noSave(h);
});
test("waiting paste request is cancelled once by cleanup", async () => {
  const h = fixture(); const task = h.controls.startLogin(claude);
  h.starts[0]!.gate.resolve(request("old")); await task; h.unmount(); h.unmount();
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "old" }]); noSave(h);
});
test("late completion after unmount releases only returned handle and does not save", async () => {
  const h = fixture(); const started = h.controls.startLogin(claude);
  h.starts[0]!.gate.resolve(request("old")); await started;
  const completed = h.controls.completeLoginRequest(claude, request("old")); h.cleanup("layout"); const writes = h.writes;
  h.completions[0]!.gate.resolve(result("old")); await turns();
  assert.deepEqual(h.releases, ["opaque-old"]); noSave(h); await completed; assert.equal(h.writes, writes);
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "old" }]);
});
test("late completion rejection after cleanup does not restore old state", async () => {
  const h = fixture(); const task = h.controls.completeLoginRequest(claude, request("old")); h.cleanup("layout"); const writes = h.writes;
  h.completions[0]!.gate.reject(new Error("synthetic")); await task;
  assert.equal(h.writes, writes); assert.deepEqual(h.releases, []); noSave(h);
});
test("already admitted save finishes without cancellation or rollback of save", async () => {
  const h = fixture(); const task = h.controls.completeLoginRequest(claude, request("old"));
  h.completions[0]!.gate.resolve(result("old")); await turns(); assert.equal(h.saves.length, 1);
  const input = h.saves[0]!.input; h.cleanup("layout"); const writes = h.writes;
  h.saves[0]!.gate.resolve({ status: "committed" }); await task;
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0]!.input, input);
  assert.deepEqual(h.releases, ["opaque-old"]); assert.deepEqual(h.notices, []);
  assert.deepEqual(h.activeKeys, []); assert.equal(h.writes, writes);
});
test("ordinary same-props rerender preserves pending start and waiting ownership", async () => {
  const h = fixture(); const initial = h.controls.generation; const task = h.controls.startLogin(claude);
  assert.equal(h.rerender().generation, initial); assert.deepEqual([...h.cancels], []);
  h.starts[0]!.gate.resolve(request("current")); await task;
  assert.equal(h.rerender().state.request?.authRequestId, "current"); assert.deepEqual([...h.cancels], []);
  assert.equal(h.controls.locked, true); h.unmount();
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "current" }]);
});
test("StrictMode-shaped setup-cleanup-setup leaves a fresh unlocked login usable", async () => {
  const h = fixture(); h.replay(); assert.deepEqual(h.cancels, []);
  const view = h.rerender(); assert.equal(view.locked, false); assert.equal(view.state.stage, "idle");
  const task = view.startLogin(claude); h.starts[0]!.gate.resolve(request("fresh")); await task;
  assert.equal(h.rerender().state.request?.authRequestId, "fresh"); assert.equal(h.controls.locked, true);
  assert.deepEqual([...h.cancels], []); h.unmount();
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "fresh" }]);
});
test("cleanup replay retires a pending attempt without releasing its replacement lock", async () => {
  const h = fixture(); const old = h.controls.startLogin(claude); h.replay();
  const current = h.rerender().startLogin(claude); h.starts[0]!.gate.reject(new Error("old")); await old;
  assert.equal(h.rerender().locked, true); assert.equal(h.controls.state.stage, "opening");
  assert.equal(h.controls.state.error, undefined);
  h.starts[1]!.gate.resolve(request("replacement")); await current;
  assert.equal(h.rerender().state.request?.authRequestId, "replacement"); h.unmount();
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "replacement" }]);
});
test("returning to model tab creates an independent owner; old completion cannot save", async () => {
  const old = fixture(); const completed = old.controls.completeLoginRequest(claude, request("old")); old.cleanup("layout");
  const next = fixture(); const started = next.controls.startLogin(claude);
  old.completions[0]!.gate.resolve(result("old")); await turns();
  assert.deepEqual(old.releases, ["opaque-old"]); noSave(old); await completed;
  assert.equal(next.rerender().locked, true); assert.equal(next.controls.state.stage, "opening");
  next.starts[0]!.gate.resolve(request("new")); await started;
  assert.equal(next.rerender().state.request?.authRequestId, "new"); next.unmount();
});
test("current completion still saves, releases and reports success", async () => {
  const h = fixture(); const task = h.controls.completeLoginRequest(claude, request("current"));
  h.completions[0]!.gate.resolve(result("current")); await turns();
  assert.deepEqual(h.adds, ["opaque-current"]); assert.equal(h.saves.length, 1);
  h.saves[0]!.gate.resolve({ status: "committed" }); await task;
  assert.deepEqual(h.releases, ["opaque-current"]); assert.equal(h.notices.length, 1);
  assert.deepEqual(h.activeKeys, ["provider:claude"]);
});
test("current start failure is visible and unlocks retry", async () => {
  const h = fixture(); const task = h.controls.startLogin(claude);
  h.starts[0]!.gate.reject(new Error("synthetic")); await task;
  const view = h.rerender(); assert.equal(view.state.error, "synthetic"); assert.equal(view.locked, false);
  const retry = view.startLogin(claude); h.starts[1]!.gate.resolve(request("retry")); await retry;
  assert.equal(h.rerender().state.request?.authRequestId, "retry"); h.unmount();
});
