/** Source-selected App entry/navigation callbacks and real draft store/normalizer.
 * IPC and React scheduling are explicit inert boundaries; this is not a DOM test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const renderer = new URL("../src/desktop/renderer/src/", import.meta.url);
const app = readFileSync(new URL("App.tsx", renderer), "utf8");
const composer = readFileSync(new URL("components/Composer.tsx", renderer), "utf8");
function evaluate(source: string, values: Record<string, unknown> = {}): any {
  const body = source.replace(/^import type [^\n]+;\n/gmu, "");
  const emitted = stripTypeScriptTypes(`(function(${Object.keys(values).join(",")}) { ${body} })`, { mode: "strip" });
  return new Function(`return ${emitted}`)()(...Object.values(values));
}
function required(source: string, pattern: RegExp): string {
  const match = source.match(pattern); assert.ok(match, `Missing production selection ${pattern}`); return match[1]!;
}
function callback(name: string): string {
  return required(app, new RegExp(`^  const ${name} = (useCallback\\([\\s\\S]*?^  }, \\[[^\\n]*\\]\\));`, "m"));
}
const draftSource = readFileSync(new URL("components/composer/composerDraft.ts", renderer), "utf8");
const referenceSource = readFileSync(new URL("components/composer/referenceCompletion.ts", renderer), "utf8");
const ComposerDraftState = evaluate(`${draftSource.replaceAll("export ", "")}\nreturn ComposerDraftState;`);
const normalizeDraftReferences = evaluate(`${referenceSource.replaceAll("export ", "")}\nreturn normalizeDraftReferences;`);
const mountDraft = required(composer, /const \[draftState\] = useState\(\(\) => \{([\s\S]*?)\n {2}\}\);/u);
const prefillEffect = composer.match(/useEffect\(\(\) => \{\n( {4}if \(prefillInput === undefined\)[\s\S]*?)\n {2}\}, \[prefillInput, draftState\]\);/u)?.[1];
const draftKey = required(app, /\n {6}draftKey=\{([^\n]+)\}/u);
const projectDeclaration = required(app, /\n {2}(const composerProject = [\s\S]*?);\n/u);
const keyDeclaration = app.match(/\n {2}(const composerDraftKey = [^\n]+);\n/u)?.[1] ?? "";
function deferred() {
  let resolve!: (value: unknown) => void; let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const drafts = new Map<string, any>();
  const reads: ReturnType<typeof deferred>[] = [];
  const commitments: unknown[][] = [];
  const recipes: unknown[][] = [];
  let selectedSessionId: string | undefined = "a";
  let draftProjectId: string | undefined;
  let workspace = { project: { id: "p" }, sessions: [] };
  let transient: string | undefined;
  let lastKey: string | undefined;
  let lastPrefill: string | undefined;
  let active: any;
  let focus = 0;
  const noop = () => {};
  const refs = { projectRef: { current: "p" }, selectedRef: { current: "a" as string | undefined },
    projectRemovalRef: { current: new Map() }, loadRequestRef: { current: 0 },
    memoryToggleRequestRef: { current: 0 }, permissionModeRequestRef: { current: 0 } };
  function values(): Record<string, unknown> {
    return { ...refs, workspace, selectedSessionId, draftProjectId, projects: [{ id: "p" }, { id: "q" }],
      ComposerDraftState, normalizeDraftReferences, composerDrafts: drafts,
      useCallback: (fn: unknown) => fn,
      setComposerDraft: (value: string | undefined) => { transient = value; },
      setFocusToken: (change: (value: number) => number) => { focus = change(focus); },
      setPendingNavigation: noop, setMemoryToggleBusy: noop, setLoading: noop,
      selectProject: () => { throw new Error("Unexpected project navigation"); },
      setRuntimePanelOpen: noop, setSelectedSessionId: (id: string) => { selectedSessionId = id; },
      setDraftProjectId: (id: string | undefined) => { draftProjectId = id; },
      setDraftMemoryOverride: noop, setContextBudget: noop, setDocument: noop, setWriterConflict: noop,
      sessionTreePages: { observe: noop }, setSidebarSessions: noop,
      mergeProjectSessionPage: (current: unknown) => current,
      setWorkspace: (change: (value: unknown) => typeof workspace) => { workspace = change(workspace); },
      mergeWorkspaceProject: (value: typeof workspace) => { workspace = value; },
      readDesktopSession: () => { const gate = deferred(); reads.push(gate); return gate.promise; },
      window: { biny: {
        commitSelection: async (...args: unknown[]) => { commitments.push(args); },
        setRecipeState: async (...args: unknown[]) => { recipes.push(args); }
      } }, setWarning: (error: unknown) => { throw error; }, errorMessage: String,
      dismissedRecipeIdsRef: { current: new Set() }, setRecipeNotices: noop, setToast: noop
    };
  }
  function scope() {
    return evaluate(`${projectDeclaration}; ${keyDeclaration}; return { key: ${draftKey}, prefillComposer: ${callback("prefillComposer")} };`, values());
  }
  function render() {
    const { key } = scope();
    if (lastKey !== key) active = evaluate(mountDraft, { drafts, draftKey: key, ComposerDraftState });
    if (prefillEffect && (lastKey !== key || lastPrefill !== transient)) {
      evaluate(prefillEffect, { prefillInput: transient, draftState: active, normalizeDraftReferences, inputRef: { current: { focus: noop } } });
    }
    lastKey = key; lastPrefill = transient;
    return active;
  }
  function invoke(kind: "recipe" | "preview" | "prefill", text: string) {
    const bound = { ...values(), prefillComposer: scope().prefillComposer };
    if (kind === "recipe") evaluate(`return ${callback("extractRecipe")};`, bound)({ id: "recipe", extractPrompt: text });
    else if (kind === "preview") {
      const body = required(app, /onFixPreview: \(error\) => \{([\s\S]*?)\n {4}\},/u);
      evaluate(body, { ...bound, error: text });
    } else scope().prefillComposer(text);
    render();
  }
  function navigate(project: string, id: string) {
    return evaluate(`return ${callback("openSession")};`, values())(project, id);
  }
  async function finish(index: number, project: string, id: string, promise: Promise<boolean>) {
    reads[index]!.resolve({ document: { session: { id }, events: [] }, workspace: { project: { id: project }, sessions: [] } });
    const result = await promise; render(); return result;
  }
  function seed(key: string, text: string) {
    const state = drafts.get(key) ?? new ComposerDraftState();
    const draft = normalizeDraftReferences(text, []);
    state.update({ draft, history: [{ before: { value: "", tokens: [] }, after: draft }],
      attachments: [{ name: "draft.txt", path: "synthetic/draft.txt" }], pendingAttachments: [{ id: "pending" }] });
    drafts.set(key, state); return state;
  }
  render();
  return { drafts, reads, commitments, recipes, render, invoke, navigate, finish, seed,
    current: () => active, focus: () => focus,
    folder: (id: string) => {
      selectedSessionId = undefined; refs.selectedRef.current = undefined;
      evaluate(`return ${callback("selectComposerProject")};`, values())(id); render();
    },
    unmount: () => { lastKey = undefined; active = undefined; } };
}

for (const entry of ["recipe", "preview"] as const) {
  test(`${entry} prefill does not replace another existing session's saved text/history`, async () => {
    const h = fixture(); const b = h.seed("p:b", "saved B"); const original = b.getSnapshot();
    h.invoke(entry, "repair this"); const a = h.current().getSnapshot();
    const navigation = h.navigate("p", "b"); assert.equal(await h.finish(0, "p", "b", navigation), true);
    assert.strictEqual(h.current().getSnapshot(), original);
    assert.strictEqual(h.drafts.get("p:a").getSnapshot(), a);
  });
  test(`${entry} prefill preserves edits after navigating away and back`, async () => {
    const h = fixture(); h.invoke(entry, "repair this");
    const edited = h.seed("p:a", "user refined prefill").getSnapshot();
    await h.finish(0, "p", "b", h.navigate("p", "b"));
    await h.finish(1, "p", "a", h.navigate("p", "a"));
    assert.strictEqual(h.current().getSnapshot(), edited);
  });
  test(`${entry} prefill stays on visible session while failed navigation is pending`, async () => {
    const h = fixture(); h.invoke(entry, "repair this");
    const pending = h.navigate("q", "b"); h.invoke(entry, "new repair");
    const original = h.current().getSnapshot();
    h.reads[0]!.reject(new Error("read failed")); await assert.rejects(pending, /read failed/u); h.render();
    assert.strictEqual(h.current().getSnapshot(), original); assert.equal(h.commitments.length, 0);
  });
}
test("same-session explicit prefill replaces text/reset history but preserves attachments", () => {
  const h = fixture(); const before = h.seed("p:a", "old").getSnapshot();
  h.invoke("prefill", "new"); const after = h.current().getSnapshot();
  assert.equal(after.draft.value, "new"); assert.deepEqual(after.history, []);
  assert.strictEqual(after.attachments, before.attachments); assert.strictEqual(after.pendingAttachments, before.pendingAttachments);
  assert.equal(h.focus(), 1);
});
test("repeated identical explicit prefill is a new edit, not an unchanged string prop", () => {
  const h = fixture(); h.invoke("prefill", "same"); h.seed("p:a", "user changed it");
  h.invoke("prefill", "same"); assert.equal(h.current().getSnapshot().draft.value, "same");
  assert.deepEqual(h.current().getSnapshot().history, []); assert.equal(h.focus(), 2);
});
test("cross-project navigation preserves saved destination draft", async () => {
  const h = fixture(); const original = h.seed("q:b", "other project").getSnapshot();
  h.invoke("recipe", "extract"); await h.finish(0, "q", "b", h.navigate("q", "b"));
  assert.strictEqual(h.current().getSnapshot(), original);
});
test("obsolete successful navigation cannot move a prefill to a newer destination", async () => {
  const h = fixture(); h.invoke("recipe", "extract");
  const b = h.seed("p:b", "B").getSnapshot(); const c = h.seed("p:c", "C").getSnapshot();
  const old = h.navigate("p", "b"); const newer = h.navigate("p", "c");
  assert.equal(await h.finish(1, "p", "c", newer), true);
  assert.equal(await h.finish(0, "p", "b", old), false);
  assert.strictEqual(h.current().getSnapshot(), c); assert.strictEqual(h.drafts.get("p:b").getSnapshot(), b);
});
test("folder-owned blank drafts receive prefill without replacing another folder's draft", () => {
  const h = fixture(); const original = h.seed("p:draft", "P draft").getSnapshot();
  h.folder("q"); h.invoke("prefill", "Q prefill"); h.folder("p");
  assert.strictEqual(h.current().getSnapshot(), original);
  assert.equal(h.drafts.get("q:draft").getSnapshot().draft.value, "Q prefill");
});
test("remount of current session does not replay prefill over later edits", () => {
  const h = fixture(); h.invoke("prefill", "suggestion"); const edited = h.seed("p:a", "edited").getSnapshot();
  h.unmount(); h.render(); assert.strictEqual(h.current().getSnapshot(), edited);
});
test("prefill during pending successful navigation stays with the still-visible source", async () => {
  const h = fixture(); const target = h.seed("p:b", "B saved").getSnapshot();
  const pending = h.navigate("p", "b"); h.invoke("recipe", "extract from A");
  const source = h.current().getSnapshot(); await h.finish(0, "p", "b", pending);
  assert.strictEqual(h.current().getSnapshot(), target);
  assert.strictEqual(h.drafts.get("p:a").getSnapshot(), source);
});
test("same-session navigation keeps subsequent edits rather than replaying earlier prefill", async () => {
  const h = fixture(); h.invoke("prefill", "initial"); const edited = h.seed("p:a", "edited").getSnapshot();
  await h.finish(0, "p", "a", h.navigate("p", "a"));
  assert.strictEqual(h.current().getSnapshot(), edited);
});
test("prefill creates the owned draft even before Composer mounts", () => {
  const h = fixture(); h.unmount(); h.drafts.delete("p:a"); h.invoke("prefill", "from settings");
  assert.equal(h.current().getSnapshot().draft.value, "from settings");
  assert.strictEqual(h.current(), h.drafts.get("p:a"));
});
