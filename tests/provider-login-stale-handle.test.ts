/** Source-closure proof only. Synthetic opaque handles; no React/auth/IPC/store execution. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

type Provider = "claude-code" | "openai-codex";
interface Catalog { loginProvider?: Provider; value: string; label: string; baseUrl: string }
interface Request { authRequestId: string; method: "paste-code" | "browser-callback" }
interface Result { handle: string; models: Array<{ id: string; displayName: string; supportsThinking: boolean }> }
interface Save { status: string; message?: string }
interface Ref<T> { current: T }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = readFileSync(new URL("../src/desktop/renderer/src/components/settings/ProviderSettings.tsx", import.meta.url), "utf8");
function between(text: string, from: string, until: string): string {
  assert.equal(text.split(from).length, 2, `unique source start: ${from}`);
  const start = text.indexOf(from);
  const end = text.indexOf(until, start + from.length);
  assert.ok(end > start, `source end: ${until}`);
  return text.slice(start, end);
}
const resetSource = between(source, "  const resetLogin = useCallback(", "  useEffect(() => {\n    cancelLoginRef.current");
const completeSource = between(source, "  const completeLoginRequest = useCallback(", "  const startLogin = useCallback(");
const closeSource = between(source, "  useEffect(() => {\n    // 设置面板整体关闭时放弃未完成的登录请求。", "\n\n  // ── 测试连接");
const viewSource = between(source, "  useLayoutEffect(() => {\n    if (loginViewKeyRef.current === loginViewKey)", "\n\n  const completeLoginRequest");
const wrapped = `(function extractedControls() {
type DesktopModelLoginProvider = "claude-code" | "openai-codex";
interface DesktopModelLoginStartResult { authRequestId: string; method: "paste-code" | "browser-callback" }
interface ProviderCatalogItem { loginProvider?: DesktopModelLoginProvider; value: string; label: string; baseUrl: string }
${resetSource}
${completeSource}
const cancelLoginRef = { current: () => resetLogin(true) };
function close() { const active = false; ${closeSource} }
function commitView(loginViewKey: string) { ${viewSource} }
return { completeLoginRequest, resetLogin, close, commitView };
})()`;
interface Controls {
  completeLoginRequest(catalog: Catalog, request: Request, code?: string): Promise<void>;
  resetLogin(cancel: boolean): void;
  close(): void;
  commitView(key: string): void;
}
const claude: Catalog = { loginProvider: "claude-code", value: "claude", label: "Claude", baseUrl: "synthetic" };
const codex: Catalog = { loginProvider: "openai-codex", value: "codex", label: "Codex", baseUrl: "synthetic" };
const request = (id: string): Request => ({ authRequestId: id, method: "paste-code" });
const result = (id: string): Result => ({ handle: `opaque-${id}`, models: [{ id: "synthetic-model", displayName: "Model", supportsThinking: false }] });

function fixture() {
  const state: { stage: string; error?: string; request?: Request; code: string; activeKey?: string } = { stage: "idle", code: "" };
  const loginGenerationRef = { current: 0 };
  const loginRequestRef: Ref<Request | undefined> = { current: undefined };
  const loginProviderRef: Ref<Provider | undefined> = { current: undefined };
  const loginActionRef = { current: false };
  const completions: Array<{ provider: Provider; id: string; code?: string; gate: Deferred<Result> }> = [];
  const saves: Array<{ input: unknown; gate: Deferred<Save> }> = [];
  const releases: Array<{ handle: string; gate: Deferred<void> }> = [];
  const added: string[] = [];
  const cancelled: string[] = [];
  const notices: string[] = [];
  const saveEntered = deferred<void>();
  const dependencies = {
    useCallback: <T>(value: T, _deps: unknown[]): T => value,
    // Invoked explicitly as committed effects, not a React scheduling simulation.
    useEffect: (effect: () => void, _deps: unknown[]): void => effect(),
    useLayoutEffect: (effect: () => void, _deps: unknown[]): void => effect(),
    loginGenerationRef, loginRequestRef, loginProviderRef, loginActionRef,
    loginViewKeyRef: { current: "claude" },
    onCancelLoginRef: { current: async (_provider: Provider, id: string): Promise<void> => { cancelled.push(id); } },
    setLoginRequest: (value: Request | undefined): void => { state.request = value; },
    setLoginStage: (value: string): void => { state.stage = value; },
    setLoginError: (value: string | undefined): void => { state.error = value; },
    setAuthorizationCode: (value: string): void => { state.code = value; },
    setActiveKey: (value: string): void => { state.activeKey = value; },
    defaultModelAlias: "existing-default",
    providerAliasFor: (catalog: Catalog): string => catalog.value,
    modelAliasFor: (alias: string, model: string): string => `${alias}-${model}`,
    onNotify: (value: string): void => { notices.push(value); },
    onCompleteLogin: async (provider: Provider, id: string, code?: string): Promise<Result> => {
      const gate = deferred<Result>(); completions.push({ provider, id, code, gate }); return await gate.promise;
    },
    settingsDraft: {
      addOauthCredentialHandle: (handle: string): void => { added.push(handle); },
      releaseCredential: async (handle: string): Promise<void> => {
        const gate = deferred<void>(); releases.push({ handle, gate }); return await gate.promise;
      },
      saveModels: async (input: unknown): Promise<Save> => {
        const gate = deferred<Save>(); saves.push({ input, gate }); saveEntered.resolve(); return await gate.promise;
      }
    }
  };
  const factory = new Function(...Object.keys(dependencies), `return ${stripTypeScriptTypes(wrapped, { mode: "strip" })}`) as (...values: unknown[]) => Controls;
  const controls = factory(...Object.values(dependencies));
  function begin(catalog: Catalog, id: string): Promise<void> {
    const value = request(id);
    loginRequestRef.current = value; loginProviderRef.current = catalog.loginProvider;
    loginActionRef.current = true; state.request = value; state.code = `input-${id}`;
    return controls.completeLoginRequest(catalog, value, state.code);
  }
  return { ...controls, begin, state, completions, saves, releases, added, cancelled, notices, saveEntered, loginGenerationRef, loginRequestRef, loginProviderRef, loginActionRef };
}
// Await only a bounded number of promise continuations; no timers or product event loop.
async function continuations(): Promise<void> { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function noSave(h: ReturnType<typeof fixture>): void {
  assert.deepEqual(h.added, []); assert.deepEqual(h.saves, []); assert.deepEqual(h.notices, []);
}

for (const retirement of ["close", "switch", "ABA"] as const) {
  test(`late completed handle is released after ${retirement}, without touching the new request`, async () => {
    const h = fixture(); const old = h.begin(claude, "old");
    if (retirement === "close") h.close(); else h.commitView("codex");
    if (retirement === "ABA") h.commitView("claude");
    const newer = h.begin(retirement === "switch" ? codex : claude, "new");
    const before = { ...h.state }; const generation = h.loginGenerationRef.current;
    h.completions[0]!.gate.resolve(result("old")); await continuations();
    assert.deepEqual(h.releases.map(item => item.handle), ["opaque-old"]);
    noSave(h); assert.deepEqual(h.state, before);
    h.releases[0]!.gate.resolve(); await old;
    assert.deepEqual(h.state, before); assert.equal(h.loginGenerationRef.current, generation);
    assert.equal(h.loginRequestRef.current?.authRequestId, "new"); assert.equal(h.loginActionRef.current, true);
    h.close(); h.completions[1]!.gate.reject(new Error("synthetic retired completion")); await newer;
  });
}
test("late handle while closed is released without registration", async () => {
  const h = fixture(); const old = h.begin(claude, "old"); h.close(); const before = { ...h.state };
  h.completions[0]!.gate.resolve(result("old")); await continuations();
  assert.deepEqual(h.releases.map(item => item.handle), ["opaque-old"]);
  h.releases[0]!.gate.resolve(); await old; noSave(h); assert.deepEqual(h.state, before);
});
test("failed stale release remains silent in the new view", async () => {
  const h = fixture(); const old = h.begin(claude, "old"); h.commitView("codex");
  const newer = h.begin(codex, "new"); const before = { ...h.state };
  h.completions[0]!.gate.resolve(result("old")); await continuations();
  assert.deepEqual(h.releases.map(item => item.handle), ["opaque-old"]);
  h.releases[0]!.gate.reject(new Error("synthetic release failure")); await old;
  noSave(h); assert.deepEqual(h.state, before);
  h.close(); h.completions[1]!.gate.reject(new Error("retired")); await newer;
});
test("stale completion rejection has no handle to release", async () => {
  const h = fixture(); const old = h.begin(claude, "old"); h.close(); const before = { ...h.state };
  h.completions[0]!.gate.reject(new Error("synthetic complete failure")); await old;
  assert.deepEqual(h.releases, []); noSave(h); assert.deepEqual(h.state, before);
});
for (const status of ["committed", "rolled_back"] as const) {
  test(`current completion preserves ${status} save and exactly one release`, async () => {
    const h = fixture(); const current = h.begin(claude, "current");
    h.completions[0]!.gate.resolve(result("current")); await h.saveEntered.promise;
    assert.deepEqual(h.added, ["opaque-current"]); assert.equal(h.saves.length, 1);
    assert.deepEqual([...h.releases], []);
    h.saves[0]!.gate.resolve({ status, message: "synthetic rollback" }); await continuations();
    assert.deepEqual(h.releases.map(item => item.handle), ["opaque-current"]);
    h.releases[0]!.gate.resolve(); await current;
    assert.equal(h.notices.length, status === "committed" ? 1 : 0);
    assert.equal(h.state.error, status === "committed" ? undefined : "synthetic rollback");
  });
}
test("current completion rejection remains visible without release", async () => {
  const h = fixture(); const current = h.begin(claude, "current");
  h.completions[0]!.gate.reject(new Error("synthetic complete failure")); await current;
  assert.equal(h.state.error, "synthetic complete failure"); assert.deepEqual(h.releases, []); noSave(h);
});
test("already admitted save finishes and releases once after retirement", async () => {
  const h = fixture(); const old = h.begin(claude, "old");
  h.completions[0]!.gate.resolve(result("old")); await h.saveEntered.promise;
  h.commitView("codex"); const newer = h.begin(codex, "new"); const before = { ...h.state };
  h.saves[0]!.gate.resolve({ status: "committed" }); await continuations();
  assert.deepEqual(h.releases.map(item => item.handle), ["opaque-old"]);
  h.releases[0]!.gate.resolve(); await old;
  assert.deepEqual(h.state, before); assert.deepEqual(h.notices, []); assert.equal(h.saves.length, 1);
  h.close(); h.completions[1]!.gate.reject(new Error("retired")); await newer;
});
test("source contracts: staging ownership, idempotent release and lazy TTL, not backend integration", () => {
  const manager = readFileSync(new URL("../src/desktop/electron/main/DesktopAgentManager.ts", import.meta.url), "utf8");
  const stage = between(manager, "  async completeModelLoginForSettings(", "  releaseSettingsCredentials(");
  assert.match(stage, /stagedSettingsCredentials\.set\(handle,[\s\S]*?return \{[\s\S]*?handle,[\s\S]*?finally \{\s*this\.modelLoginOperations\.delete\(authRequestId\);/u);
  const release = between(manager, "  releaseSettingsCredentials(", "  consumeSettingsCredentials(");
  assert.match(release, /\{\s*for \(const handle of handles\) this\.stagedSettingsCredentials\.delete\(handle\);\s*\}/u);
  const cancel = between(manager, "  async cancelModelLogin(", "  /** 个性化总览");
  assert.doesNotMatch(cancel, /stagedSettingsCredentials|releaseSettingsCredentials/u);
  assert.match(manager, /const SETTINGS_CREDENTIAL_TTL_MS = 30 \* 60 \* 1000;/u);
  assert.equal(manager.split("this.pruneStagedSettingsCredentials();").length - 1, 2);
  const requireHandle = between(manager, "  private requireStagedCredential(", "  private requireApiKeyHandle(");
  assert.match(requireHandle, /this\.pruneStagedSettingsCredentials\(\);[\s\S]*?stagedSettingsCredentials\.get\(handle\)/u);
  const prune = between(manager, "  private pruneStagedSettingsCredentials(", "  /**\n   * 只写 providers");
  assert.match(prune, /if \(staged\.expiresAt <= now\) this\.stagedSettingsCredentials\.delete\(handle\);/u);
});
