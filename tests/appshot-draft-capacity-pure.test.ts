import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { Script, createContext } from "node:vm";

// Only repository source is read. No React/App/native/IPC module is imported.
const app = readFileSync(new URL("../src/desktop/renderer/src/App.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/desktop/renderer/src/components/Composer.tsx", import.meta.url), "utf8");
const draftSource = readFileSync(new URL("../src/desktop/renderer/src/components/composer/composerDraft.ts", import.meta.url), "utf8");
function between(source: string, start: string, end: string, includeEnd = false): string {
  assert.equal(source.split(start).length, 2, `unique start: ${start}`);
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset + start.length);
  assert.ok(finish > offset, `complete end: ${end}`);
  assert.equal(source.indexOf(end, finish + end.length), -1, `unique following end: ${end}`);
  return source.slice(offset, finish + (includeEnd ? end.length : 0));
}
const effect = between(app, "  useEffect(() => {\n    const api = window.binyAppshots;", "  }, [composerDrafts]);", true);
const addFiles = between(composer, "  const addFiles = async (files: File[]): Promise<void> => {", "  const requestStop =");
const setters = between(composer, "  const setAttachments =", "  const [capabilitySelection,");
const draftClass = draftSource.slice(draftSource.indexOf("export class ComposerDraftState")).replace("export class", "class");
assert.ok(draftClass.startsWith("class ComposerDraftState"));
assert.equal(draftSource.split("export class ComposerDraftState").length, 2);
const errorMessage = composer.slice(composer.indexOf("function errorMessage(error: unknown): string {"));
assert.equal(composer.split("function errorMessage(error: unknown): string {").length, 2);
const limits = ["MAX_COMPOSER_ATTACHMENTS", "MAX_ATTACHMENT_BYTES"].map(name => {
  const match = composer.match(new RegExp(`^const ${name} = [\\d *]+;$`, "mu"));
  assert.ok(match); return match[0];
}).join("\n");
const code = `${draftClass}\n${errorMessage}\n${limits}
function mount() { ${effect} }
function bindAddFiles(draftState) {
  const attachments = draftState.getSnapshot().attachments;
  const pendingAttachments = draftState.getSnapshot().pendingAttachments;
  const addingFiles = { current: false };
  ${setters}
  ${addFiles}
  return addFiles;
}
({ ComposerDraftState, mount, bindAddFiles });`;
const script = new Script(stripTypeScriptTypes(code, { mode: "strip" }), { filename: "inert-appshot-capacity.js" });

interface Attachment { name: string; path: string; mimeType: string; size: number; }
interface Pending { id: string; name: string; mimeType: string; size: number; status: "uploading" | "error"; error?: string; }
interface Snapshot { draft: { value: string; tokens: unknown[] }; history: unknown[]; attachments: Attachment[]; pendingAttachments: Pending[]; submitting: boolean; }
interface Draft { getSnapshot(): Snapshot; update(change: Partial<Snapshot> | ((current: Snapshot) => Partial<Snapshot>)): void; }
type Event = { type: "starting" | "captured"; id: string; target: "current" | "new"; source: { appName: string } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const attachment = (name: string): Attachment => ({ name, path: `@attachments/fixture-${name}`, mimeType: "text/plain", size: 4 });
const pending = (index: number, status: Pending["status"] = "uploading"): Pending => ({ id: `pending-${index}`, name: `pending-${index}.txt`, mimeType: "text/plain", size: 4, status });
const fullWarning = "聊天附件已满，请移除一个附件后重新截图。";

function fixture(options: { project?: string; session?: string; missingProject?: true; noApi?: true } = {}) {
  const warnings: string[] = [];
  const navigations: Array<{ projectId: string; sessionId?: string }> = [];
  const settings: boolean[] = [];
  const toasts: string[] = [];
  const busy: boolean[] = [];
  const violations: string[] = [];
  const attaches: Array<{ projectId: string; id: string; gate: ReturnType<typeof deferred<Attachment>> }> = [];
  const saves: Array<{ name: string; gate: ReturnType<typeof deferred<Attachment>> }> = [];
  const tasks: Promise<unknown>[] = [];
  const composerDrafts = new Map<string, Draft>();
  const projectRef = { current: options.missingProject ? undefined : options.project ?? "p" };
  const selectedRef = { current: options.session };
  let listener: ((event: Event) => void) | undefined;
  let cleanup: (() => void) | undefined;
  let unsubscribed = 0;
  let uuid = 0;
  let focus = 0;
  const fail = (name: string): never => { violations.push(name); throw new Error(`Unexpected capability: ${name}`); };
  // Track the full then/catch chain started by the exact effect so tests await
  // its real completion, not a timing delay or guessed microtask count.
  const api = {
    onEvent(callback: (event: Event) => void) { listener = callback; return () => { unsubscribed += 1; }; },
    attach(projectId: string, id: string) {
      const gate = deferred<Attachment>(); attaches.push({ projectId, id, gate });
      return {
        then(onFulfilled: (value: Attachment) => unknown) {
          const chain = gate.promise.then(onFulfilled); tasks.push(chain);
          return {
            catch(onRejected: (reason: unknown) => unknown) {
              const terminal = chain.catch(onRejected); tasks.push(terminal); return terminal;
            }
          };
        }
      };
    }
  };
  const context = createContext({
    Error,
    window: options.noApi ? {} : { binyAppshots: api },
    composerDrafts, projectRef, selectedRef,
    useEffect: (run: () => (() => void) | undefined, dependencies: unknown[]) => {
      assert.equal(dependencies.length, 1); assert.equal(dependencies[0], composerDrafts); cleanup = run();
    },
    appshotNavigation: { current: async (target: { projectId: string; sessionId?: string }) => { navigations.push({ ...target }); } },
    setSettingsOpen: (value: boolean) => { settings.push(value); },
    setFocusToken: (update: (value: number) => number) => { focus = update(focus); },
    setToast: (value: string) => { toasts.push(value); },
    setWarning: (value: string) => { warnings.push(value); },
    onWarning: (value: string) => { warnings.push(value); },
    externalAgent: false, editing: false, project: { id: "p" }, busy: false,
    submitFlightRef: { current: false }, sessionWriterConflict: false,
    setBusy: (value: boolean) => { busy.push(value); },
    onSaveAttachment: (file: { name: string }) => { const gate = deferred<Attachment>(); saves.push({ name: file.name, gate }); return gate.promise; },
    crypto: { randomUUID: () => `synthetic-${++uuid}` },
    fetch: () => fail("fetch"), setTimeout: () => fail("timer"),
    process: new Proxy({}, { get: () => fail("process") })
  }, { codeGeneration: { strings: false, wasm: false } });
  const product = script.runInContext(context, { timeout: 1000 }) as {
    ComposerDraftState: new () => Draft;
    mount(): void;
    bindAddFiles(draft: Draft): (files: Array<{ name: string; size: number; type: string }>) => Promise<void>;
  };
  product.mount();
  const draft = (key = "p:draft"): Draft => {
    let state = composerDrafts.get(key);
    if (!state) { state = new product.ComposerDraftState(); composerDrafts.set(key, state); }
    return state;
  };
  const emit = (type: Event["type"], id = "capture", target: Event["target"] = "current"): void => {
    assert.ok(listener); listener({ type, id, target, source: { appName: "Fixture" } });
  };
  const settle = async (index = 0, failure = false): Promise<void> => {
    const request = attaches[index]; assert.ok(request);
    if (failure) request.gate.reject(new Error("synthetic attach failed"));
    else request.gate.resolve(attachment(`${request.id}.jpg`));
    // Both chains were created synchronously by the effect's then/catch calls.
    await Promise.allSettled([...tasks]);
    assert.deepEqual(violations, []);
  };
  return { draft, composerDrafts, projectRef, selectedRef, warnings, navigations, settings, toasts, busy, attaches, saves,
    emit, settle, cleanup: () => cleanup?.(), unsubscribed: () => unsubscribed, focus: () => focus,
    upload: (count: number, state = draft()) => product.bindAddFiles(state)(Array.from({ length: count }, (_, i) => ({ name: `file-${i}.txt`, size: 4, type: "text/plain" }))),
    assertSafe: () => assert.deepEqual(violations, []) };
}

for (const [name, savedCount, uploading, failed, rejected] of [
  ["eight uploading slots reject capture", 0, 8, 0, true],
  ["mixed saved and uploading slots reject capture", 3, 5, 0, true],
  ["failed pending slot still reserves capacity", 7, 0, 1, true],
  ["eight failed pending slots reject capture", 0, 0, 8, true],
  ["mixed uploading and failed slots reject capture", 4, 2, 2, true],
  ["eight saved attachments keep existing rejection", 8, 0, 0, true],
  ["seven saved attachments admit final slot", 7, 0, 0, false],
  ["seven combined slots admit final slot", 2, 5, 0, false],
  ["empty draft admits capture", 0, 0, 0, false]
] as const) {
  test(`Appshots draft capacity: ${name}`, async () => {
    const h = fixture(); const state = h.draft();
    const original = Array.from({ length: savedCount }, (_, i) => attachment(`old-${i}.txt`));
    const reserved = [...Array.from({ length: uploading }, (_, i) => pending(i)), ...Array.from({ length: failed }, (_, i) => pending(uploading + i, "error"))];
    state.update({ attachments: original, pendingAttachments: reserved });
    h.emit("starting"); h.emit("captured"); await h.settle();
    assert.deepEqual(Array.from(state.getSnapshot().attachments), rejected ? original : [...original, attachment("capture.jpg")]);
    assert.equal(state.getSnapshot().pendingAttachments, reserved);
    assert.deepEqual(h.warnings, rejected ? [fullWarning] : []);
    assert.equal(h.navigations.length, rejected ? 0 : 1);
    assert.deepEqual(h.settings, rejected ? [] : [false]);
    assert.equal(h.focus(), rejected ? 0 : 1); assert.equal(h.toasts.length, rejected ? 0 : 1); h.assertSafe();
  });
}

for (const count of [8, 7]) {
  test(`Appshots draft capacity: actual addFiles preserves all ${count} selected results`, async () => {
    const h = fixture(); const uploading = h.upload(count);
    assert.equal(h.saves.length, count); assert.equal(h.draft().getSnapshot().pendingAttachments.length, count);
    h.emit("starting"); h.emit("captured"); await h.settle();
    for (const save of [...h.saves].reverse()) save.gate.resolve(attachment(save.name));
    await uploading;
    const expected = [...(count === 7 ? [attachment("capture.jpg")] : []), ...h.saves.map(save => attachment(save.name))];
    assert.deepEqual(Array.from(h.draft().getSnapshot().attachments), expected, "No originally selected file may be silently sliced off by a late screenshot");
    assert.equal(h.draft().getSnapshot().pendingAttachments.length, 0);
    assert.deepEqual(h.warnings, count === 8 ? [fullWarning] : []);
    assert.deepEqual(h.busy, [true, false]); h.assertSafe();
  });
}

test("Appshots draft capacity: capacity is re-read after attach resolves", async () => {
  const h = fixture(); h.emit("starting"); h.emit("captured");
  h.draft().update({ pendingAttachments: Array.from({ length: 8 }, (_, i) => pending(i)) });
  await h.settle(); assert.equal(h.draft().getSnapshot().attachments.length, 0); assert.deepEqual(h.warnings, [fullWarning]);
});

test("Appshots draft capacity: removing a pending item frees its reserved slot", async () => {
  const h = fixture(); const state = h.draft();
  state.update({ pendingAttachments: Array.from({ length: 8 }, (_, i) => pending(i)) });
  h.emit("starting"); h.emit("captured");
  state.update(current => ({ pendingAttachments: current.pendingAttachments.filter(item => item.id !== "pending-0") }));
  await h.settle(); assert.equal(state.getSnapshot().attachments.length, 1); assert.equal(state.getSnapshot().pendingAttachments.length, 7); assert.deepEqual(h.warnings, []);
});

test("Appshots draft capacity: captured target stays original after navigation", async () => {
  const h = fixture({ session: "source" });
  h.draft("p:source").update({ pendingAttachments: Array.from({ length: 8 }, (_, i) => pending(i)) });
  h.emit("starting"); h.projectRef.current = "q"; h.selectedRef.current = "other"; h.emit("captured");
  await h.settle(); assert.equal(h.attaches[0]?.projectId, "p");
  assert.equal(h.draft("p:source").getSnapshot().attachments.length, 0); assert.equal(h.composerDrafts.has("q:other"), false); assert.deepEqual(h.warnings, [fullWarning]);
});

test("Appshots draft capacity: another full draft does not block original target", async () => {
  const h = fixture({ session: "source" }); h.emit("starting");
  h.projectRef.current = "q"; h.selectedRef.current = "other";
  h.draft("q:other").update({ attachments: Array.from({ length: 8 }, (_, i) => attachment(`other-${i}`)) });
  h.emit("captured"); await h.settle();
  assert.equal(h.draft("p:source").getSnapshot().attachments.length, 1); assert.equal(h.draft("q:other").getSnapshot().attachments.length, 8);
  assert.deepEqual(h.navigations, [{ projectId: "p", sessionId: "source" }]);
});

test("Appshots draft capacity: new target checks project draft instead of selected session", async () => {
  const h = fixture({ session: "source" });
  h.draft().update({ pendingAttachments: Array.from({ length: 8 }, (_, i) => pending(i, "error")) });
  h.emit("starting", "capture", "new"); h.emit("captured", "capture", "new"); await h.settle();
  assert.equal(h.draft().getSnapshot().attachments.length, 0); assert.equal(h.composerDrafts.has("p:source"), false); assert.deepEqual(h.warnings, [fullWarning]);
});

test("Appshots draft capacity: effect cleanup rejects a late successful attach", async () => {
  const h = fixture(); h.emit("starting"); h.emit("captured"); h.cleanup(); await h.settle();
  assert.equal(h.composerDrafts.size, 0); assert.equal(h.unsubscribed(), 1); assert.deepEqual(h.warnings, []); assert.deepEqual(h.navigations, []);
});

test("Appshots draft capacity: attach failure keeps draft and existing warning", async () => {
  const h = fixture(); const state = h.draft(); const before = state.getSnapshot();
  h.emit("starting"); h.emit("captured"); await h.settle(0, true);
  assert.equal(state.getSnapshot(), before); assert.deepEqual(h.warnings, ["synthetic attach failed"]); assert.deepEqual(h.navigations, []);
});

test("Appshots draft capacity: missing API does not subscribe or mutate", () => {
  const h = fixture({ noApi: true }); assert.equal(h.composerDrafts.size, 0); assert.equal(h.attaches.length, 0); h.cleanup(); h.assertSafe();
});

test("Appshots draft capacity: missing starting project keeps existing rejection", () => {
  const h = fixture({ missingProject: true }); h.emit("starting"); h.emit("captured");
  assert.deepEqual(h.warnings, ["请先选择截图要进入的项目，再重试。"]); assert.equal(h.attaches.length, 0); h.assertSafe();
});
