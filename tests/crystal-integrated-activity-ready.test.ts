/** Real collision allocation -> saved Activity analysis -> AgentSession prefill -> Desktop CrystalDock confirmation. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamContext, ModelStreamEvent } from "../src/agent/core/types.js";
import type { ActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import type { ActivityStore, ActivitySessionAnalysis } from "../src/activity/store.js";
import type { AgentConfig } from "../src/config/schema.js";
import type { DesktopCrystalRequest, DesktopCrystalSnapshot } from "../src/desktop/crystalProtocol.js";
import type { DesktopCrystalService } from "../src/desktop/electron/main/DesktopCrystalService.js";

type Cleanup = () => void | Promise<void>;
const topics = ["C#项目", "BB项目"] as const;

async function cleanupAll(steps: Cleanup[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Integrated crystal cleanup failed");
}

async function fixture(context: TestContext) {
  const resources: { root?: string; agent?: AgentSession; pipeline?: ActivityMemoryPipeline; store?: ActivityStore } = {};
  const restore: Cleanup[] = [];
  const beforeClose: Cleanup[] = [];
  let closing: Promise<void> | undefined;
  let unexpectedRequests = 0;
  let unexpectedSockets = 0;
  const close = (): Promise<void> => closing ??= cleanupAll([
    () => cleanupAll([...beforeClose].reverse()),
    async () => { await resources.agent?.close(); },
    () => resources.pipeline?.close(),
    async () => { await resources.store?.close(); },
    () => cleanupAll(restore.reverse()),
    async () => { if (resources.root) await rm(resources.root, { recursive: true, force: true }); },
    () => assert.equal(unexpectedRequests, 0, "No external requests are allowed in this provider-controlled fixture"),
    () => assert.equal(unexpectedSockets, 0, "No network sockets are allowed in this provider-controlled fixture")
  ]);
  context.after(close);
  const blockedSocket = context.mock.method(Socket.prototype, "connect", () => {
    unexpectedSockets += 1; throw new Error("Unexpected crystal network socket");
  });
  restore.push(() => blockedSocket.mock.restore());
  const root = resources.root = await mkdtemp(path.join(os.tmpdir(), "biny-crystal-integrated-"));
  const agentDir = path.join(root, "agent");
  const workspaceRoot = path.join(root, "workspace");
  const activityDirectory = path.join(root, "activity");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  restore.push(() => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  });
  process.env.BINY_AGENT_DIR = agentDir;
  const previousFetch = globalThis.fetch;
  restore.push(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => { unexpectedRequests += 1; throw new Error("Unexpected external crystal request"); };

  // Business modules are loaded only after the isolated persistence root and network boundary exist.
  const { AgentSession } = await import("../src/agent/AgentSession.js");
  const { defaultConfig } = await import("../src/config/schema.js");
  const { ensureAgentDirs } = await import("../src/session/store.js");
  const { SessionRecorder } = await import("../src/session/recorder.js");
  const { PermissionManager } = await import("../src/permission/PermissionManager.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { ActivityStore } = await import("../src/activity/store.js");
  const { createActivityMemoryPipeline } = await import("../src/activity/memoryPipeline.js");
  const { CrystalStorage } = await import("../src/agent/context/crystalStorage.js");
  const { DesktopCrystalService } = await import("../src/desktop/electron/main/DesktopCrystalService.js");
  const { crystalTypeFields } = await import("../src/agent/context/crystalTypes.js");
  const { termId, validateCrystal } = await import("../src/agent/context/crystalService.js");
  const { messageText } = await import("../src/agent/modelMessages.js");
  await mkdir(workspaceRoot, { recursive: true });
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.providers = {};
  config.models = {};
  config.toolModel = undefined;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.activity.enabled = true;
  config.activity.outputDirectory = activityDirectory;
  config.crystal.semanticScanEnabled = false;
  const requests: ModelStreamContext[] = [];
  const model: AgentModel = {
    provider: "fixture", modelId: "integrated-crystal-fixture",
    stream: async request => {
      requests.push(request);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify(response) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const agent = resources.agent = new AgentSession({
    workspaceRoot, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...config.permission, source: "test" }),
    recorder: new SessionRecorder(workspaceRoot)
  });
  await agent.initialize();
  const crystals = agent.getCrystalService();
  assert.equal(termId(topics[0]), termId(topics[1]), "the two independently grounded topics really collide");
  const store = resources.store = new ActivityStore();
  await store.open(activityDirectory, agentDir);
  const pipeline = resources.pipeline = await createActivityMemoryPipeline({
    workspaceRoot, agentDir, getCrystalConfig: () => config.crystal
  });
  const sources = new Map<string, Array<{ id: string; marker: string }>>(topics.map(topic => [topic, []]));
  for (let index = 0; index < 8; index += 1) {
    for (const topic of topics) {
      const day = index % 2 ? "2026-10-17" : "2026-10-16";
      const startedAt = `${day}T10:${String(index).padStart(2, "0")}:00.000Z`;
      const endedAt = `${day}T10:${String(index).padStart(2, "0")}:30.000Z`;
      const id = store.startSession(startedAt);
      store.recordEvent({ sessionId: id, occurredAt: startedAt, eventType: "app_focus", application: "Editor" });
      store.endSession(id, endedAt);
      const marker = `${topic} saved evidence ${index}`;
      const analysis: ActivitySessionAnalysis = {
        sessionId: id, analyzedAt: endedAt, analyzerModel: "saved-analysis", analysisStatus: "analyzed",
        project: topic, title: marker, description: marker, summary: marker, topics: [topic],
        prs: [], issues: [], people: [], versions: [], decisions: [], entities: [topic], highlights: [],
        worthMemory: false, worthKnowledge: true, isMeeting: false, storageTier: "standard",
        confidence: 1, sourceEventCount: 1, inputHash: `integrated-${id}`
      };
      store.recordAnalysis(analysis);
      await pipeline.onAnalyzed(analysis, { id, startedAt, endedAt, eventCount: 1, durationMs: 30_000, snapshotCount: 0 });
      sources.get(topic)!.push({ id, marker });
    }
  }
  const terms = topics.map(topic => {
    const matches = crystals.storage.listTerms().filter(term => term.term === topic);
    assert.equal(matches.length, 1);
    return matches[0]!;
  });
  assert.notEqual(terms[0]!.id, terms[1]!.id);
  assert.notEqual(terms[0]!.crystalId, terms[1]!.crystalId);
  assert.equal(crystals.storage.listCrystals().length, 2);
  for (const term of terms) {
    assert.equal(term.count, 8);
    assert.equal(term.status, "nucleus");
    assert.ok(term.crystalId);
    const detail = crystals.detail(term.crystalId)!;
    assert.equal(detail.materials.length, 8);
    assert.deepEqual(new Set(detail.materials.map(material => (material.ref as { anchorId: string }).anchorId)),
      new Set(sources.get(term.term)!.map(source => `activity:${source.id}`)));
    crystals.setType(term.crystalId, "concept");
  }
  const firstId = terms[0]!.crystalId!;
  const secondId = terms[1]!.crystalId!;
  const secondBefore = structuredClone(crystals.detail(secondId)!);
  const firstSourceTags = sources.get(topics[0])!.map(source => `turn:activity:${source.id}`);
  const response = Object.fromEntries(crystalTypeFields.concept.map(field => [field, {
    value: `${topics[0]} verified ${field}`, sources: [firstSourceTags[0]!]
  }]));
  const filled = await crystals.prefill(firstId);
  assert.equal(requests.length, 1);
  const prompt = requests[0]!.messages.map(messageText).join("\n");
  for (const source of sources.get(topics[0])!) assert.ok(prompt.includes(source.marker), "all own saved activity evidence is readable");
  for (const source of sources.get(topics[1])!) assert.equal(prompt.includes(source.marker), false, "hash collision cannot leak another topic's evidence");
  for (const field of crystalTypeFields.concept) {
    assert.equal(filled.checklist[field]?.value, `${topics[0]} verified ${field}`);
    assert.deepEqual(filled.checklist[field]?.sources, [firstSourceTags[0]!]);
  }
  assert.equal(filled.stage, "candidate");
  assert.equal(filled.notified, true);
  assert.equal(validateCrystal(filled).ready, true);
  assert.deepEqual(crystals.detail(secondId), secondBefore, "prefill cannot alter the colliding topic");
  // New evidence resets notification suppression, while the proven checklist remains ready.
  assert.equal(crystals.addMaterial(firstId, "note", { text: "A later observation does not revoke the verified fields." }), true);
  assert.equal(crystals.detail(firstId)!.crystal.notified, false);
  assert.equal(crystals.detail(firstId)!.validation.ready, true);
  const service = new DesktopCrystalService(
    { load: async () => config, save: async () => undefined },
    async () => [workspaceRoot], () => new CrystalStorage({ agentDir })
  );
  const desktop = await service.request({ action: "detail", id: firstId });
  assert.equal(desktop.detail!.validation.ready, true);
  assert.equal(desktop.detail!.crystal.notified, false);
  assert.ok(Object.values(desktop.detail!.materialPreviews).some(text => text.includes(sources.get(topics[0])![0]!.marker)));
  return { agent, service, firstId, secondId, secondBefore, requests, close,
    beforeClose(cleanup: Cleanup): void { beforeClose.push(cleanup); } };
}

async function mount(context: TestContext, f: { service: DesktopCrystalService; beforeClose(cleanup: Cleanup): void }) {
  const resources: { dom?: import("jsdom").JSDOM; React?: typeof import("react"); root?: import("react-dom/client").Root;
    css?: ReturnType<typeof registerHooks> } = {};
  const restore: Cleanup[] = [];
  const pending = new Set<Promise<DesktopCrystalSnapshot>>();
  const calls: Array<{ request: DesktopCrystalRequest; snapshot: DesktopCrystalSnapshot }> = [];
  let timersEnabled = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= cleanupAll([
    async () => { while (pending.size) await Promise.allSettled([...pending]); },
    async () => { if (resources.root && resources.React) await resources.React.act(() => resources.root!.unmount()); },
    () => { if (timersEnabled) context.mock.timers.reset(); },
    () => resources.dom?.window.close(), () => resources.css?.deregister(), () => cleanupAll(restore.reverse())
  ]);
  context.after(close); f.beforeClose(close);
  resources.css = registerHooks({ load(url, hookContext, next) {
    return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, hookContext);
  } });
  const { JSDOM } = await import("jsdom");
  const React = resources.React = await import("react");
  const dom = resources.dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://biny.test", pretendToBeVisual: true });
  await new Promise<void>(resolve => dom.window.addEventListener("load", () => resolve(), { once: true }));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, char => `\\${char}`), supports: () => false },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    restore.push(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else Reflect.deleteProperty(globalThis, key);
    });
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { biny: { crystalRequest(input: DesktopCrystalRequest) {
    const request = structuredClone(input);
    const promise = f.service.request(request).then(snapshot => { calls.push({ request, snapshot }); return structuredClone(snapshot); });
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  } } });
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  timersEnabled = true;
  const { createRoot } = await import("react-dom/client");
  const { CrystalDock } = await import("../src/desktop/renderer/src/components/CrystalDock.js");
  const root = resources.root = createRoot(dom.window.document.getElementById("root")!);
  const inserted: string[] = [];
  const drain = async (operation: () => void): Promise<void> => {
    await React.act(async () => { operation(); });
    await React.act(async () => { while (pending.size) await Promise.all([...pending]); });
  };
  const click = async (element: HTMLElement): Promise<void> => { await drain(() => element.click()); };
  const row = (name: string): HTMLButtonElement => {
    const result = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".crystal-list-row")]
      .find(element => element.querySelector("span")?.textContent === name);
    assert.ok(result, `Missing crystal row: ${name}`); return result;
  };
  const button = (label: string): HTMLButtonElement => {
    const result = [...dom.window.document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  await drain(() => root.render(React.createElement(CrystalDock, { onInsert: (reference: string) => inserted.push(reference) })));
  const trigger = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="结晶"]');
  assert.ok(trigger); await click(trigger);
  assert.ok(dom.window.document.querySelector("dialog[open]"));
  return { calls, inserted, click, row, button, badge: (name: string) => row(name).querySelector("small")?.textContent ?? "" };
}

test("colliding activity topics remain independent through real prefill, ready badge and explicit confirmation", { timeout: 30_000 }, async context => {
  const f = await fixture(context);
  const h = await mount(context, f);
  assert.equal(h.badge(topics[0]), "可确认", "a real prefilling result stays ready after notification reset");
  assert.equal(h.badge(topics[1]), "", "the independent unfilled topic cannot borrow readiness");
  await h.click(h.row(topics[1]));
  assert.equal(h.button("确认结晶").disabled, true);
  await h.click(h.row(topics[0]));
  assert.equal(h.button("确认结晶").disabled, false);
  assert.equal(f.agent.getCrystalService().detail(f.firstId)!.crystal.stage, "candidate");
  await h.click(h.button("确认结晶"));
  assert.equal(h.calls.at(-1)!.request.action, "confirm");
  assert.equal(h.calls.at(-1)!.snapshot.detail!.crystal.stage, "formal");
  assert.equal(f.agent.getCrystalService().detail(f.firstId)!.crystal.stage, "formal");
  assert.equal(h.badge(topics[0]), "");
  assert.deepEqual(f.agent.getCrystalService().detail(f.secondId), f.secondBefore);
  await h.click(h.button("引用到聊天"));
  assert.deepEqual(h.inserted, [`@[${topics[0]}](biny://crystal/${f.firstId})`]);
  assert.equal(f.requests.length, 1, "confirmation and insertion must not issue another model request");
  await f.close();
});
