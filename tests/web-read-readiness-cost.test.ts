/** Run only the exact web_read page script against inert objects; never import Electron or the service. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

type Engine = "google" | "xiaohongshu" | undefined;
const googleSelector = 'a h3, #captcha-form, form[action*="consent"]';
const xiaohongshuSelector = "section.note-item, .login-container, .login-modal";
const removedSelector = "script, style, noscript, template, svg, img, link, meta";

function pageScript(engine: Engine, maxBytes: number): string {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 524_288);
  const source = ts.createSourceFile("DesktopBrowserService.ts", readFileSync(
    new URL("../src/desktop/electron/main/DesktopBrowserService.ts", import.meta.url), "utf8"
  ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = source.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === "DesktopBrowserService");
  assert.equal(classes.length, 1);
  const methods = classes[0]!.members.filter(ts.isMethodDeclaration)
    .filter(node => ts.isIdentifier(node.name) && node.name.text === "readWebPage");
  assert.equal(methods.length, 1);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "page"
      && node.expression.name.text === "executeJavaScript") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(methods[0]!);
  assert.equal(calls.length, 1, "audit the extraction if the page script changes shape");
  assert.equal(calls[0]!.arguments.length, 1);
  const template = calls[0]!.arguments[0]!;
  assert.ok(ts.isTemplateExpression(template));
  assert.deepEqual(template.templateSpans.map(span => span.expression.getText(source)), [
    "JSON.stringify(args.engine ?? null)", "maxBytes", "maxBytes", "maxBytes"
  ], "only these four known interpolations may be substituted, never evaluated");
  const literals = [JSON.stringify(engine ?? null), String(maxBytes), String(maxBytes), String(maxBytes)];
  return template.head.text + template.templateSpans.map((span, index) => literals[index]! + span.literal.text).join("");
}

interface Snapshot {
  ready: boolean;
  html?: string;
  body?: string;
  finalUrl?: string;
  title?: string;
  contentType?: string;
  truncatedAtByteLimit?: boolean;
}

interface FixtureOptions {
  engine?: Engine;
  maxBytes?: number;
  html?: string;
  text?: string;
  contentType?: string;
  selectors?: string[];
  poisonExtraction?: boolean;
  bodyPresent?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const html = options.html ?? "<main>网页 😀</main>";
  const text = options.text ?? "网页 😀";
  const maxBytes = options.maxBytes ?? 524_288;
  const contentType = options.contentType ?? "text/html";
  const selectors = new Set(options.selectors ?? []);
  const counts = { clone: 0, outerHtml: 0, encode: 0, encodedCharacters: 0, encoder: 0, decoder: 0, removed: 0, innerText: 0, queries: 0 };
  const extraction = (): void => {
    assert.equal(options.poisonExtraction, undefined, "unready snapshots must not touch extraction");
  };
  class CountingEncoder {
    constructor() { extraction(); counts.encoder++; }
    encode(value: string): Uint8Array {
      extraction(); counts.encode++; counts.encodedCharacters += value.length;
      return new TextEncoder().encode(value);
    }
  }
  class CountingDecoder {
    constructor() { extraction(); counts.decoder++; }
    decode(value: Uint8Array): string { return new TextDecoder().decode(value); }
  }
  const document = {
    body: options.bodyPresent === false ? null : { get innerText() { counts.innerText++; return text; } },
    title: "Fixed fixture title",
    contentType,
    querySelector(selector: string) {
      counts.queries++;
      assert.ok(selector === googleSelector || selector === xiaohongshuSelector);
      return selector.split(", ").some(item => selectors.has(item)) ? {} : null;
    },
    documentElement: {
      cloneNode(deep: boolean) {
        extraction(); assert.equal(deep, true); counts.clone++;
        return {
          querySelectorAll(selector: string) {
            assert.equal(selector, removedSelector);
            return [{ remove() { counts.removed++; } }, { remove() { counts.removed++; } }];
          },
          get outerHTML() { extraction(); counts.outerHtml++; return html; }
        };
      }
    }
  };
  const location = { href: "https://example.test/fixed-page" };
  const script = new Script(pageScript(options.engine, maxBytes), { filename: "web_read-page-script.js" });
  const run = (): Snapshot => {
    // The script is reviewed source, not arbitrary input. VM is not a security boundary.
    const result: unknown = script.runInNewContext({ document, location, TextEncoder: CountingEncoder, TextDecoder: CountingDecoder }, {
      timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
    });
    return JSON.parse(JSON.stringify(result)) as Snapshot;
  };
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  const expected = (): Snapshot => ({
    html: new TextDecoder().decode(encode(html).subarray(0, maxBytes)),
    body: new TextDecoder().decode(encode(options.bodyPresent === false ? "" : text).subarray(0, maxBytes)),
    finalUrl: location.href,
    title: document.title,
    contentType,
    ready: true,
    truncatedAtByteLimit: encode(contentType === "text/html" ? html : options.bodyPresent === false ? "" : text).length > maxBytes
  });
  return { run, counts, selectors, expected, html, text };
}

for (const engine of ["google", "xiaohongshu"] as const) {
  test(`${engine}: four unready snapshots do no whole-page extraction before one ready snapshot`, () => {
    const page = fixture({ engine, html: "中😀".repeat(4096), text: "loading", maxBytes: 32 });
    const snapshots = Array.from({ length: 4 }, () => page.run());
    assert.ok(snapshots.every(snapshot => snapshot.ready === false));
    const waiting = { ...page.counts };
    page.selectors.add(engine === "google" ? "a h3" : "section.note-item");
    assert.deepEqual(page.run(), page.expected());
    assert.deepEqual({ clone: waiting.clone, outerHtml: waiting.outerHtml, encode: waiting.encode, encodedCharacters: waiting.encodedCharacters }, {
      clone: 0, outerHtml: 0, encode: 0, encodedCharacters: 0
    });
    assert.deepEqual(snapshots, Array.from({ length: 4 }, () => ({ ready: false })));
    assert.equal(page.counts.clone, 1);
    assert.equal(page.counts.outerHtml, 1);
    assert.equal(page.counts.encode, 2);
    assert.equal(page.counts.encodedCharacters, page.html.length + page.text.length);
    assert.equal(page.counts.encoder, 1);
    assert.equal(page.counts.decoder, 1);
    assert.equal(page.counts.innerText, 6, "readiness still reads innerText once per poll, plus final extraction");
  });

  test(`${engine}: unready snapshots never invoke poisoned extraction capabilities`, () => {
    const page = fixture({ engine, poisonExtraction: true });
    assert.deepEqual(page.run(), { ready: false });
    assert.equal(page.counts.clone + page.counts.outerHtml + page.counts.encode + page.counts.encoder + page.counts.decoder, 0);
  });
}

for (const [engine, selectors] of [
  ["google", ["a h3", "#captcha-form", 'form[action*="consent"]']],
  ["xiaohongshu", ["section.note-item", ".login-container", ".login-modal"]]
] as const) {
  for (const selector of selectors) {
    test(`${engine}: ${selector} preserves a complete ready snapshot`, () => {
      const page = fixture({ engine, selectors: [selector] });
      assert.deepEqual(page.run(), page.expected());
      assert.equal(page.counts.clone, 1);
      assert.equal(page.counts.outerHtml, 1);
      assert.equal(page.counts.encode, 2);
      assert.equal(page.counts.removed, 2);
    });
  }
  for (const text of ["没有找到", "暂无搜索结果", "did not match any documents", "unusual traffic", "登录后查看"]) {
    test(`${engine}: ${text} still short-circuits readiness and returns content`, () => {
      const page = fixture({ engine, text });
      assert.deepEqual(page.run(), page.expected());
      assert.equal(page.counts.queries, 0);
      assert.equal(page.counts.clone, 1);
      assert.equal(page.counts.encode, 2);
    });
  }
}

test("WebFetch without a search engine extracts immediately, including an absent body", () => {
  for (const bodyPresent of [true, false]) {
    const page = fixture({ bodyPresent });
    assert.deepEqual(page.run(), page.expected());
    assert.equal(page.counts.queries, 0);
    assert.equal(page.counts.clone, 1);
    assert.equal(page.counts.encode, 2);
  }
});

test("ready snapshots retain all fields and the existing UTF-8 truncation behavior", () => {
  for (const contentType of ["text/html", "text/plain", "application/xhtml+xml"]) {
    for (const maxBytes of [1, 2, 3, 4, 5, 6, 7, 8, 9, 32]) {
      const page = fixture({ html: "A你😀Z", text: "B文🚀ZZ", contentType, maxBytes });
      assert.deepEqual(page.run(), page.expected(), `${contentType} at ${maxBytes} bytes`);
      assert.equal(page.counts.clone, 1);
      assert.equal(page.counts.encode, 2);
    }
  }
});
