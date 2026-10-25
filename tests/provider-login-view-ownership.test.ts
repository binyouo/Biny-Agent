/** Inert source-closure proof only: no React, product imports, IPC, auth or timers. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

type Provider = "claude-code" | "openai-codex";
interface Catalog { id: string; value: string; label: string; baseUrl: string; loginProvider?: Provider }
interface Request { authRequestId: string; method: "paste-code" | "browser-callback" }
interface Result { handle: string; models: Array<{ id: string; displayName: string; supportsThinking: boolean }> }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = readFileSync(new URL("../src/desktop/renderer/src/components/settings/ProviderSettings.tsx", import.meta.url), "utf8");
function between(text: string, from: string, until: string): string {
  assert.equal(text.split(from).length, 2, `unique source anchor: ${from}`);
  const start = text.indexOf(from);
  const end = text.indexOf(until, start + from.length);
  assert.ok(end > start, `source end: ${until}`);
  return text.slice(start, end);
}
const loginSource = between(source, "  // ── 订阅登录 ──", "  const usesOAuth =");
const selectionSource = between(source, "  const selectProvider = async", "\n\n  // ── 模型开关");
const closeSource = between(source, "  useEffect(() => {\n    // 设置面板整体关闭时放弃未完成的登录请求。", "\n\n  // ── 测试连接");
const definitions = `
type DesktopModelLoginProvider = "claude-code" | "openai-codex";
interface DesktopModelLoginStartResult { authRequestId: string; method: "paste-code" | "browser-callback" }
interface ProviderCatalogItem { id: string; value: string; label: string; baseUrl: string; loginProvider?: DesktopModelLoginProvider }
${closeSource}
${selectionSource}
${loginSource}
return { startLogin, submitLogin, relogin, resetLogin, selectProvider, setAuthorizationCode,
  state: { stage: loginStage, request: loginRequest, error: loginError, code: authorizationCode },
  refs: { request: loginRequestRef, provider: loginProviderRef, action: loginActionRef, generation: loginGenerationRef } };
`;
interface Ref<T> { current: T }
interface Controls {
  startLogin(entry: Catalog): Promise<void>;
  submitLogin(entry: Catalog): Promise<void>;
  relogin(entry: Catalog): void;
  resetLogin(cancel: boolean): void;
  selectProvider(key: string): Promise<void>;
  setAuthorizationCode(value: string): void;
  state: { stage: string; request?: Request; error?: string; code: string };
  refs: { request: Ref<Request | undefined>; provider: Ref<Provider | undefined>; action: Ref<boolean>; generation: Ref<number> };
}
type DependencyList = readonly unknown[];
interface EffectSlot { deps: DependencyList; cleanup?: () => void }
interface CallbackSlot<T> { deps: DependencyList; value: T }
function sameDeps(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
}

const claude: Catalog = { id: "claude-code", value: "claude-subscription", label: "Claude", baseUrl: "synthetic-claude", loginProvider: "claude-code" };
const codex: Catalog = { id: "openai-codex", value: "openai-codex", label: "Codex", baseUrl: "synthetic-codex", loginProvider: "openai-codex" };
const api: Catalog = { id: "api", value: "api", label: "API", baseUrl: "synthetic-api" };
interface Entry { key: string; catalog: Catalog; alias: string }
const entries: Entry[] = [
  { key: "claude-code", catalog: claude, alias: "claude-subscription" },
  { key: "provider:claude-subscription", catalog: claude, alias: "claude-subscription" },
  { key: "claude-second-alias", catalog: claude, alias: "claude-second-alias" },
  { key: "openai-codex", catalog: codex, alias: "openai-codex" },
  { key: "api", catalog: api, alias: "api" }
];
const paste = (id: string): Request => ({ authRequestId: id, method: "paste-code" });
const callback = (id: string): Request => ({ authRequestId: id, method: "browser-callback" });
const completed = (id: string): Result => ({ handle: `synthetic-handle-${id}`, models: [] });

function harness() {
  const slots: unknown[] = [];
  let workingSlots: unknown[] = [];
  let cursor = 0;
  let dirty = false;
  let layouts: Array<() => void> = [];
  let effects: Array<() => void> = [];
  let activeKey: string | undefined = "claude-code";
  let fallback = entries[0]!;
  let active = true;
  let flush: () => Promise<boolean> = async () => true;
  let flushCalls = 0;
  const starts: Array<{ provider: Provider; gate: Deferred<Request> }> = [];
  const completions: Array<{ provider: Provider; id: string; code?: string; gate: Deferred<Result> }> = [];
  const cancels: Array<{ provider: Provider; id: string }> = [];
  const saves: Array<{ input: unknown; gate: Deferred<{ status: string }> }> = [];
  const released: string[] = [];
  const added: string[] = [];
  const notices: string[] = [];
  const paints: Array<{ key?: string; state: Controls["state"] }> = [];
  const cancelLoginRef: Ref<() => void> = { current: () => {} };
  function useState<T>(initial?: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
    const index = cursor++;
    if (!(index in workingSlots)) workingSlots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [workingSlots[index] as T, value => {
      const next = typeof value === "function" ? (value as (current: T) => T)(slots[index] as T) : value;
      if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; }
    }];
  }
  function useRef<T>(initial: T): Ref<T> {
    const index = cursor++;
    if (!(index in workingSlots)) workingSlots[index] = { current: initial };
    return workingSlots[index] as Ref<T>;
  }
  function useCallback<T>(value: T, deps: DependencyList): T {
    const index = cursor++;
    const previous = workingSlots[index] as CallbackSlot<T> | undefined;
    if (previous && sameDeps(previous.deps, deps)) return previous.value;
    workingSlots[index] = { deps, value } satisfies CallbackSlot<T>;
    return value;
  }
  function registerEffect(effect: () => void | (() => void), deps: DependencyList, queue: Array<() => void>): void {
    const index = cursor++;
    const previous = workingSlots[index] as EffectSlot | undefined;
    if (previous && sameDeps(previous.deps, deps)) return;
    const next: EffectSlot = { deps };
    workingSlots[index] = next;
    queue.push(() => { previous?.cleanup?.(); const cleanup = effect(); if (cleanup) next.cleanup = cleanup; });
  }
  const stable = {
    useState, useRef, useCallback,
    useEffect: (effect: () => void | (() => void), deps: DependencyList) => registerEffect(effect, deps, effects),
    useLayoutEffect: (effect: () => void | (() => void), deps: DependencyList) => registerEffect(effect, deps, layouts),
    cancelLoginRef,
    flushEditorRef: { current: async () => { flushCalls++; return await flush(); } },
    setActiveKey: (key: string | undefined) => { activeKey = key; dirty = true; },
    defaultModelAlias: "existing-default",
    providerAliasFor: (entry: Catalog) => entry.value,
    modelAliasFor: (alias: string, model: string) => `${alias}-${model}`,
    onNotify: (message: string) => { notices.push(message); },
    onCancelLogin: async (provider: Provider, id: string) => { cancels.push({ provider, id }); },
    onStartLogin: async (provider: Provider) => {
      const gate = deferred<Request>(); starts.push({ provider, gate }); return await gate.promise;
    },
    onCompleteLogin: async (provider: Provider, id: string, code?: string) => {
      const gate = deferred<Result>(); completions.push({ provider, id, code, gate }); return await gate.promise;
    },
    settingsDraft: {
      addOauthCredentialHandle: (handle: string) => { added.push(handle); },
      releaseCredential: async (handle: string) => { released.push(handle); },
      saveModels: async (input: unknown) => { const gate = deferred<{ status: string }>(); saves.push({ input, gate }); return await gate.promise; }
    }
  };
  const names = [...Object.keys(stable), "active", "activeKey", "activeEntry", "catalog", "providerAlias"];
  // Strip a complete expression, never a fragment containing a top-level return.
  // Explicit fake dependency parameters remain the only operation bindings.
  const wrapped = `(function extractedLoginControls() {\n${definitions}\n})()`;
  const factory = new Function(...names, `return ${stripTypeScriptTypes(wrapped, { mode: "strip" })}`) as (...values: unknown[]) => Controls;
  let current!: Controls;
  function render(): Controls {
    let remaining = 12;
    const pendingEffects: Array<() => void> = [];
    do {
      assert.ok(remaining-- > 0, "synthetic render settles");
      dirty = false; cursor = 0; layouts = []; effects = [];
      workingSlots = slots.slice();
      const entry = entries.find(item => item.key === activeKey) ?? fallback;
      current = factory(...Object.values(stable), active, activeKey, entry, entry.catalog, entry.alias);
      slots.splice(0, slots.length, ...workingSlots);
      pendingEffects.push(...effects);
      for (const effect of layouts) effect();
      // A layout update must settle before recording the visible commit. A passive-only
      // reset would expose the previous request here and fail the paint assertion.
      if (dirty) continue;
      paints.push({ key: activeKey, state: current.state });
      for (const effect of pendingEffects.splice(0)) effect();
    } while (dirty);
    return current;
  }
  render();
  return {
    render, starts, completions, cancels, saves, released, added, notices, paints,
    get controls() { return current; }, get key() { return activeKey; }, get flushCalls() { return flushCalls; },
    setFlush(next: () => Promise<boolean>) { flush = next; },
    setFallback(entry: Entry) { activeKey = undefined; fallback = entry; render(); },
    setActive(value: boolean) { active = value; render(); },
    discardRender(key: string) {
      cursor = 0; layouts = []; effects = []; workingSlots = slots.slice();
      const entry = entries.find(item => item.key === key)!;
      factory(...Object.values(stable), active, key, entry, entry.catalog, entry.alias);
      // Deliberately do not commit working slots or invoke effect callbacks.
      layouts = []; effects = [];
    },
    async choose(key: string) { await current.selectProvider(key); render(); },
    async start(entry = claude, request = paste("A")) {
      const pending = current.startLogin(entry); starts.at(-1)!.gate.resolve(request); await pending; render();
    }
  };
}

test("binding: effective entry may change independently of activeKey, while selection awaits successful flush", () => {
  assert.match(source, /const activeEntry = entries\.find\(\(row\) => row\.key === activeKey\) \?\? entries\[0\];/u);
  assert.match(selectionSource, /if \(key === activeEntry\?\.key\) return;/u);
  assert.match(selectionSource, /if \(await flushEditorRef\.current\(\)\) setActiveKey\(key\);/u);
  assert.match(source, /stage=\{loginStage\}[\s\S]*?loginRequest=\{loginRequest\}[\s\S]*?authorizationCode=\{authorizationCode\}/u);
});

test("waiting paste request is retired before the new provider's committed view", async () => {
  const h = harness(); await h.start(); h.controls.setAuthorizationCode("synthetic-code"); h.render();
  await h.choose("openai-codex");
  assert.deepEqual(h.controls.state, { stage: "idle", request: undefined, error: undefined, code: "" });
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "A" }]);
  assert.ok(h.paints.filter(paint => paint.key === "openai-codex").every(paint => paint.state.stage === "idle" && paint.state.request === undefined && paint.state.code === ""));
  const invalidSubmit = h.controls.submitLogin(codex);
  assert.equal(h.completions.length, 0); await invalidSubmit;
});

test("discarded alternate-provider render does not mutate committed ownership or cancel login", async () => {
  const h = harness(); await h.start();
  const generation = h.controls.refs.generation.current;
  h.discardRender("openai-codex");
  assert.equal(h.cancels.length, 0); assert.equal(h.controls.refs.generation.current, generation);
  h.render(); assert.equal(h.controls.state.request?.authRequestId, "A");
  await h.choose("openai-codex"); assert.equal(h.cancels.length, 1);
});

test("submit requires the live request identity AND matching provider", async () => {
  const h = harness(); await h.start();
  const stale = h.controls.submitLogin;
  const mismatched = h.controls.submitLogin(codex);
  assert.equal(h.completions.length, 0); await mismatched;
  await h.choose("openai-codex"); await h.choose("claude-code");
  await h.start(claude, paste("B")); const staleSubmit = stale(claude);
  assert.equal(h.completions.length, 0, "same-provider ABA cannot revive an old submit closure");
  await staleSubmit;
  const valid = h.controls.submitLogin(claude);
  assert.equal(h.completions.length, 1); assert.equal(h.completions[0]!.id, "B");
  h.completions[0]!.gate.reject(new Error("synthetic failure")); await valid;
});

test("same row, failed flush, rejected flush and deferred flush preserve current login", async () => {
  const h = harness(); await h.start();
  await h.choose("claude-code"); assert.equal(h.flushCalls, 0);
  h.setFlush(async () => false); await h.choose("openai-codex");
  h.setFlush(async () => { throw new Error("synthetic flush failure"); });
  await assert.rejects(h.choose("openai-codex"), /synthetic flush failure/u);
  const gate = deferred<boolean>(); h.setFlush(() => gate.promise);
  const choosing = h.choose("openai-codex"); h.render();
  assert.equal(h.controls.state.request?.authRequestId, "A"); assert.equal(h.cancels.length, 0);
  gate.resolve(true); await choosing; assert.equal(h.cancels.length, 1);
});

test("row normalization keeps same login card; a different alias of same provider retires it", async () => {
  const h = harness(); await h.start();
  await h.choose("provider:claude-subscription"); assert.equal(h.cancels.length, 0);
  assert.equal(h.controls.state.request?.authRequestId, "A");
  await h.choose("claude-second-alias"); assert.equal(h.cancels.length, 1);
  assert.equal(h.controls.state.stage, "idle");
});

test("implicit effective fallback and leaving for an API card retire login", async () => {
  const h = harness(); await h.start();
  h.setFallback(entries.find(entry => entry.key === "openai-codex")!);
  assert.equal(h.controls.state.stage, "idle"); assert.equal(h.cancels.length, 1);
  await h.choose("claude-code"); await h.start(claude, paste("B"));
  await h.choose("api"); assert.equal(h.controls.state.stage, "idle"); assert.equal(h.cancels.length, 2);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`opening request ${outcome} after switch cannot overwrite next opening state`, async () => {
    const h = harness(); const old = h.controls.startLogin(claude);
    await h.choose("openai-codex"); const next = h.controls.startLogin(codex); h.render();
    if (outcome === "resolve") h.starts[0]!.gate.resolve(paste("A"));
    else h.starts[0]!.gate.reject(new Error("old failure"));
    await old; h.render();
    assert.equal(h.controls.state.stage, "opening"); assert.equal(h.controls.state.error, undefined);
    assert.equal(h.controls.refs.action.current, true);
    assert.deepEqual(h.cancels, outcome === "resolve" ? [{ provider: "claude-code", id: "A" }] : []);
    h.starts[1]!.gate.resolve(callback("B")); await next; h.render();
    assert.equal(h.completions.length, 1); assert.equal(h.completions[0]!.provider, "openai-codex");
    h.completions[0]!.gate.reject(new Error("synthetic final failure")); await Promise.resolve(); await Promise.resolve(); h.render();
  });
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`browser completion ${outcome} after switching does not change the new view`, async () => {
    const h = harness(); await h.choose("openai-codex"); await h.start(codex, callback("A"));
    await h.choose("claude-code"); await h.start(claude, paste("B"));
    if (outcome === "resolve") h.completions[0]!.gate.resolve(completed("A"));
    else h.completions[0]!.gate.reject(new Error("old completion failure"));
    await Promise.resolve(); await Promise.resolve(); h.render();
    assert.equal(h.controls.state.request?.authRequestId, "B"); assert.equal(h.controls.state.stage, "waiting");
    assert.equal(h.controls.state.error, undefined); assert.equal(h.saves.length, 0); assert.equal(h.notices.length, 0);
    assert.deepEqual(h.cancels, [{ provider: "openai-codex", id: "A" }]);
  });
}

test("already admitted save is not rolled back but its completion cannot redirect the new view", async () => {
  const h = harness(); await h.start(); const pending = h.controls.submitLogin(claude);
  h.completions[0]!.gate.resolve(completed("A")); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.saves.length, 1);
  await h.choose("openai-codex"); h.saves[0]!.gate.resolve({ status: "committed" }); await pending; h.render();
  assert.equal(h.key, "openai-codex"); assert.equal(h.controls.state.stage, "idle");
  assert.deepEqual(h.released, ["synthetic-handle-A"]); assert.equal(h.notices.length, 0);
});

test("successful completion resets without cancellation before selecting its normalized configured row", async () => {
  const h = harness(); await h.start(); const pending = h.controls.submitLogin(claude);
  h.completions[0]!.gate.resolve(completed("A")); await Promise.resolve(); await Promise.resolve();
  h.saves[0]!.gate.resolve({ status: "committed" }); await pending; h.render();
  assert.equal(h.key, "provider:claude-subscription"); assert.equal(h.controls.state.stage, "idle");
  assert.equal(h.cancels.length, 0); assert.equal(h.notices.length, 1);
});

test("settings close and explicit relogin retain existing cancellation semantics", async () => {
  const h = harness(); await h.start(); h.setActive(false);
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "A" }]);
  h.setActive(true); await h.start(claude, paste("B")); h.controls.relogin(claude);
  assert.deepEqual(h.cancels[1], { provider: "claude-code", id: "B" });
  assert.equal(h.starts.length, 3); h.starts[2]!.gate.reject(new Error("synthetic restart failure"));
  await Promise.resolve(); await Promise.resolve(); h.render();
});
