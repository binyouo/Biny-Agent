import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";

// Count the real Shiki engine, keeping its parsing, escaping and themes unchanged.
const coreUrl = pathToFileURL(createRequire(import.meta.url).resolve("shiki/core")).href;
const probe = { calls: 0, fail: false };
Object.assign(globalThis, { syntaxHighlightCacheProbe: probe });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "shiki/core" && context.parentURL?.endsWith("/syntaxHighlight.ts")
      ? { url: "test:counted-shiki", shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === "test:counted-shiki" ? { format: "module", shortCircuit: true, source: `
      import { createHighlighterCore as create } from ${JSON.stringify(coreUrl)};
      export async function createHighlighterCore(options) {
        const highlighter = await create(options);
        const original = highlighter.codeToHtml.bind(highlighter);
        highlighter.codeToHtml = (...args) => {
          const probe = globalThis.syntaxHighlightCacheProbe; probe.calls++;
          if (probe.fail) { probe.fail = false; throw new Error('temporary tokenizer failure'); }
          return original(...args);
        };
        return highlighter;
      }` } : next(url, context);
  }
});
const { highlightFencedCode, highlightWorkspaceFile } = await import("../src/desktop/renderer/src/syntaxHighlight.js");

test("reopening exact code reuses real highlighted output across normalized file/fence inputs", async () => {
  {
    const source = 'const value = "<unsafe &>";';
    const first = await highlightFencedCode(source, "ts");
    const before = probe.calls;
    const second = await highlightWorkspaceFile("example.ts", source);
    assert.deepEqual(second, first);
    assert.equal(probe.calls, before);
    second.html = "consumer mutation";
    assert.deepEqual(await highlightFencedCode(source, "typescript"), first, "callers cannot corrupt cached output");
    const javascript = await highlightFencedCode(source, "js");
    assert.equal(javascript.language, "javascript");
    assert.equal(probe.calls, before + 1, "language is part of cache ownership");
    const changed = await highlightFencedCode(source + "\n// changed", "ts");
    assert.notDeepEqual(changed, first);
    assert.equal(probe.calls, before + 2);
  }
});

test("result cache evicts old entries and keeps recently reused code", async () => {
  const texts = Array.from({ length: 33 }, (_, i) => `const cacheEntry${i} = ${i};`);
  for (const text of texts.slice(0, 32)) await highlightFencedCode(text, "ts");
  await highlightFencedCode(texts[0]!, "ts");
  await highlightFencedCode(texts[32]!, "ts");
  const before = probe.calls;
  await highlightFencedCode(texts[0]!, "ts");
  assert.equal(probe.calls, before, "recently used entry survives eviction");
  await highlightFencedCode(texts[1]!, "ts");
  assert.equal(probe.calls, before + 1, "least recently used entry is recomputed");
});

test("temporary failures retry and fallback text stays escaped", async () => {
  const source = 'const failure = "<script>";';
  probe.fail = true;
  const failed = await highlightFencedCode(source, "ts");
  assert.equal(failed.html, 'const failure = &quot;&lt;script&gt;&quot;;');
  const before = probe.calls;
  const retried = await highlightFencedCode(source, "ts");
  assert.equal(probe.calls, before + 1);
  assert.match(retried.html, /--shiki-light/);
  assert.equal((await highlightFencedCode('<unsafe>', "unknown-language")).html, '&lt;unsafe&gt;');
  const oversized = '<'.repeat(40_001);
  assert.equal((await highlightFencedCode(oversized, "ts")).html, '&lt;'.repeat(40_001));
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, "syntaxHighlightCacheProbe"); });

test("retained source and markup budget evicts entries before the entry-count limit", async () => {
  const sources = Array.from({ length: 13 }, (_, index) => Array.from({ length: 200 }, (_, line) => `const value${index}_${line} = {value: ${line}, label: "<unsafe &>"};`).join("\n"));
  let retained = 0;
  for (const source of sources) {
    const result = await highlightFencedCode(source, "ts");
    retained += source.length + result.html.length;
  }
  assert.ok(retained > 2_000_000, "fixture crosses the character budget with fewer than 32 entries");
  const before = probe.calls;
  await highlightFencedCode(sources.at(-1)!, "ts");
  assert.equal(probe.calls, before);
  await highlightFencedCode(sources[0]!, "ts");
  assert.equal(probe.calls, before + 1, "old markup does not outlive the bounded cache budget");
});

test("actual MarkdownCodeBlock remount reuses output while changed streaming text remains current", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document,
    navigator: { userAgent: "test" }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { MarkdownCodeBlock } = await import("../src/desktop/renderer/src/components/MarkdownCodeBlock.js");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const source = 'const remount = "<original>";';
  const render = (code: string, isStreaming = false) => React.act(async () => {
    root.render(React.createElement(MarkdownCodeBlock, { code, language: "ts", isStreaming }));
  });
  try {
    await render(source);
    const original = document.querySelector("pre")!.innerHTML;
    assert.match(original, /--shiki-dark/);
    const before = probe.calls;
    await React.act(async () => root.render(null));
    assert.equal(document.querySelector("pre"), null, "previous production component was unmounted");
    document.documentElement.dataset.theme = "dark";
    await render(source);
    assert.equal(document.querySelector("pre")!.innerHTML, original);
    assert.equal(probe.calls, before, "reopening the real code component does not retokenize");
    await render(source + "\nconst growing = <", true);
    assert.equal(document.querySelector("pre")!.textContent, source + "\nconst growing = <");
    await render('const replacement = "<new>";');
    assert.equal(document.querySelector("pre")!.textContent, 'const replacement = "<new>";');
    assert.equal(probe.calls, before + 1, "changed final code is highlighted independently");
    await render(source);
    assert.equal(document.querySelector("pre")!.innerHTML, original);
    assert.equal(probe.calls, before + 1, "A → B → A restores prior exact source without retokenizing");
  } finally {
    await React.act(() => root.unmount()); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("concurrent first requests account for one retained result rather than each completion", async () => {
  for (let i = 0; i < 32; i++) await highlightFencedCode(`const small${i} = true;`, "ts");
  const sentinel = 'const retainedSentinel = "keep";';
  await highlightFencedCode(sentinel, "ts");
  const source = Array.from({ length: 200 }, (_, i) => `const concurrent${i} = {value: ${i}, label: "<value>"};`).join("\n");
  const results = await Promise.all(Array.from({ length: 16 }, () => highlightFencedCode(source, "ts")));
  for (const result of results) assert.deepEqual(result, results[0]);
  const before = probe.calls;
  await highlightFencedCode(sentinel, "ts");
  await highlightFencedCode(source, "ts");
  assert.equal(probe.calls, before, "duplicate completions do not inflate the budget and evict unrelated recent code");
});

test("a single oversized highlighted result is returned but not retained", async () => {
  const sentinel = 'const oversizedSentinel = "keep";';
  await highlightFencedCode(sentinel, "ts");
  const source = "1+\n".repeat(13_000);
  const first = await highlightFencedCode(source, "js");
  assert.ok(first.html.length > 2_000_000, "generated markup alone exceeds the payload bound");
  const before = probe.calls;
  assert.deepEqual(await highlightFencedCode(source, "js"), first);
  assert.equal(probe.calls, before + 1, "oversized results are recomputed rather than retained");
  await highlightFencedCode(sentinel, "ts");
  assert.equal(probe.calls, before + 1, "an uncacheable result does not evict other useful entries");
});
