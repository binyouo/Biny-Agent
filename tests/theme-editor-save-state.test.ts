/** Real component callbacks and hooks with controlled IPC. No browser input or visual acceptance. */
import assert from 'node:assert/strict';
import type { ComponentProps, ReactNode } from 'react';
import type { SettingsThemes } from '../src/desktop/renderer/src/components/settings/SettingsThemes.js';
import type { ThemeEditor } from '../src/desktop/renderer/src/components/settings/ThemeEditor.js';
import type { SettingsPageFooter } from '../src/desktop/renderer/src/components/settings/SettingsPageFooter.js';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopStateStore } from '../src/desktop/electron/main/DesktopStateStore.js';
import { defaultConfig } from '../src/config/schema.js';
import { DEFAULT_APPEARANCE, appearancePreferenceSchema } from '../src/appearance/preferences.js';
import { BUILTIN_PALETTES } from '../src/appearance/catalog.js';
import { cloneAppearanceTheme } from '../src/appearance/editing.js';
import type { AppearancePreference } from '../src/appearance/types.js';
import type { DesktopSettingsSnapshot, DesktopSettingsSaveInput, DesktopSettingsSaveResult, DesktopWorkspaceSnapshot } from '../src/desktop/protocol.js';
type ObservedProps = {
    ThemeEditor: ComponentProps<typeof ThemeEditor>;
    SettingsThemes: ComponentProps<typeof SettingsThemes>;
    SettingsPageFooter: ComponentProps<typeof SettingsPageFooter>;
};
type ElementProps = Record<string, unknown> & {
    children?: ReactNode;
};
const observedNames = ['ThemeEditor', 'SettingsThemes', 'SettingsPageFooter'] as const;
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function snapshot(): DesktopSettingsSnapshot {
    const c = structuredClone(defaultConfig);
    return { projectId: 'audit-project', hasRunningTasks: false, preferenceRevision: 1, configRevision: 'config:1',
        themePreference: 'dark', fontPreference: { family: 'system', size: 14 }, appearancePreference: structuredClone(DEFAULT_APPEARANCE),
        activity: { ...c.activity, outputDirectory: '/tmp/inert-theme-audit' }, identity: c.context.identity, memory: c.context.memory,
        compaction: c.context.compaction, chatParams: c.chat, permission: c.permission, webSearch: c.web.search,
        models: { configured: [], connections: [], embeddingModels: [], defaultModel: 'default', thinking: 'off', modelProfiles: {} },
        skills: { projectId: 'audit-project', projectKey: 'audit-project', globalDefaults: {}, projectOverrides: {}, activations: [] } };
}
async function harness(global = false, saveGlobal?: (value: AppearancePreference) => Promise<AppearancePreference>, initialAppearance = DEFAULT_APPEARANCE) {
    const imports = registerHooks({ load(url, context, next) {
            const name = observedNames.find(name => url.endsWith(`/settings/${name}.tsx`));
            if (name)
                return { format: 'module', shortCircuit: true, source: `
      import { ${name} as Original } from ${JSON.stringify(url + '?theme-save-observer')};
      export function ${name}(props) {
        const tree = Original(props);
        window.__themeSaveObserver(${JSON.stringify(name)}, props, tree);
        return tree;
      }` };
            if (/\.(svg|png)$/u.test(url))
                return { format: 'module', source: 'export default "asset";', shortCircuit: true };
            if (url.endsWith('.css'))
                return { format: 'module', source: 'export {};', shortCircuit: true };
            return next(url, context);
        } });
    const { JSDOM } = await import('jsdom');
    const React = await import('react');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://desktop.local', pretendToBeVisual: true });
    const observed: Partial<ObservedProps> = {};
    const trees = new Map<keyof ObservedProps, ReactNode>();
    Object.assign(dom.window, { __themeSaveObserver: <K extends keyof ObservedProps>(name: K, props: ObservedProps[K], tree: ReactNode): void => {
            observed[name] = props;
            trees.set(name, tree);
        } });
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
        HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
        Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator,
        getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), CSS: { escape: (s: string) => s },
        ResizeObserver: class {
            observe() { }
            unobserve() { }
            disconnect() { }
        }, IS_REACT_ACT_ENVIRONMENT: true })) {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    dom.window.HTMLElement.prototype.scrollTo = () => { };
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    dom.window.scrollTo = () => { };
    dom.window.matchMedia = query => ({ matches: true, media: query, onchange: null,
        addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { }, dispatchEvent: () => true });
    const initial = snapshot();
    initial.appearancePreference = structuredClone(initialAppearance);
    let persisted = structuredClone(initial);
    let appearance = initial.appearancePreference!;
    const requests: Array<{
        input: DesktopSettingsSaveInput;
        result: ReturnType<typeof deferred<DesktopSettingsSaveResult>>;
    }> = [];
    const globalRequests: Array<{
        input: AppearancePreference;
        result: ReturnType<typeof deferred<AppearancePreference>>;
    }> = [];
    const projections: unknown[] = [];
    const notifications: string[] = [];
    const confirmations: string[] = [];
    let confirmAnswer = false;
    let closed = 0;
    dom.window.confirm = message => { confirmations.push(message ?? ''); return confirmAnswer; };
    Object.assign(dom.window, { biny: {
            settingsSnapshot: async () => structuredClone(persisted), activitySettings: async () => ({ activity: initial.activity, configRevision: 'config:1' }),
            updateSettingsDraftState: async (value: unknown) => { projections.push(value); }, releaseSettingsCredentials: async () => { }, previewAppearance: async () => { },
            quickChatSettings: async () => ({ autoHideOnBlur: true, injectScreenContext: false, clickThrough: false }),
            onActivityEvent: () => () => { }, activitySnapshot: async () => { throw new Error('unused'); }, activityPermissions: async () => { throw new Error('unused'); },
            saveSettings: (_id: string, input: DesktopSettingsSaveInput) => { const result = deferred<DesktopSettingsSaveResult>(); requests.push({ input: structuredClone(input), result }); return result.promise; },
            setAppearancePreference: (input: AppearancePreference) => {
                const result = deferred<AppearancePreference>();
                globalRequests.push({ input: structuredClone(input), result });
                if (saveGlobal)
                    void saveGlobal(input).then(result.resolve, result.reject);
                return result.promise;
            }
        } });
    const { createRoot } = await import('react-dom/client');
    const { SettingsOverlay } = await import('../src/desktop/renderer/src/components/settings/SettingsOverlay.js');
    const root = createRoot(document.getElementById('root')!);
    let rerenderAppearance: (p: AppearancePreference) => void = () => { };
    const preview = (p: AppearancePreference) => { appearance = structuredClone(p); rerenderAppearance(p); };
    const noop = (): void => { };
    const unused = (): never => { throw new Error('Unexpected unrelated settings callback'); };
    const workspace: DesktopWorkspaceSnapshot = {
        project: { id: 'audit-project', name: 'Audit', path: '/tmp/inert-theme-audit', dirty: false, missing: false,
            pinned: false, addedAt: '2026-10-07T00:00:00.000Z', lastOpenedAt: '2026-10-07T00:00:00.000Z' },
        sessions: [], models: [], pickerModels: [], connections: [], permissionMode: defaultConfig.permission.mode,
        capabilityDefaults: { tools: 'none', skills: 'none' }, requiresModelConfiguration: false
    };
    function Host() {
        const [current, setCurrent] = React.useState(appearance);
        const [open, setOpen] = React.useState(true);
        rerenderAppearance = setCurrent;
        const props: ComponentProps<typeof SettingsOverlay> = { open, version: 'test', targetTab: '配色', modelSetupRequired: false,
            workspace: global ? undefined : workspace,
            themePreference: 'dark', fontPreference: initial.fontPreference, appearancePreference: current, sessionRunning: false,
            onNotify: (m: string) => notifications.push(m), onThemePreference: noop, onFontPreference: noop, onAppearancePreference: preview,
            onSettingsCommitted: noop, onClose: () => { closed++; setOpen(false); },
            onResolveCloseRequest: unused, onTestModelConfiguration: unused, onFetchModelCatalog: unused,
            onReadModelApiKey: unused, onLoadMemoryStats: unused, onLoadMemoryEntries: unused, onSearchMemory: unused,
            onAddMemoryEntry: unused, onUpdateMemoryEntry: unused, onDeleteMemoryEntry: unused, onArchiveMemoryEntry: unused,
            onLoadArchivedMemory: unused, onRunMemorySleep: unused, onSleepStatus: unused, onSleepRuns: unused,
            onPreviewMemorySleep: unused, onCancelMemorySleep: unused, onClearMemory: unused, onOpenChatDraft: unused,
            onLoadMemoryEmbeddingStatus: unused, onDownloadMemoryEmbeddingModel: unused, onCancelMemoryEmbeddingDownload: unused,
            onDeleteMemoryEmbeddingModel: unused, onRebuildMemoryEmbeddingIndex: unused, onCancelMemoryEmbeddingRebuild: unused,
            onOpenExternal: unused, onLoadCookieJarStatus: unused, onOpenBrowser: unused, onExportCookies: unused,
            onImportCookies: unused, onClearCookies: unused, onStartModelLogin: unused, onCancelModelLogin: unused
        };
        return React.createElement(SettingsOverlay, props);
    }
    await React.act(async () => root.render(React.createElement(Host)));
    const component = <K extends keyof ObservedProps>(name: K): ObservedProps[K] => {
        const props = observed[name];
        assert.ok(props, name);
        return props;
    };
    const host = (type: string, select: (props: ElementProps) => boolean): ElementProps => {
        const found: ElementProps[] = [];
        function walk(node: ReactNode): void {
            React.Children.forEach(node, child => {
                if (!React.isValidElement<ElementProps>(child))
                    return;
                const name = typeof child.type === 'function' ? child.type.name : child.type;
                if (name === type && select(child.props))
                    found.push(child.props);
                walk(child.props.children);
            });
        }
        for (const tree of trees.values())
            walk(tree);
        const props = found.at(-1);
        assert.ok(props, type);
        return props;
    };
    const call = (type: string, select: (props: ElementProps) => boolean, callback: string, ...args: unknown[]): unknown => {
        const handler = host(type, select)[callback];
        assert.ok(typeof handler === 'function', `${type}.${callback}`);
        return Reflect.apply(handler, undefined, args);
    };
    const invoke = async (fn: () => unknown) => { await React.act(async () => { fn(); }); };
    const createTheme = async (name: string) => {
        assert.equal(component('SettingsThemes').disabled, false);
        await invoke(() => call('button', p => p.children === '创建主题', 'onClick'));
        assert.ok(document.querySelector('.theme-editor'));
        await invoke(() => call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: name } }));
        await invoke(() => call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        assert.equal(document.querySelector('.theme-editor'), null);
    };
    return { React, dom, component, host, call, invoke, createTheme, requests, globalRequests, projections, notifications, confirmations,
        preview: () => appearance, closed: () => closed, answer: (value: boolean) => { confirmAnswer = value; },
        async commit(index = 0) {
            const r = requests[index]!;
            persisted = { ...persisted, appearancePreference: r.input.appearancePreference ?? persisted.appearancePreference, preferenceRevision: persisted.preferenceRevision + 1 };
            await invoke(() => r.result.resolve({ status: 'committed', journalId: 'audit', appliedFields: ['appearancePreference'], snapshot: structuredClone(persisted) }));
        },
        initial,
        async close() {
            await React.act(() => root.unmount());
            dom.window.close();
            imports.deregister();
            for (const [k, d] of saved) {
                if (d)
                    Object.defineProperty(globalThis, k, d);
                else
                    Reflect.deleteProperty(globalThis, k);
            }
        }
    };
}
test('global theme save failure retains the edited name and colors for an explicit retry', async () => {
    const h = await harness(true);
    try {
        await h.invoke(() => h.call('button', p => p.children === '创建主题', 'onClick'));
        await h.invoke(() => h.call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: 'Keep my theme' } }));
        await h.invoke(() => h.call('ColorField', p => p.name === '背景颜色', 'onChange', '#123456'));
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        assert.equal(h.globalRequests.length, 1);
        await h.invoke(() => h.globalRequests[0]!.result.reject(new Error('Synthetic global save failure')));
        assert.ok(document.querySelector('.theme-editor'), 'failed save must retain a recoverable editor');
        assert.equal(document.querySelector<HTMLInputElement>('.theme-name-field input')?.value, 'Keep my theme');
        assert.equal(document.querySelector<HTMLInputElement>('[aria-label="背景颜色 色板"]')?.value, '#123456');
        assert.match(document.querySelector('.theme-editor [role="alert"]')?.textContent ?? '', /保存失败/u);
        assert.equal(h.globalRequests.length, 1, 'failed save does not retry automatically');
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        assert.equal(h.globalRequests.length, 2);
        assert.equal(h.globalRequests[1]!.input.customThemes[0]?.displayName, 'Keep my theme');
        assert.equal(h.globalRequests[1]!.input.customThemes[0]?.base_30.black, '#123456');
        assert.equal(h.globalRequests[1]!.input.customThemes[0]?.name, h.globalRequests[0]!.input.customThemes[0]?.name, 'an explicit retry retains the same logical theme identity');
        await h.invoke(() => h.globalRequests[1]!.result.resolve(h.globalRequests[1]!.input));
        assert.equal(document.querySelector('.theme-editor'), null);
        assert.equal(h.preview().customThemes[0]?.displayName, 'Keep my theme');
    }
    finally {
        await h.close();
    }
});
test('an unconfirmed global theme save keeps the editor open and gates edits, repeat submission, and dismissal', async () => {
    const h = await harness(true);
    try {
        await h.invoke(() => h.call('button', p => p.children === '创建主题', 'onClick'));
        await h.invoke(() => h.call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: 'Pending theme' } }));
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        assert.equal(h.globalRequests.length, 1);
        assert.ok(document.querySelector('.theme-editor'));
        for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.theme-editor input, .theme-editor button')) {
            if (control.closest('.theme-preview'))
                continue;
            assert.equal(control.disabled, true, control.getAttribute('aria-label') ?? control.textContent ?? 'editor control');
        }
        let prevented = false;
        await h.invoke(() => h.call('dialog', p => p.className === 'theme-editor', 'onCancel', { preventDefault() { prevented = true; } }));
        assert.equal(prevented, true);
        assert.ok(document.querySelector('.theme-editor'));
        const target = {};
        await h.invoke(() => h.call('dialog', p => p.className === 'theme-editor', 'onClick', { target, currentTarget: target }));
        assert.ok(document.querySelector('.theme-editor'));
        assert.equal(h.globalRequests.length, 1);
        await h.invoke(() => h.globalRequests[0]!.result.reject(new Error('Confirmed rejection')));
        assert.equal(document.querySelector<HTMLInputElement>('.theme-name-field input')?.disabled, false);
        await h.invoke(() => h.call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: 'Revised theme' } }));
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        assert.equal(h.globalRequests[1]?.input.customThemes[0]?.displayName, 'Revised theme');
        await h.invoke(() => h.globalRequests[1]!.result.resolve(h.globalRequests[1]!.input));
        assert.equal(document.querySelector('.theme-editor'), null);
        assert.equal(h.preview().customThemes[0]?.displayName, 'Revised theme');
    }
    finally {
        await h.close();
    }
});
test('project-mode theme save still stages locally before the outer settings transaction', async () => {
    const h = await harness();
    try {
        await h.createTheme('Project draft');
        assert.equal(h.globalRequests.length, 0);
        assert.equal(h.requests.length, 0);
        assert.equal(h.component('SettingsPageFooter').dirtyCount, 1);
        const draft = structuredClone(h.component('SettingsThemes').preference);
        assert.equal(draft.customThemes[0]?.displayName, 'Project draft');
        await h.invoke(() => h.component('SettingsPageFooter').onSave());
        assert.equal(h.requests.length, 1);
        assert.deepEqual(h.requests[0]?.input.appearancePreference, draft);
        await h.commit();
        assert.equal(h.component('SettingsPageFooter').dirtyCount, 0);
        assert.deepEqual(h.preview(), draft);
    }
    finally {
        await h.close();
    }
});
test('a real global state-file write failure preserves the editor until an explicit successful retry persists its theme', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'biny-theme-save-'));
    const filePath = path.join(folder, 'desktop-state.json');
    const state = new DesktopStateStore(filePath);
    await state.load();
    const original = state.settingsPreferences();
    await mkdir(filePath + '.tmp');
    const h = await harness(true, async (value) => { await state.setAppearancePreference(value); return state.appearancePreference(); });
    try {
        await h.invoke(() => h.call('button', p => p.children === '创建主题', 'onClick'));
        await h.invoke(() => h.call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: 'Persisted theme' } }));
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        await h.React.act(async () => { await assert.rejects(h.globalRequests[0]!.result.promise, /EISDIR/u); });
        assert.deepEqual(state.settingsPreferences(), original);
        assert.ok(document.querySelector('.theme-editor'), 'the actual write rejection must retain the editor');
        assert.equal(document.querySelector<HTMLInputElement>('.theme-name-field input')?.value, 'Persisted theme');
        await rm(filePath + '.tmp', { recursive: true });
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        await h.React.act(async () => { await h.globalRequests[1]!.result.promise; });
        assert.equal(document.querySelector('.theme-editor'), null);
        const onDisk: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        assert.ok(onDisk && typeof onDisk === 'object' && 'appearancePreference' in onDisk);
        const storedAppearance = appearancePreferenceSchema.parse(onDisk.appearancePreference);
        assert.equal(storedAppearance.customThemes[0]?.displayName, 'Persisted theme');
        assert.equal(storedAppearance.darkTheme, 'custom:' + storedAppearance.customThemes[0]?.name);
        const restored = new DesktopStateStore(filePath);
        await restored.load();
        assert.deepEqual(restored.appearancePreference(), h.preview());
    }
    finally {
        await h.close();
        await rm(folder, { recursive: true, force: true });
    }
});
test('explicit cancel after a failed global theme edit preserves the original file, selection, and preview without retrying', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'biny-theme-cancel-'));
    const filePath = path.join(folder, 'desktop-state.json');
    const state = new DesktopStateStore(filePath);
    await state.load();
    const originalTheme = cloneAppearanceTheme(BUILTIN_PALETTES.tokyonight!, 'existing', 'Original theme');
    const original = { ...structuredClone(DEFAULT_APPEARANCE), darkTheme: 'custom:existing', customThemes: [originalTheme] };
    await state.setAppearancePreference(original);
    const before = await readFile(filePath, 'utf8');
    await mkdir(filePath + '.tmp');
    const h = await harness(true, async (value) => { await state.setAppearancePreference(value); return state.appearancePreference(); }, original);
    try {
        await h.invoke(() => h.call('button', p => p['aria-label'] === '编辑 Original theme', 'onClick'));
        await h.invoke(() => h.call('input', p => p.required === true && p.maxLength === 80, 'onChange', { target: { value: 'Unconfirmed edit' } }));
        await h.invoke(() => h.call('ColorField', p => p.name === 'black', 'onChange', '#123456'));
        await h.invoke(() => h.call('form', p => typeof p.onSubmit === 'function', 'onSubmit', { preventDefault() { } }));
        await h.React.act(async () => { await assert.rejects(h.globalRequests[0]!.result.promise, /EISDIR/u); });
        assert.equal(document.querySelector<HTMLInputElement>('.theme-name-field input')?.value, 'Unconfirmed edit');
        assert.equal(h.globalRequests[0]?.input.customThemes[0]?.name, originalTheme.name);
        assert.equal(h.host('button', p => p.children === '取消').disabled, false);
        await h.invoke(() => h.call('button', p => p.children === '取消', 'onClick'));
        assert.equal(document.querySelector('.theme-editor'), null);
        assert.equal(h.globalRequests.length, 1);
        assert.deepEqual(h.preview(), original);
        assert.deepEqual(h.component('SettingsThemes').preference, original);
        assert.deepEqual(state.appearancePreference(), original);
        assert.equal(await readFile(filePath, 'utf8'), before);
    }
    finally {
        await h.close();
        await rm(folder, { recursive: true, force: true });
    }
});
