/** Real picker/Composer DOM with extracted App callbacks; only files, storage and IPC are synthetic. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import type { LocalReferenceResult } from "../src/session/localReferences.js";
import type { DesktopAttachment, DesktopProject } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function declaration(source: ts.SourceFile, name: string): string {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item =>
      (ts.isIdentifier(item.name) && item.name.text === name) || (ts.isArrayBindingPattern(item.name)
        && item.name.elements.some(element => ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name)))) found = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `Missing production declaration: ${name}`);
  return found.getText(source);
}
async function fixture(t: TestContext, initialSessionId?: string, legacyDraftProject = false) {
  const cleanup: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Draft-project fixture cleanup failed");
  });
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    cleanup.push(() => { if (previous) Object.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key); });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  let networkCalls = 0;
  const blockNetwork = (): never => { networkCalls++; throw new Error("Unexpected network request"); };
  cleanup.push(() => assert.equal(networkCalls, 0));
  replace(globalThis, "fetch", blockNetwork);
  replace(Socket.prototype, "connect", blockNetwork);
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://draft.test" });
  cleanup.push(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  class LayoutObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  const frame = (): number => 0;
  const noop = (): void => {};
  for (const [key, value] of Object.entries({
    window, document, self: window, navigator: window.navigator, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, Node: window.Node,
    MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: LayoutObserver, requestAnimationFrame: frame, cancelAnimationFrame: noop, IS_REACT_ACT_ENVIRONMENT: true
  })) replace(globalThis, key, value);
  replace(window, "fetch", blockNetwork);
  replace(window, "requestAnimationFrame", frame);
  replace(window, "cancelAnimationFrame", noop);
  replace(window, "matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  replace(document, "fonts", { addEventListener() {}, removeEventListener() {} });
  replace(window.HTMLCanvasElement.prototype, "getContext", () => null);
  replace(window.HTMLElement.prototype, "scrollIntoView", noop);
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const directory = await mkdtemp(path.resolve(".draft-project-test-"));
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }); });
  const app = ts.createSourceFile("App.tsx", await readFile("src/desktop/renderer/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const manager = ts.createSourceFile("DesktopAgentManager.ts", await readFile("src/desktop/electron/main/DesktopAgentManager.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const inspectorSource = ts.createSourceFile("useWorkspaceInspector.tsx", await readFile("src/desktop/renderer/src/components/workspace/useWorkspaceInspector.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ipc = ts.createSourceFile("ipc.ts", await readFile("src/desktop/electron/main/ipc.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const composerText = declaration(app, "composer");
  const composerNode = ts.createSourceFile("composer.tsx", composerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selectedProps = new Set(["key", "draftKey", "drafts", "isSubmissionCurrent", "project", "onSaveAttachment", "onSend", "onInspectReference", "prefillInput", "draftProjectId", "skills", "toolCatalog", "onRefreshCatalog"]);
  const attributes: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(composerNode) === "Composer") {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && selectedProps.has(attribute.name.getText(composerNode))) attributes.push(attribute.getText(composerNode));
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(composerNode);
  assert.equal(attributes.length, selectedProps.size - (attributes.some(attribute => attribute.startsWith("draftProjectId=")) ? 0 : 1));
  let catalogEffect: ts.Node | undefined;
  const findCatalogEffect = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(app) === "useEffect" && node.getText(app).includes("window.biny.skillCatalog(projectId)")) catalogEffect = node;
    ts.forEachChild(node, findCatalogEffect);
  };
  findCatalogEffect(app);
  assert.ok(catalogEffect, "Missing production catalog effect");
  const source = `
    import React, {useCallback, useEffect, useRef, useState} from 'react';
    import { z } from 'zod';
    import {Composer} from './src/desktop/renderer/src/components/Composer.js';
    import {ComposerDraftState} from './src/desktop/renderer/src/components/composer/composerDraft.js';
    import {WorkspaceContextBar} from './src/desktop/renderer/src/components/project/WorkspaceContextBar.js';
    import {WorkspaceReferencesPanel} from './src/desktop/renderer/src/components/workspace/WorkspaceReferencesPanel.js';
    import {createNavigationState, pushNavigation, replaceNavigation} from './src/desktop/renderer/src/navigationHistory.js';
    import {syntheticSession} from './src/desktop/renderer/src/app/desktopState.js';
    ${declaration(ipc, "attachmentSchema")}
    export {WorkspaceReferencesPanel};
    export const normalizeAttachments = value => z.array(attachmentSchema).max(20).parse(value);
    export function attachmentLoader(readAttachment) { ${declaration(manager, "loadAgentAttachments")} return loadAgentAttachments; }
    const noop = () => {};
    const errorMessage = error => error instanceof Error ? error.message : String(error);
    export function Harness({projects, base, sessionId, legacyDraftProject}) {
      const workspace = {project: projects[0], sessions: []};
      const projectRef = useRef(projects[0].id);
      const selectedRef = useRef(sessionId);
      const [selectedSessionId, setSelectedSessionId] = useState(sessionId);
      const [document, setDocument] = useState();
      const [, setPendingPrompt] = useState();
      const [generationError, setGenerationError] = useState();
      const setWarning = base.onWarning;
      const settingsOpen = false;
      const composerResourceRevision = 0;
      ${declaration(app, "composerSkillWarnings")}
      ${declaration(app, "composerSkills")}
      ${declaration(app, "composerTools")}
      ${declaration(app, "composerCatalogNonce")}
      ${declaration(app, "refreshComposerCatalog")}
      ${catalogEffect.getText(app)}
      const [reference, setReference] = useState();
      const openInspector = noop;
      ${declaration(inspectorSource, "previewReference")}
      const inspector = {previewReference};
      ${declaration(app, "composerDraft")}
      const setFocusToken = noop;
      ${declaration(app, "prefillComposer")}
      const draftMemoryOverride = undefined;
      const setDraftMemoryOverride = noop;
      const loadRequestRef = useRef(0);
      const projectRemovalRef = useRef(new Map());
      const navigationRef = useRef(createNavigationState());
      const commitNavigation = noop;
      const openSession = async () => true;
      const refreshRuntimeFailure = async () => {};
      const loading = false;
      const selectProject = async () => { throw new Error('Unexpected workspace navigation'); };
      ${declaration(app, "draftProjectId")}
      ${declaration(app, "composerDrafts")}
      ${declaration(app, "composerProject")}
      ${declaration(app, "selectComposerProject")}
      ${declaration(app, "saveAttachment")}
      ${declaration(app, "sendPrompt")}
      ${declaration(app, "sendPromptWithTransition")}
      return <><button onClick={() => prefillComposer("Suggested text")}>Prefill draft</button><WorkspaceContextBar project={composerProject} projects={projects} branches={[]} branchesLoading={false}
        onSelectProject={selectComposerProject} onCreateProject={noop} onCreateBranch={async () => {}} onOpenBranches={noop} onSelectBranch={noop} />
        <Composer {...base} ${attributes.join(" ")} {...(legacyDraftProject ? {draftProjectId: undefined} : {})} onSubmitError={setGenerationError} />
        <output data-error>{generationError}</output>
        {reference ? <WorkspaceReferencesPanel projectId={workspace.project.id} reference={reference} onSelect={setReference} /> : null}</>;
    }
  `;
  await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "draft-project-fixture.tsx", loader: "tsx" },
    outfile: path.join(directory, "fixture.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" } });
  const module = await import(pathToFileURL(path.join(directory, "fixture.mjs")).href) as {
    Harness: React.ComponentType<{ projects: DesktopProject[]; base: Record<string, unknown>; sessionId?: string; legacyDraftProject: boolean }>;
    WorkspaceReferencesPanel: React.ComponentType<{ projectId: string; reference?: LocalReferenceResult; onSelect(reference: LocalReferenceResult): void }>;
    normalizeAttachments(value: unknown): DesktopAttachment[];
    attachmentLoader(read: (root: string, attachment: DesktopAttachment) => Promise<DesktopAttachment | undefined>):
      (root: string, attachments: DesktopAttachment[]) => Promise<DesktopAttachment[]>;
  };
  const projects: DesktopProject[] = ["a", "b"].map(id => ({ id, name: id.toUpperCase(), path: `/synthetic/${id}`, dirty: false, missing: false, pinned: false, addedAt: "", lastOpenedAt: "" }));
  const storage = new Map<string, Uint8Array>();
  const saves: Array<{ projectId: string; attachment: DesktopAttachment }> = [];
  const sends: Array<{ projectId: string; sessionId?: string; text: string; attachments: DesktopAttachment[]; accepted: boolean }> = [];
  const reads: string[] = [];
  const catalogReads: string[] = [];
  const warnings: string[] = [];
  const byteGates: Array<ReturnType<typeof deferred<ArrayBuffer>>> = [];
  const saveGates: Array<ReturnType<typeof deferred<void>>> = [];
  let holdSave = false;
  let holdReferenceReads = false;
  const referenceGates: Array<{ projectId: string; uri: string; gate: ReturnType<typeof deferred<LocalReferenceResult>> }> = [];
  const loader = module.attachmentLoader(async (root, attachment) => {
    const key = `${root}/${attachment.path}`;
    reads.push(key);
    return storage.has(key) ? attachment : undefined;
  });
  replace(window, "biny", {
    async saveAttachment(projectId: string, name: string, mimeType: string, bytes: Uint8Array) {
      const attachment = { name, mimeType, size: bytes.byteLength, path: `@attachments/${saves.length}-${name}` };
      saves.push({ projectId, attachment });
      if (holdSave) { const gate = deferred<void>(); saveGates.push(gate); await gate.promise; }
      storage.set(`/synthetic/${projectId}/${attachment.path}`, bytes);
      return attachment;
    },
    async sendPrompt(projectId: string, sessionId: string | undefined, text: string, payload: unknown) {
      const attachments = module.normalizeAttachments(payload);
      const send = { projectId, sessionId, text, attachments, accepted: false }; sends.push(send);
      await loader(`/synthetic/${projectId}`, attachments);
      send.accepted = true;
      return { sessionId: `session-${projectId}`, runId: "run", messageId: "message" };
    },
    async selectProject() { return {}; },
    async skillCatalog(projectId: string) { catalogReads.push(`skills:${projectId}`); return {skills: [], warnings: []}; },
    async skillSettings(projectId: string) { catalogReads.push(`settings:${projectId}`); return {activations: []}; },
    async toolCatalog(projectId: string) { catalogReads.push(`tools:${projectId}`); return [{name: `${projectId}_catalog_tool`, source: "builtin", description: `Catalog from ${projectId}`}]; },
    async mcpSnapshot(projectId: string) { reads.push(`mcp:${projectId}`); return {servers: [{name: "synthetic-mcp", enabled: true, state: "not-started"}]}; },
    async mcpReconnect(projectId: string, name: string) { reads.push(`reconnect:${projectId}:${name}`); },
    async readInlineImage() { return undefined; },
    async referenceSearch(projectId: string) {
      reads.push(`reference:${projectId}`);
      return [{kind: "file", uri: "biny://file/shared.txt", label: "shared.txt", content: "shared.txt", projectId}];
    },
    async referenceResolve(projectId: string, uri: string) {
      reads.push(`resolve:${projectId}:${uri}`);
      if (holdReferenceReads) {
        const gate = deferred<LocalReferenceResult>(); referenceGates.push({projectId, uri, gate});
        return gate.promise;
      }
      return {kind: "file", uri, label: "shared.txt", content: `Content from ${projectId}`, projectId};
    },
    async openWorkspaceFile(projectId: string, file: string) { reads.push(`open:${projectId}:${file}`); }
  });
  const base = {
    models: [], memoryState: "enabled", memoryToggleBusy: false, memoryToggleDisabled: false,
    running: false, runtimeBusy: false, queuedMessages: [], sessionWriterConflict: false, modelSetupRequired: false,
    focusToken: 0, capabilityDefaults: {tools: "none", skills: "none"}, skills: [], toolCatalog: [],
    onChangeFastMode: noop, onMutateQueuedMessage: async () => {}, onResume: async () => {}, onSubmitEdit: async () => {},
    onCancelEdit: noop, onSlashCommand: async () => {}, onStop: async () => {}, onToggleMemory: async () => {},
    onSwitchModel: async () => {}, onWarning: (warning: string) => warnings.push(warning)
  };
  const root = createRoot(document.getElementById("root")!);
  cleanup.push(async () => { await React.act(() => root.unmount()); });
  cleanup.push(async () => { await React.act(async () => { for (const gate of byteGates) gate.resolve(new Uint8Array([1, 2, 3, 4]).buffer); for (const gate of saveGates) gate.resolve(); for (const pending of referenceGates) pending.gate.resolve({kind: "file", uri: pending.uri, label: "shared.txt", content: `Content from ${pending.projectId}`, projectId: pending.projectId}); }); });
  const render = async (sessionId?: string): Promise<void> => { await React.act(async () => root.render(React.createElement(module.Harness, {projects, base, sessionId, legacyDraftProject}))); };
  await render(initialSessionId);
  const textarea = (): HTMLTextAreaElement => { const element = document.querySelector("textarea"); assert.ok(element); return element; };
  const click = async (label: string): Promise<void> => {
    const button = [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.title === label || item.textContent === label);
    assert.ok(button, label);
    await React.act(async () => button.click());
  };
  const choose = async (projectId: string): Promise<void> => {
    await click("选择项目");
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(item => item.querySelector("strong")?.textContent === projectId.toUpperCase());
    assert.ok(option);
    await React.act(async () => option.dispatchEvent(new window.Event("pointerdown", {bubbles: true, cancelable: true})));
    assert.equal(document.querySelector('[title="选择项目"] span')?.textContent, projectId.toUpperCase());
  };
  const input = async (value: string): Promise<void> => {
    await React.act(async () => {
      const element = textarea(); assert.equal(element.disabled, false);
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new window.Event("input", {bubbles: true}));
    });
  };
  const upload = async (phase: "bytes" | "save" | "settled" = "settled"): Promise<void> => {
    holdSave = phase === "save";
    const file = new window.File(["synthetic"], "draft.txt", {type: "text/plain"});
    const gate = deferred<ArrayBuffer>(); byteGates.push(gate);
    Object.defineProperty(file, "arrayBuffer", {value: () => gate.promise});
    if (phase !== "bytes") gate.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
    const element = document.querySelector('input[type="file"]'); assert.ok(element);
    Object.defineProperty(element, "files", {configurable: true, value: [file]});
    await React.act(async () => element.dispatchEvent(new window.Event("change", {bubbles: true})));
  };
  const settle = async (): Promise<void> => { await React.act(async () => { for (const gate of byteGates) gate.resolve(new Uint8Array([1, 2, 3, 4]).buffer); for (const gate of saveGates) gate.resolve(); }); };
  const hasAttachment = (): boolean => Boolean(document.querySelector('[aria-label="移除 draft.txt"]'));
  const reference = async (): Promise<void> => {
    await React.act(async () => textarea().focus());
    await input("@shared");
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await React.act(async () => textarea().dispatchEvent(new window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true})));
  };
  const inspect = async (referenceProjectId?: string): Promise<void> => {
    await React.act(async () => root.render(React.createElement(module.WorkspaceReferencesPanel, {projectId: "a", onSelect: noop,
      reference: {kind: "file", uri: "biny://file/shared.txt", label: "shared.txt", content: "summary", projectId: referenceProjectId}})));
  };
  const settleReference = async (index: number): Promise<void> => {
    const pending = referenceGates[index]; assert.ok(pending);
    await React.act(async () => pending.gate.resolve({kind: "file", uri: pending.uri, label: "shared.txt", content: `Content from ${pending.projectId}`, projectId: pending.projectId}));
  };
  return { choose, input, upload, settle, click, textarea, hasAttachment, saves, sends, reads, catalogReads, warnings, document, reference,
    inspect, settleReference, holdReferences: () => { holdReferenceReads = true; } };

}

for (const phase of ["bytes", "save", "settled"] as const) {
  test(`new-task picker retains the source attachment across ${phase} completion and retargeting`, { timeout: 15_000 }, async t => {
    const h = await fixture(t);
    await h.input("Draft A");
    await h.upload(phase);
    await h.choose("b");
    await h.settle();
    // Dispatch through the real send button even on the old implementation, so the
    // failing payload and target-root lookup are captured rather than inferred.
    await h.input("Draft B");
    await h.click("发送消息");
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.sends[0], { projectId: "b", sessionId: undefined, text: "Draft B", attachments: [], accepted: true },
      `Picker B must not send A's project-local reference; lookups: ${JSON.stringify(h.reads)}`);
    assert.deepEqual(h.saves.map(item => item.projectId), ["a"]);
  });
}

test("settled A→B→A drafts retain their own text and attachment without migration", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.input("Draft A"); await h.upload();
  await h.choose("b");
  assert.equal(h.textarea().value, "");
  assert.equal(h.hasAttachment(), false);
  await h.input("Draft B"); await h.choose("a");
  assert.equal(h.textarea().value, "Draft A"); assert.equal(h.hasAttachment(), true);
  await h.choose("b"); assert.equal(h.textarea().value, "Draft B"); assert.equal(h.hasAttachment(), false);
  await h.choose("a"); await h.click("发送消息");
  assert.equal(h.sends[0]?.accepted, true);
  assert.equal(h.sends[0]?.projectId, "a");
  assert.equal(h.sends[0]?.attachments.length, 1);
  assert.deepEqual(h.saves.map(item => item.projectId), ["a"]);
});

for (const projectId of ["a", "b"]) {
  test(`choosing ${projectId} before upload sends and reads in the same project`, { timeout: 15_000 }, async t => {
    const h = await fixture(t);
    await h.choose(projectId); await h.upload(); await h.click("发送消息");
    assert.equal(h.sends[0]?.projectId, projectId); assert.equal(h.sends[0]?.accepted, true);
    assert.equal(h.sends[0]?.attachments.length, 1);
    assert.deepEqual(h.saves.map(item => item.projectId), [projectId]);
    assert.deepEqual(h.reads, [`/synthetic/${projectId}/@attachments/0-draft.txt`]);
  });
}


test("an existing session keeps its workspace attachment and submission identity", { timeout: 15_000 }, async t => {
  const h = await fixture(t, "existing-a");
  await h.upload(); await h.click("打开 draft.txt"); await h.click("发送消息");
  assert.equal(h.sends[0]?.projectId, "a"); assert.equal(h.sends[0]?.sessionId, "existing-a");
  assert.equal(h.sends[0]?.accepted, true);
  assert.deepEqual(h.reads, ["open:a:@attachments/0-draft.txt", "/synthetic/a/@attachments/0-draft.txt"]);
});

test("a new-task B attachment opens with B while the workspace stays in A", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.choose("b"); await h.upload(); await h.click("打开 draft.txt");
  assert.deepEqual(h.reads, ["open:b:@attachments/0-draft.txt"]);
});

test("new-task reference search and selected relative reference details use B, not workspace A", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.choose("b"); await h.reference();
  assert.deepEqual(h.reads, ["reference:b", "resolve:b:biny://file/shared.txt"]);
  assert.equal(h.document.querySelector(".inspector-reference-content")?.textContent, "Content from b");
});


for (const phase of ["bytes", "save"] as const) {
  test(`returning to A before ${phase} completion retains the pending file and text`, { timeout: 15_000 }, async t => {
    const h = await fixture(t);
    await h.input("Draft A"); await h.upload(phase); await h.choose("b");
    assert.equal(h.textarea().value, ""); assert.equal(h.textarea().disabled, false);
    await h.input("Draft B"); await h.choose("a");
    assert.equal(h.textarea().value, "Draft A"); assert.equal(h.textarea().disabled, true);
    await h.settle(); assert.equal(h.textarea().disabled, false); assert.equal(h.hasAttachment(), true);
    await h.choose("b"); assert.equal(h.textarea().value, "Draft B"); assert.equal(h.hasAttachment(), false);
  });
}

test("same-URI reference owner changes retire the earlier project detail response", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  h.holdReferences(); await h.inspect("b"); await h.inspect("a");
  assert.deepEqual(h.reads, ["resolve:b:biny://file/shared.txt", "resolve:a:biny://file/shared.txt"]);
  await h.settleReference(1); await h.settleReference(0);
  assert.equal(h.document.querySelector(".inspector-reference-content")?.textContent, "Content from a");
});

test("a legacy reference without projectId still resolves in the current workspace", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.inspect();
  assert.deepEqual(h.reads, ["resolve:a:biny://file/shared.txt"]);
  assert.equal(h.document.querySelector(".inspector-reference-content")?.textContent, "Content from a");
});


test("retargeting does not reapply a consumed prefill over another project's draft", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.choose("b"); await h.input("Existing B draft"); await h.choose("a");
  await h.click("Prefill draft"); assert.equal(h.textarea().value, "Suggested text");
  await h.input("Edited A draft"); await h.choose("b");
  assert.equal(h.textarea().value, "Existing B draft");
  await h.choose("a"); assert.equal(h.textarea().value, "Edited A draft");
});


test("new-task B keeps the workspace A capability catalog and MCP actions", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  await h.choose("b"); await h.click("工具与技能");
  assert.equal(h.document.querySelector(".capability-row strong")?.textContent, "a_catalog_tool");
  assert.deepEqual(h.catalogReads, ["skills:a", "settings:a", "tools:a"]);
  await h.click("MCP 服务器"); await h.click("连接 synthetic-mcp");
  assert.deepEqual(h.reads, ["mcp:a", "reconnect:a:synthetic-mcp", "mcp:a"]);
  assert.deepEqual(h.catalogReads, ["skills:a", "settings:a", "tools:a", "skills:a", "settings:a", "tools:a"]);
});

test("omitting the draft project keeps legacy attachment and reference ownership", { timeout: 15_000 }, async t => {
  const h = await fixture(t, undefined, true);
  await h.upload(); await h.click("打开 draft.txt"); await h.reference();
  assert.deepEqual(h.reads, ["open:a:@attachments/0-draft.txt", "reference:a", "resolve:a:biny://file/shared.txt"]);
});
