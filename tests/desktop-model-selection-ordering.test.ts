/** 通过真实选择回调、状态 hook 和本地配置验证顺序；不模拟界面输入。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComposerDraftState } from "../src/desktop/renderer/src/components/composer/composerDraft.js";
import type { ComposerHandle } from "../src/desktop/renderer/src/components/Composer.js";
import type { ModelRuntimeInfo, ThinkingSelection } from "../src/llm/ModelManager.js";
import type { DesktopWorkspaceSnapshot } from "../src/desktop/protocol.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { saveProjectSettings } from "../src/config/projectSettings.js";
import { loadConfigFile } from "../src/config/loader.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { FileModelsStore } from "../src/llm/ModelsStore.js";

registerHooks({ load(url, context, next) {
  for (const [file, name, capture] of [["ModelPickerMenu", "ModelPickerMenu", "__modelAuditPicker"], ["PromptInput", "PromptInput", "__modelAuditInput"]]) {
    if (url.endsWith(`/composer/${file}.tsx`)) return { format: "module", shortCircuit: true, source: `
      import { createElement } from "react";
      import { ${name} as Original } from ${JSON.stringify(`${url}?audit-observer`)};
      export function ${name}(props) { window.${capture} = props; return createElement(Original, props); }
    ` };
  }
  if (/\.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context);
} });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Call = { projectId: string; alias: string; thinking: ThinkingSelection; result: ReturnType<typeof deferred<ModelRuntimeInfo>> };

async function fixture(autoIpc = false) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "biny-model-choice-audit-"));
  const providerAlias = `model-choice-${randomUUID()}`;
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(folder, "agent");
  const workspacePath = path.join(folder, "project");
  await mkdir(workspacePath);
  const configStore = createFileConfigStore(workspacePath, { globalDir: path.join(folder, "config"), credentialStore: {
    persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
  } });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save(configSchema.parse({
    ...defaultConfig,
    defaultModel: "alpha",
    providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "https://model-audit.invalid/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } },
    models: Object.fromEntries(["alpha", "beta", "gamma"].map(alias => [alias, {
      provider: providerAlias, model: `chat-${alias}`, displayName: alias, contextWindow: 128_000,
      capabilities: { tools: true, reasoning: true, streaming: true }, thinkingLevelMap: { off: "none", high: "high", max: "max" }
    }])),
    thinking: { enabled: false, effort: "high" },
    extensions: { ...defaultConfig.extensions, skills: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
    checkpoints: { enabled: false },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
  }));
  const storage = new DesktopUserDataStore(path.join(folder, "desktop")); await storage.initialize();
  const state = new DesktopStateStore(path.join(folder, "state.json")); await state.load();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createProject(workspacePath);
  const modelsStore = new FileModelsStore(path.join(folder, "models.json"));
  await fs.writeFile(modelsStore.filePath, JSON.stringify({ version: 2, providers: {} }));
  const agents = new DesktopAgentManager(state, projects, configStore, () => {}, undefined, modelsStore);
  const initial = await agents.workspaceSnapshot(project.id, false);
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => null });
  const React = await import("react"); const { createRoot } = await import("react-dom/client");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {},
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { requestAnimationFrame: (): number => 0, cancelAnimationFrame: () => {} });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
  const calls: Call[] = [];
  const refreshes: Array<{ projectId: string; result: ReturnType<typeof deferred<DesktopWorkspaceSnapshot>> }> = [];
  Object.defineProperty(window, "biny", { value: {
    switchModel: (projectId: string, alias: string, thinking: ThinkingSelection) => {
      const result = deferred<ModelRuntimeInfo>(); calls.push({ projectId, alias, thinking, result });
      if (autoIpc) void agents.switchModel(projectId, alias, thinking).then(result.resolve, result.reject);
      return result.promise;
    },
    refreshProject: (projectId: string) => { const result = deferred<DesktopWorkspaceSnapshot>(); refreshes.push({ projectId, result }); return result.promise; },
    readInlineImage: async () => undefined
  } });
  const { Composer } = await import("../src/desktop/renderer/src/components/Composer.js");
  const { useDesktopSettingsActions } = await import("../src/desktop/renderer/src/app/useDesktopSettingsActions.js");
  const drafts = new Map<string, ComposerDraftState>();
  const ref = React.createRef<ComposerHandle>();
  const warnings: string[] = []; const errors: string[] = []; const sends: string[] = [];
  const projectIdRef = { current: project.id };
  let latestWorkspace = initial;
  let setExternal!: React.Dispatch<React.SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
  const noop = async (): Promise<void> => {};
  const props: Omit<React.ComponentProps<typeof Composer>, "onSwitchModel" | "runtimeInfo" | "models" | "draftKey"> = {
    ref, project, drafts, memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: { tools: "none", skills: "none" }, skills: [], toolCatalog: [],
    onSend: async text => { sends.push(text); }, onMutateQueuedMessage: noop, onResume: noop,
    onSubmitEdit: noop, onCancelEdit: () => {}, onSlashCommand: noop, onStop: noop, onToggleMemory: noop,
    onSaveAttachment: async () => { throw new Error("unused"); }, onWarning: message => { warnings.push(message); }, onSubmitError: message => { errors.push(message); }
  };
  function Harness({ sessionId }: { sessionId: string }) {
    const [workspace, setWorkspace] = React.useState<DesktopWorkspaceSnapshot | undefined>(initial);
    setExternal = setWorkspace; latestWorkspace = workspace!;
    const merge = React.useCallback((snapshot: DesktopWorkspaceSnapshot) => { if (projectIdRef.current === snapshot.project.id) setWorkspace(snapshot); }, []);
    const actions = useDesktopSettingsActions({ projectIdRef, setWorkspace, mergeProjectSnapshot: merge });
    const key = `${workspace!.project.id}:${sessionId}`;
    return React.createElement(Composer, { ...props, project: workspace!.project, key, draftKey: key,
      models: workspace!.pickerModels, runtimeInfo: workspace!.selectedModel, onSwitchModel: actions.switchModel });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (sessionId = "draft") => { await React.act(async () => root.render(React.createElement(Harness, { sessionId }))); };
  await render();
  const picker = () => (window as unknown as { __modelAuditPicker: { currentAlias: string; currentThinking: ThinkingSelection; onSelectModel(alias: string): void; onSelectThinking(thinking: ThinkingSelection): void } }).__modelAuditPicker;
  const choose = async (alias: string) => { await React.act(async () => picker().onSelectModel(alias)); };
  const think = async (thinking: ThinkingSelection) => { await React.act(async () => picker().onSelectThinking(thinking)); };
  const commit = async (index: number) => { const call = calls[index]!; return await agents.switchModel(call.projectId, call.alias, call.thinking); };
  const receipt = async (index: number, info: ModelRuntimeInfo) => { await React.act(async () => calls[index]!.result.resolve(info)); };
  const refresh = async (index: number) => { const entry = refreshes[index]!; const snapshot = await agents.workspaceSnapshot(entry.projectId, false); await React.act(async () => entry.result.resolve(snapshot)); };
  async function actualNextPrompt(targetWorkspacePath = workspacePath) {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ model: string; reasoning_effort?: string; messages?: unknown[] }> = [];
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /^https:\/\/model-audit\.invalid\/v1\//u);
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return new Response([
        { choices: [{ index: 0, delta: { content: "synthetic audit reply" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    let runtime: Awaited<ReturnType<typeof createCommandRuntime>> | undefined;
    try {
      runtime = await createCommandRuntime(targetWorkspacePath, { configStore });
      const result = await runtime.agent.runTask("Audit next message", { emotionAnalysis: false, capabilitySelection: { tools: "none", skills: "none" } });
      assert.equal(result.status, "completed"); assert.ok(requests.length > 0);
      return requests;
    } finally { await runtime?.close(); globalThis.fetch = originalFetch; }
  }
  return { React, calls, warnings, errors, sends, picker, choose, think, commit, receipt, refresh, render, project, projects, agents, configStore,
    ref, drafts, actualNextPrompt, modelsStore, selected: () => latestWorkspace.selectedModel,
    async navigateProject(snapshot: DesktopWorkspaceSnapshot) { projectIdRef.current = snapshot.project.id; await React.act(async () => setExternal(snapshot)); },
    async close() {
      await React.act(() => root.unmount()); dom.window.close();
      await agents.closeAll();
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(folder, { recursive: true, force: true });
    }
  };
}

test("same Composer serializes model then thinking and holds submission until the latest selection succeeds", { timeout: 20_000 }, async () => {
  const h = await fixture();
  try {
    await h.choose("beta"); await h.think("max");
    assert.equal(h.picker().currentAlias, "beta"); assert.equal(h.picker().currentThinking, "max");
    assert.equal(h.calls.length, 1);
    let submitted!: Promise<void>;
    await h.React.act(async () => { submitted = h.ref.current!.submitSuggestion("next"); });
    assert.deepEqual(h.sends, []);
    await h.receipt(0, await h.commit(0));
    assert.equal(h.calls.length, 2); assert.deepEqual(h.sends, []);
    assert.equal(h.picker().currentThinking, "max");
    await h.receipt(1, await h.commit(1)); await h.React.act(async () => submitted);
    assert.deepEqual(h.sends, ["next"]); assert.equal(h.picker().currentThinking, "max");
    const requests = await h.actualNextPrompt();
    assert.ok(requests.every(body => body.model === "chat-beta"));
    assert.equal(requests[0]!.reasoning_effort, "xhigh", "the existing OpenAI-compatible adapter serializes max as xhigh");
  } finally { await h.close(); }
});

test("latest switch rejection restores confirmed selection and prevents a waiting send", { timeout: 20_000 }, async () => {
  const h = await fixture();
  try {
    await h.React.act(async () => h.ref.current!.appendText("retain me"));
    await h.choose("beta");
    let submitted!: Promise<void>;
    await h.React.act(async () => { submitted = h.ref.current!.submitSuggestion("next"); });
    await h.React.act(async () => { h.calls[0]!.result.reject(new Error("save rejected")); await submitted; });
    assert.equal(h.picker().currentAlias, "alpha"); assert.deepEqual(h.sends, []);
    assert.deepEqual(h.warnings, ["save rejected"]);
    assert.equal(h.drafts.get(`${h.project.id}:draft`)!.getSnapshot().draft.value, "retain me ");
    assert.equal((await h.configStore.load()).defaultModel, "alpha");
  } finally { await h.close(); }
});

test("an older failed request cannot clear the newer optimistic selection or prevent its successful send", { timeout: 20_000 }, async () => {
  const h = await fixture();
  try {
    await h.choose("beta"); await h.choose("gamma");
    await h.React.act(async () => h.calls[0]!.result.reject(new Error("older rejected")));
    assert.equal(h.picker().currentAlias, "gamma"); assert.equal(h.calls.length, 2); assert.deepEqual(h.warnings, []);
    await h.receipt(1, await h.commit(1));
    assert.equal(h.picker().currentAlias, "gamma");
    await h.React.act(async () => h.ref.current!.submitSuggestion("next")); assert.deepEqual(h.sends, ["next"]);
  } finally { await h.close(); }
});

test("a remounted Composer holds a new model choice behind the previous session's pending receipt", { timeout: 20_000 }, async () => {
  const h = await fixture();
  try {
    await h.choose("beta"); const oldInfo = await h.commit(0);
    await h.render("another-session"); await h.choose("gamma");
    assert.equal(h.picker().currentAlias, "gamma");
    assert.equal(h.calls.length, 1, "both Composers must share selection ordering until beta's receipt arrives");
    await h.receipt(0, oldInfo); assert.equal(h.calls.length, 2);
    assert.equal(h.picker().currentAlias, "gamma", "the older success must preserve the newer optimistic choice");
    await h.receipt(1, await h.commit(1)); await h.refresh(1); await h.refresh(0);
    assert.equal(h.picker().currentAlias, "gamma");
    assert.equal((await h.configStore.load()).defaultModel, "gamma");
  } finally { await h.close(); }
});

// 不把共享默认模型误作项目独立设置：项目覆盖仍然优先，迟到的请求只能使用原项目的有效配置。
test("queued model intent retains its original project and its overrides after navigation", { timeout: 20_000 }, async () => {
  const h = await fixture();
  try {
    const otherPath = path.join(path.dirname(h.project.path), "other-project"); await mkdir(otherPath);
    await saveProjectSettings(h.project.path, { defaultModel: "beta" });
    await saveProjectSettings(otherPath, { defaultModel: "gamma" });
    const other = await h.projects.createProject(otherPath);
    await h.choose("beta"); await h.choose("gamma");
    assert.equal(h.calls.length, 1);
    const firstInfo = await h.commit(0);
    await h.navigateProject(await h.agents.workspaceSnapshot(other.id, false));
    await h.receipt(0, firstInfo); assert.equal(h.calls.length, 2);
    await h.receipt(1, await h.commit(1)); await h.refresh(1); await h.refresh(0);
    const globalDefault = (await loadConfigFile(path.dirname(h.configStore.configPath!()))).defaultModel;
    const originalEffective = (await h.configStore.load(h.project.path)).defaultModel;
    const otherEffective = (await h.configStore.load(other.path)).defaultModel;
    assert.equal(h.calls[1]!.projectId, h.project.id, "queued gamma must retain the original project context");
    assert.equal(globalDefault, "gamma", "a gamma override in another project must not hide the requested global update");
    assert.equal(originalEffective, "beta"); assert.equal(otherEffective, "gamma");
    assert.equal(h.picker().currentAlias, "gamma", "the original project's effective beta must not replace the current project's view");
    assert.ok((await h.actualNextPrompt(h.project.path)).every(body => body.model === "chat-beta"));
    assert.ok((await h.actualNextPrompt(other.path)).every(body => body.model === "chat-gamma"));
  } finally { await h.close(); }
});

test("real service completions preserve selection order across session remount when a catalog file read is delayed", { timeout: 20_000 }, async () => {
  const h = await fixture(true);
  const entered = deferred<void>(); const release = deferred<void>();
  const readFile = fs.readFile;
  let held = false;
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await readFile(...args);
    if (!held && args[0] === h.modelsStore.filePath) { held = true; entered.resolve(); await release.promise; }
    return bytes;
  }) as typeof fs.readFile;
  try {
    await h.choose("beta"); await entered.promise;
    await h.render("another-session"); await h.choose("gamma");
    if (h.calls[1]) await h.React.act(async () => h.calls[1]!.result.promise.then(() => undefined));
    await h.React.act(async () => { release.resolve(); await h.calls[0]!.result.promise; });
    assert.equal(h.calls.length, 2);
    await h.React.act(async () => h.calls[1]!.result.promise.then(() => undefined));
    const persisted = (await h.configStore.load()).defaultModel;
    const requests = await h.actualNextPrompt();
    assert.equal(persisted, "gamma", "older service completion must not supersede the later choice after a Composer remount");
    assert.equal(h.picker().currentAlias, "gamma"); assert.ok(requests.every(body => body.model === "chat-gamma"));
  } finally { release.resolve(); fs.readFile = readFile; await h.close(); }
});


for (const failure of ["older", "newer"] as const) {
  test(`the ${failure} selection failure across remount preserves the latest successful choice`, { timeout: 20_000 }, async () => {
    const h = await fixture();
    try {
      await h.choose("beta"); await h.render("another-session"); await h.choose("gamma");
      if (failure === "older") await h.React.act(async () => h.calls[0]!.result.reject(new Error("older rejected")));
      else await h.receipt(0, await h.commit(0));
      assert.equal(h.calls.length, 2);
      if (failure === "newer") await h.React.act(async () => h.calls[1]!.result.reject(new Error("newer rejected")));
      else await h.receipt(1, await h.commit(1));
      const expected = failure === "older" ? "gamma" : "beta";
      assert.equal(h.picker().currentAlias, expected); assert.equal((await h.configStore.load()).defaultModel, expected);
      assert.deepEqual(h.warnings, [`${failure} rejected`]);
      assert.ok((await h.actualNextPrompt()).every(body => body.model === `chat-${expected}`));
    } finally { await h.close(); }
  });
}
