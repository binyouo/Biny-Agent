import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

type Provider = "claude-code" | "openai-codex";
interface Catalog { loginProvider?: Provider }
interface Request { authRequestId: string; method: "paste-code" | "browser-callback" }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const component = readFileSync(new URL("../src/desktop/renderer/src/components/settings/ProviderSettings.tsx", import.meta.url), "utf8");
function sliceBetween(source: string, start: string, end: string): string {
  assert.equal(source.split(start).length, 2, `unique source start: ${start}`);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `source end: ${end}`);
  return source.slice(from, to);
}
const resetSource = sliceBetween(component, "  const resetLogin = useCallback(", "  useEffect(() => {\n    cancelLoginRef.current");
const startSource = sliceBetween(component, "  const startLogin = useCallback(", "  const submitLogin = useCallback(");
const closeSource = sliceBetween(component, "  useEffect(() => {\n    // 设置面板整体关闭时放弃未完成的登录请求。", "\n\n  // ── 测试连接");

interface Ref<T> { current: T }
interface Controls {
  startLogin(entry: Catalog): Promise<void>;
  resetLogin(notifyCancel: boolean): void;
  closeEffect(): void;
}
interface Dependencies {
  useCallback<T>(callback: T, dependencies: unknown[]): T;
  loginGenerationRef: Ref<number>;
  loginActionRef: Ref<boolean>;
  loginRequestRef: Ref<Request | undefined>;
  loginProviderRef: Ref<Provider | undefined>;
  onCancelLoginRef: Ref<(provider: Provider, id: string) => Promise<void>>;
  setLoginRequest(value: Request | undefined): void;
  setLoginStage(value: string): void;
  setLoginError(value: string | undefined): void;
  setAuthorizationCode(value: string): void;
  onStartLogin(provider: Provider): Promise<Request>;
  completeLoginRequest(catalog: Catalog, request: Request): Promise<void>;
}

// Execute only these extracted renderer closures. No imports survive extraction;
// every external callback is an inert recorder supplied below.
const definitions = `(function () {
type DesktopModelLoginProvider = "claude-code" | "openai-codex";
interface ProviderCatalogItem { loginProvider?: DesktopModelLoginProvider }
${resetSource}
${startSource}
let closeEffect = () => {};
const useEffect = (effect: () => void, _deps: unknown[]) => { closeEffect = effect; };
const active = false;
const cancelLoginRef = { current: () => resetLogin(true) };
${closeSource}
return { startLogin, resetLogin, closeEffect };
})()`;
function fixture() {
  const stage = { value: "idle" };
  const error: { value: string | undefined } = { value: undefined };
  const request: { value: Request | undefined } = { value: undefined };
  const code = { value: "synthetic-input" };
  const starts: Array<{ provider: Provider; gate: Deferred<Request> }> = [];
  const cancels: Array<{ provider: Provider; id: string }> = [];
  const completions: Array<{ catalog: Catalog; request: Request }> = [];
  const dependencies: Dependencies = {
    useCallback: callback => callback,
    loginGenerationRef: { current: 0 }, loginActionRef: { current: false },
    loginRequestRef: { current: undefined }, loginProviderRef: { current: undefined },
    onCancelLoginRef: { current: async (provider, id) => { cancels.push({ provider, id }); } },
    setLoginRequest: value => { request.value = value; },
    setLoginStage: value => { stage.value = value; },
    setLoginError: value => { error.value = value; },
    setAuthorizationCode: value => { code.value = value; },
    onStartLogin: async provider => {
      const gate = deferred<Request>();
      starts.push({ provider, gate });
      return await gate.promise;
    },
    completeLoginRequest: async (catalog, value) => { completions.push({ catalog, request: value }); }
  };
  const names = Object.keys(dependencies);
  const factory = new Function(...names, `return ${stripTypeScriptTypes(definitions, { mode: "strip" })}`) as (...values: unknown[]) => Controls;
  const controls = factory(...Object.values(dependencies));
  return { ...controls, dependencies, stage, error, request, code, starts, cancels, completions };
}
const catalog: Catalog = { loginProvider: "claude-code" };
const paste = (id: string): Request => ({ authRequestId: id, method: "paste-code" });

test("source binding: normal settings dialog retains its provider component across close/reopen", () => {
  const overlay = readFileSync(new URL("../src/desktop/renderer/src/components/settings/SettingsOverlay.tsx", import.meta.url), "utf8");
  assert.match(overlay, /if \(!open && visitedScope !== scope\) return null;/u);
  assert.match(overlay, /<SettingsDraftProvider\s+key=\{scope\}\s+active=\{open\}/u);
  assert.match(overlay, /activeTab === "模型" \? <ProviderSettings\s+active=\{open\}/u);
  assert.match(overlay, /<Dialog[\s\S]*?isOpen=\{open\}/u);
  const require = createRequire(import.meta.url);
  const dialog = readFileSync(join(dirname(require.resolve("@astryxdesign/core/Dialog")), "Dialog.js"), "utf8");
  const normal = dialog.slice(dialog.indexOf("// --- Standard modal rendering path ---"));
  assert.ok(normal.length > 0);
  assert.match(normal, /return.*_jsx\("dialog"/u);
  assert.match(normal, /children: innerContent/u);
  assert.doesNotMatch(normal, /return null/u);
  assert.match(dialog, /children: children/u);
});

for (const phase of ["opening", "waiting"] as const) {
  for (const failure of [new Error("old synthetic failure"), "old synthetic non-Error"] as const) {
    test(`retired start rejection preserves newer ${phase} state (${typeof failure})`, async () => {
      const h = fixture();
      const old = h.startLogin(catalog);
      h.closeEffect();
      const next = h.startLogin(catalog);
      if (phase === "waiting") { h.starts[1]!.gate.resolve(paste("synthetic-B")); await next; }
      h.starts[0]!.gate.reject(failure);
      await old;
      assert.equal(h.stage.value, phase);
      assert.equal(h.error.value, undefined);
      assert.equal(h.dependencies.loginActionRef.current, true);
      assert.equal(h.request.value?.authRequestId, phase === "waiting" ? "synthetic-B" : undefined);
      await h.startLogin(catalog);
      assert.equal(h.starts.length, 2, "stale failure must not release B's single-flight lock");
      if (phase === "opening") { h.starts[1]!.gate.resolve(paste("synthetic-B")); await next; }
    });
  }
}

test("retired rejection while closed does not install an error or release a new generation", async () => {
  const h = fixture();
  const old = h.startLogin(catalog);
  h.closeEffect();
  h.starts[0]!.gate.reject(new Error("closed synthetic failure"));
  await old;
  assert.equal(h.stage.value, "idle");
  assert.equal(h.error.value, undefined);
  assert.equal(h.dependencies.loginActionRef.current, false);
  assert.equal(h.request.value, undefined);
  assert.equal(h.code.value, "");
});

for (const failure of [new Error("current synthetic failure"), "current synthetic non-Error", 17]) {
  test(`current rejection remains visible and allows retry (${typeof failure})`, async () => {
    const h = fixture();
    const first = h.startLogin(catalog);
    await h.startLogin(catalog);
    assert.equal(h.starts.length, 1);
    h.starts[0]!.gate.reject(failure);
    await first;
    assert.equal(h.stage.value, "idle");
    assert.equal(h.error.value, failure instanceof Error ? failure.message : String(failure));
    assert.equal(h.dependencies.loginActionRef.current, false);
    const retry = h.startLogin(catalog);
    assert.equal(h.error.value, undefined);
    assert.equal(h.stage.value, "opening");
    h.starts[1]!.gate.resolve(paste("synthetic-retry"));
    await retry;
    assert.equal(h.stage.value, "waiting");
    assert.equal(h.request.value?.authRequestId, "synthetic-retry");
    assert.equal(h.dependencies.loginRequestRef.current, h.request.value);
    assert.equal(h.dependencies.loginProviderRef.current, "claude-code");
  });
}

test("existing stale-success guard cancels only the retired request and preserves B", async () => {
  const h = fixture();
  const old = h.startLogin(catalog);
  h.closeEffect();
  const next = h.startLogin(catalog);
  h.starts[0]!.gate.resolve(paste("synthetic-old"));
  await old;
  assert.deepEqual(h.cancels, [{ provider: "claude-code", id: "synthetic-old" }]);
  assert.equal(h.stage.value, "opening");
  assert.equal(h.dependencies.loginActionRef.current, true);
  assert.equal(h.request.value, undefined);
  assert.equal(h.completions.length, 0);
  h.starts[1]!.gate.resolve(paste("synthetic-new"));
  await next;
  h.closeEffect();
  assert.deepEqual(h.cancels[1], { provider: "claude-code", id: "synthetic-new" });
});

test("current browser-callback result dispatches unchanged to an inert completion recorder", async () => {
  const h = fixture();
  const entry: Catalog = { loginProvider: "openai-codex" };
  const pending = h.startLogin(entry);
  const value: Request = { authRequestId: "synthetic-callback", method: "browser-callback" };
  h.starts[0]!.gate.resolve(value);
  await pending;
  assert.deepEqual(h.completions, [{ catalog: entry, request: value }]);
  assert.equal(h.request.value, value);
  assert.equal(h.dependencies.loginActionRef.current, true);
  assert.equal(h.error.value, undefined);
  assert.deepEqual(h.cancels, []);
});

test("non-login catalog does not dispatch", async () => {
  const h = fixture();
  await h.startLogin({});
  assert.equal(h.starts.length, 0);
  assert.equal(h.stage.value, "idle");
  assert.equal(h.dependencies.loginActionRef.current, false);
});
