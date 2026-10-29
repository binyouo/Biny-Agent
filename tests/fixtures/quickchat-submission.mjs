import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<div id="root"></div>', { url: 'https://inert.invalid' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent'])
    Object.defineProperty(global, key, { configurable: true, value: dom.window[key] });
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const jsx = await import('react/jsx-runtime');
const { window } = dom;
const { document, HTMLTextAreaElement, Event, KeyboardEvent } = window;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; }
const switches = [], sends = [], cancels = [];
let listener;
const boot = { activeProjectId: 'project', projects: [{ id: 'project' }], workspace: { runtime: { info: { modelAlias: 'old', thinking: 'off' } }, pickerModels: [{ alias: 'old', displayName: 'Old', efforts: [], defaultThinking: 'off' }, { alias: 'new', displayName: 'New', efforts: [], defaultThinking: 'off' }] } };
window.biny = new Proxy({ quickChatSettings: async () => ({ injectScreenContext: false }), bootstrap: async () => boot, quickChatScreenContext: async () => ({}), getQuickChatClickThrough: async () => false, onQuickChatContext: () => () => { }, onQuickChatFocusInput: () => () => { }, onQuickChatClickThroughChanged: () => () => { }, onAgentEvent: f => { listener = f; return () => listener = undefined; }, switchModel: async (...args) => { const gate = deferred(); switches.push({ args, gate }); return gate.promise; }, sendPrompt: async (...args) => { const gate = deferred(); sends.push({ args, gate }); return gate.promise; }, cancelRun: async (...args) => cancels.push(args), closeQuickChat: async () => { } }, { get: (target, key) => { if (!(key in target))
        throw Error('Unexpected IPC ' + String(key)); return target[key]; } });
const noop = () => null, bootstrapAppearance = () => { };
// Run the production event classifier too; no Runtime/Host or storage is initialized.
const agentEvents = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/runtime/agentEvents.ts', 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
}).outputText, {exports: agentEvents});
const deps = { 'react': React, 'react/jsx-runtime': jsx, '../../../../runtime/agentEvents.js': agentEvents, '../../../../llm/modelThinking.js': { modelThinkingSelections: () => [] }, '../AppearanceProvider.js': { AppearanceProvider: ({ children }) => children }, '../useDesktopAppearance.js': { useDesktopAppearance: () => ({ snapshot: {}, bootstrap: bootstrapAppearance }) }, '../components/WindowChrome.js': { WindowChrome: noop }, '../components/Icon.js': { Icon: noop }, '../components/MarkdownContent.js': { MarkdownContent: ({ content }) => React.createElement('div', null, content) }, '../components/composer/ModelPickerMenu.js': { ModelPickerMenu: ({ open, onSelectModel }) => open ? React.createElement('button', { id: 'choose-new', onClick: () => onSelectModel('new') }, 'choose new') : null }, '../components/chat/UserInputCard.js': { UserInputCard: noop }, './quickchat.css': {} };
const source = fs.readFileSync('src/desktop/renderer/src/quickchat/QuickChatApp.tsx', 'utf8'), exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: exportsObject, require: n => { if (!(n in deps))
        throw Error('Unexpected import ' + n); return deps[n]; }, window, document, crypto: webcrypto, console });
const root = createRoot(document.getElementById('root'));
const input = () => document.querySelector('textarea');
const fill = async (text) => React.act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input(), text); input().dispatchEvent(new Event('input', { bubbles: true })); });
const click = async (selector) => React.act(async () => document.querySelector(selector).click());
const enter = async () => React.act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
const event = (type, runId, messageId, sessionId = 'own') => listener({ projectId: 'project', event: { type, runId, messageId, sessionId, input: '继续', timestamp: 'synthetic', model: {}, skills: [], content: 'answer', error: 'synthetic failure' } });
let unmounted = false;
(async () => {
    try {
        await React.act(async () => root.render(React.createElement(exportsObject.QuickChatApp)));
        const mode = process.argv[2];
        if (mode === 'unknown') {
            await fill('mine');
            await enter();
            const key = sends[0].args[6];
            await fill('draft');
            await React.act(async () => sends[0].gate.reject(new Error('transport unknown')));
            assert.equal(input().value, 'draft');
            await enter();
            assert.equal(sends.length, 1);
            await React.act(async () => event('run.started', 'foreign', 'other'));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await React.act(async () => event('run.started', 'mine', key));
            await click('[aria-label="停止生成"]');
            assert.equal(cancels[0][1], 'mine');
            await React.act(async () => event('run.completed', 'mine', key));
            await enter();
            assert.equal(sends.length, 2);
            assert.equal(sends[1].args[1], 'own');
        }
        else if (mode === 'known') {
            await fill('mine');
            await enter();
            const key = sends[0].args[6];
            await React.act(async () => event('run.started', 'mine', key));
            await React.act(async () => sends[0].gate.reject(new Error('late failure')));
            await fill('draft');
            await enter();
            assert.equal(sends.length, 1);
            await click('[aria-label="停止生成"]');
            assert.equal(cancels[0][1], 'mine');
            await React.act(async () => event('run.completed', 'mine', key));
            assert.equal(input().value, 'draft');
            await enter();
            assert.equal(sends.length, 2);
            await React.act(async () => event('run.started', 'foreign', 'other'));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
        }
        else if (mode === 'preparefail') {
            await fill('mine');
            await click('.quickchat-model-button');
            await click('#choose-new');
            await enter();
            await fill('draft');
            await React.act(async () => switches[0].gate.reject(new Error('not sent')));
            assert.equal(sends.length, 0);
            assert.equal(input().value, 'draft');
            assert.ok(document.body.textContent.includes('mine'));
            await enter();
            assert.equal(switches.length, 2);
        }
        else if (mode === 'unmount') {
            await fill('mine');
            await click('.quickchat-model-button');
            await click('#choose-new');
            await enter();
            await React.act(async () => root.unmount());
            unmounted = true;
            await React.act(async () => switches[0].gate.resolve({ modelAlias: 'new', thinking: 'off' }));
            assert.equal(sends.length, 0);
            assert.equal(listener, undefined);
        }
        else if (mode === 'queue' || mode === 'legacy') {
            await fill('queued');
            await enter();
            const key = sends[0].args[6];
            await React.act(async () => sends[0].gate.resolve({ sessionId: 'own', runId: 'foreign', messageId: key, ...(mode === 'queue' ? { queued: true } : {}) }));
            assert.ok(document.body.textContent.includes('主窗口'));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await React.act(async () => event('run.started', 'foreign', 'foreign-message'));
            await React.act(async () => event('assistant.delta', 'foreign', 'foreign-message'));
            assert.ok(!document.body.textContent.includes('answer'));
            await React.act(async () => event('run.started', 'queued-actual', key));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await fill('new draft');
            await enter();
            assert.equal(sends.length, 1);
            await click('[aria-label="新建快速对话"]');
            assert.equal(input().value, 'new draft');
            await enter();
            assert.equal(sends.length, 2);
            assert.equal(sends[1].args[1], undefined);
            assert.equal(cancels.length, 0);
        }
        else if (mode === 'early-failure' || mode === 'receipt-failure') {
            await fill('mine'); await enter(); const key = sends[0].args[6];
            await React.act(async () => event('run.failed', 'foreign', 'other'));
            await React.act(async () => event('run.failed', 'mine', key, 'foreign-session'));
            if (mode === 'early-failure') await React.act(async () => event('run.failed', 'mine', key));
            await React.act(async () => sends[0].gate.resolve({sessionId:'own',runId:'mine',messageId:key,queued:false}));
            if (mode === 'receipt-failure') await React.act(async () => event('run.failed', 'mine', key));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            assert.equal(document.querySelector('[aria-label="等待消息运行"]'), null);
            assert.ok(document.body.textContent.includes('synthetic failure'));
            await fill('next'); await enter(); assert.equal(sends.length, 2);
        }
        else if (mode === 'direct') {
            await fill('mine');
            await enter();
            const key = sends[0].args[6];
            await React.act(async () => sends[0].gate.resolve({ sessionId: 'own', runId: 'mine', messageId: key, queued: false }));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await React.act(async () => event('run.started', 'foreign', 'foreign-message'));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await React.act(async () => event('run.started', 'mine', key));
            await click('[aria-label="停止生成"]');
            assert.equal(cancels[0][1], 'mine');
            await React.act(async () => event('run.completed', 'mine', key));
        }
        else if (mode === 'receipt') {
            await fill('继续');
            await click('.quickchat-model-button');
            await click('#choose-new');
            await enter();
            await fill('new draft');
            await React.act(async () => event('run.started', 'foreign', 'foreign-message', 'foreign-session'));
            assert.equal(document.querySelector('[aria-label="停止生成"]'), null);
            await React.act(async () => switches[0].gate.resolve({ modelAlias: 'new', thinking: 'off' }));
            assert.equal(sends[0].args[1], undefined);
            assert.equal(input().value, 'new draft');
            const key = sends[0].args[6];
            await React.act(async () => event('run.started', 'mine', key));
            await React.act(async () => event('run.completed', 'mine', key));
            assert.equal(document.querySelector('[aria-label="等待发送确认"]').disabled, true);
            await enter();
            await click('[aria-label="新建快速对话"]');
            assert.equal(sends.length, 1);
            await React.act(async () => sends[0].gate.resolve({ sessionId: 'own', runId: 'mine', messageId: key, queued: false }));
            await enter();
            assert.equal(sends.length, 2);
            assert.equal(sends[1].args[1], 'own');
            const second = sends[1].args[6];
            await React.act(async () => event('run.started', 'second', second));
            await React.act(async () => event('run.started', 'mine', key));
            await click('[aria-label="停止生成"]');
            assert.equal(cancels[0][1], 'second');
        }
        else
            throw Error(mode);
        console.log('PASS actual React business case: ' + mode);
    }
    finally {
        if (!unmounted)
            await React.act(async () => root.unmount());
        dom.window.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
