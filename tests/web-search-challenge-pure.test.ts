/** Actual search functions and page script against inert data only; no product imports or real DOM. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_SEARCH_CHALLENGE_SOURCE_ROOT ?? process.cwd();
const searchSource = readFileSync(path.join(root, "src/tools/web/search.ts"), "utf8");
const htmlSource = readFileSync(path.join(root, "src/tools/web/html.ts"), "utf8");
const desktopSource = readFileSync(path.join(root, "src/desktop/electron/main/DesktopBrowserService.ts"), "utf8");
const googleSelector = 'a h3, #captcha-form, form[action*="consent"]';
const challengeSelector = '#captcha-form, form[action*="consent"]';
const xiaohongshuSelector = "section.note-item, .login-container, .login-modal";
const removedSelector = "script, style, noscript, template, svg, img, link, meta";
const normalGoogle = '<a href="https://example.org/doc"><h3>Document</h3></a><p>Summary</p>';
const normalNote = '<section class="note-item"><a href="/search_result/abc123?xsec_token=test&amp;xsec_source=pc_search"></a><a class="title"><span>旅行笔记</span></a></section>';
const challengeError = /Google 需要验证/;

type Engine = "google" | "xiaohongshu";
interface SearchArgs { query: string; maxResults?: number; domains?: string[]; recency?: "day" | "week" | "month" | "year" }
interface SearchConfig { provider: Engine; maxResults: number; timeoutMs: number; visibleBrowsing: boolean }
interface SearchResult { title: string; url: string; snippet?: string }
interface SearchResponse { query: string; provider: Engine; results: SearchResult[]; fetchedAt: string }
interface Endpoint { endpoint: string; token: string; projectId?: string }
interface Page { html: string; finalUrl: string; googleChallenge?: unknown }
interface Snapshot extends Page { body: string; title: string; contentType: string; ready: boolean; truncatedAtByteLimit: boolean }
type Search = (config: SearchConfig, args: SearchArgs, endpoint: Endpoint | undefined, signal?: AbortSignal) => Promise<SearchResponse>;
type Request = (endpoint: Endpoint, method: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

function declarations(source: string, names: readonly string[], filename: string): string {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const matches = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    assert.equal(matches.length, 1, `one actual function ${name}`);
    return matches[0]!.getText(file).replace(/^export\s+/u, "");
  }).join("\n");
}

const extracted = declarations(searchSource, ["searchWeb", "parseGoogleResults", "parseXiaohongshuResults", "resolveGoogleUrl", "cleanHtmlText"], "search.ts")
  + "\n" + declarations(htmlSource, ["decodeHtmlEntities"], "html.ts");
const compiled = ts.transpileModule(extracted, {
  fileName: "actual-search.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

function searchWith(requestBrowser: Request): Search {
  class FixedDate extends Date { constructor() { super("2026-10-13T00:00:00.000Z"); } }
  const context = createContext({ requestBrowser, URL, Date: FixedDate }, { codeGeneration: { strings: false, wasm: false } });
  return new Script(compiled.outputText + "\nsearchWeb;", { filename: "actual-search.js" }).runInContext(context, { timeout: 1_000 }) as Search;
}

function pageScript(engine: Engine | undefined, maxBytes: number): string {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 524_288);
  const source = ts.createSourceFile("DesktopBrowserService.ts", desktopSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.arguments.length, 1);
  const template = calls[0]!.arguments[0]!;
  assert.ok(ts.isTemplateExpression(template));
  assert.deepEqual(Array.from(template.templateSpans, span => span.expression.getText(source)), [
    "JSON.stringify(args.engine ?? null)", "maxBytes", "maxBytes", "maxBytes"
  ], "substitute only four reviewed literal interpolations, never evaluate them");
  const values = [JSON.stringify(engine ?? null), String(maxBytes), String(maxBytes), String(maxBytes)];
  return template.head.text + template.templateSpans.map((span, index) => values[index]! + span.literal.text).join("");
}

interface PageOptions { engine?: Engine; html?: string; text?: string; selectors?: string[]; finalUrl?: string; maxBytes?: number }
function renderPage(options: PageOptions = {}): { page: Snapshot; counts: { readiness: number; challenge: number; clones: number; encodes: number } } {
  const selectors = new Set(options.selectors ?? ["a h3"]);
  const html = options.html ?? normalGoogle;
  const text = options.text ?? "Document Summary";
  const finalUrl = options.finalUrl ?? "https://www.google.com/search?q=ordinary";
  const counts = { readiness: 0, challenge: 0, clones: 0, encodes: 0 };
  const document = {
    body: { innerText: text }, title: "Search", contentType: "text/html",
    querySelector(selector: string): object | null {
      if (selector === challengeSelector) counts.challenge++;
      else { assert.ok(selector === googleSelector || selector === xiaohongshuSelector); counts.readiness++; }
      return selector.split(", ").some(part => selectors.has(part)) ? {} : null;
    },
    documentElement: {
      cloneNode(deep: boolean) {
        assert.equal(deep, true); counts.clones++;
        return { outerHTML: html, querySelectorAll(selector: string) { assert.equal(selector, removedSelector); return []; } };
      }
    }
  };
  class CountingEncoder { encode(value: string): Uint8Array { counts.encodes++; return new TextEncoder().encode(value); } }
  const context = createContext({ document, location: { href: finalUrl }, TextEncoder: CountingEncoder, TextDecoder }, { codeGeneration: { strings: false, wasm: false } });
  const value: unknown = new Script(pageScript(options.engine, options.maxBytes ?? 524_288)).runInContext(context, { timeout: 1_000 });
  return { page: JSON.parse(JSON.stringify(value)) as Snapshot, counts };
}

const endpoint: Endpoint = Object.freeze({ endpoint: "inert-browser", token: "fixture-only", projectId: "project" });
const config: SearchConfig = { provider: "google", maxResults: 5, timeoutMs: 10_000, visibleBrowsing: false };
async function run(page: Page | ((args: Record<string, unknown>) => Page), args: SearchArgs = { query: "ordinary" }, provider: Engine = "google"): Promise<SearchResponse> {
  let calls = 0;
  const search = searchWith(async (actualEndpoint, method, requestArgs, signal) => {
    calls++;
    assert.equal(actualEndpoint, endpoint);
    assert.equal(method, "web_read");
    assert.equal(requestArgs.engine, provider);
    assert.equal(requestArgs.projectId, "project");
    assert.equal(requestArgs.timeoutMs, 10_000);
    assert.equal(requestArgs.visible, false);
    assert.equal(requestArgs.maxBytes, 2 * 1024 * 1024);
    assert.equal(signal, undefined);
    assert.equal(typeof requestArgs.url, "string");
    return typeof page === "function" ? page(requestArgs) : page;
  });
  try { return JSON.parse(JSON.stringify(await search({ ...config, provider }, args, endpoint))) as SearchResponse; }
  finally { assert.equal(calls, 1, "exactly one inert browser request"); }
}

test("actual ready Google page script reports explicit false and search ignores normal query/HTML words", async () => {
  for (const word of ["captcha-form", "consent.google.com", "/sorry/", "unusual traffic from your computer"]) {
    const html = `<input value="${word}"><a href="https://example.org/${encodeURIComponent(word)}"><h3>${word}</h3></a><p>${word}</p>`;
    const captured: Array<ReturnType<typeof renderPage>> = [];
    const result = await run(request => {
      const rendered = renderPage({ engine: "google", html, text: word, finalUrl: String(request.url) });
      captured.push(rendered);
      return rendered.page;
    }, { query: word });
    const rendered = captured[0];
    assert.ok(rendered);
    assert.equal(rendered.page.googleChallenge, false);
    assert.equal(rendered.counts.challenge, 1);
    assert.equal(result.results[0]?.title, word);
    assert.equal(result.results[0]?.snippet, word);
    assert.equal(result.query, word);
    assert.equal(result.provider, "google");
    assert.equal(result.fetchedAt, "2026-10-13T00:00:00.000Z");
  }
});

for (const selector of ["#captcha-form", 'form[action*="consent"]']) {
  test(`actual ${selector} challenge is rejected even alongside valid results`, async () => {
    const rendered = renderPage({ engine: "google", selectors: ["a h3", selector], html: normalGoogle });
    assert.equal(rendered.page.googleChallenge, true);
    assert.equal(rendered.counts.challenge, 1);
    assert.equal(rendered.counts.clones, 1);
    assert.equal(rendered.counts.encodes, 2);
    await assert.rejects(run(rendered.page), challengeError);
  });
}

test("challenge boolean remains effective when bounded HTML omits challenge structure", async () => {
  const rendered = renderPage({ engine: "google", selectors: ["a h3", "#captcha-form"], html: normalGoogle, maxBytes: 8 });
  assert.equal(rendered.page.googleChallenge, true);
  assert.equal(rendered.page.truncatedAtByteLimit, true);
  await assert.rejects(run(rendered.page), challengeError);
});

test("unready Google and other engines never run the Google challenge query", () => {
  for (const engine of ["google", "xiaohongshu", undefined] as const) {
    const { page, counts } = renderPage({ engine, selectors: [], text: "loading" });
    assert.equal(counts.challenge, 0);
    assert.equal(Object.hasOwn(page, "googleChallenge"), false);
    assert.equal(page.ready, engine === undefined);
  }
  const notes = renderPage({ engine: "xiaohongshu", selectors: ["section.note-item"], html: normalNote });
  assert.equal(notes.page.ready, true);
  assert.equal(notes.counts.challenge, 0);
  assert.equal(Object.hasOwn(notes.page, "googleChallenge"), false);
});

test("Google text readiness short-circuit still obtains structured challenge evidence", () => {
  for (const selector of [undefined, "#captcha-form"]) {
    const rendered = renderPage({ engine: "google", text: "unusual traffic", selectors: selector ? [selector] : [] });
    assert.equal(rendered.counts.readiness, 0);
    assert.equal(rendered.counts.challenge, 1);
    assert.equal(rendered.page.googleChallenge, selector !== undefined);
    assert.equal(rendered.page.ready, true);
  }
});

test("explicit boolean true is not negated by results or ordinary final URL", async () => {
  await assert.rejects(run({ html: normalGoogle, finalUrl: "https://www.google.com/search?q=ordinary", googleChallenge: true }), challengeError);
  await assert.rejects(run({ html: "<p>No results</p>", finalUrl: "https://www.google.com/search?q=ordinary", googleChallenge: true }), challengeError);
});

test("structured final URL detection retains known Google host heuristic and path boundaries", async () => {
  for (const finalUrl of [
    "https://consent.google.com/", "https://www.google.com/sorry", "https://google.com/sorry/", "https://www.google.co.uk/sorry/index",
    "https://google.de/SORRY", "https://sub.google.co.uk/sorry/"
  ]) await assert.rejects(run({ html: normalGoogle, finalUrl, googleChallenge: false }), challengeError, finalUrl);
  for (const finalUrl of [
    "https://www.google.com/search?q=captcha-form#consent.google.com/sorry/", "https://www.google.com/sorry-news",
    "https://www.google.com/article/sorry/", "https://google.com.evil.test/sorry/", "https://notgoogle.com/sorry/",
    "https://consent.google.com.evil.test/", "https://example.org/sorry/", "https://www.google.com/search?q=https%3A%2F%2Fconsent.google.com%2F"
  ]) assert.equal((await run({ html: normalGoogle, finalUrl, googleChallenge: false })).results[0]?.title, "Document", finalUrl);
});

test("missing or nonboolean markers retain conservative legacy Google rejection", async () => {
  for (const marker of [undefined, null, 0, 1, "false", "true", {}, []]) {
    const page: Page = { html: normalGoogle, finalUrl: "https://www.google.com/search?q=captcha-form" };
    if (marker !== undefined) page.googleChallenge = marker;
    await assert.rejects(run(page), challengeError);
    assert.equal((await run({ ...page, finalUrl: "https://www.google.com/search?q=ordinary" })).results[0]?.title, "Document");
    await assert.rejects(run({ ...page, finalUrl: "https://www.google.com/search", html: `${normalGoogle}<p>captcha-form</p>` }), challengeError);
  }
});

test("new false marker preserves no-results challenge text fallback and ordinary empty pages", async () => {
  for (const text of ["captcha-form", "consent.google.com", "/sorry/", "unusual traffic from your computer"]) {
    await assert.rejects(run({ html: `<p>${text}</p>`, finalUrl: "https://www.google.com/search", googleChallenge: false }), challengeError);
  }
  const empty = await run({ html: "<p>did not match any documents</p>", finalUrl: "https://www.google.com/search", googleChallenge: false });
  assert.deepEqual(empty.results, []);
  const queryOnly = await run({ html: "<p>did not match any documents</p>", finalUrl: "https://www.google.com/search?q=captcha-form", googleChallenge: false });
  assert.deepEqual(queryOnly.results, [], "no-results fallback must not scan the final URL query again");
});

test("normal Xiaohongshu results are isolated from Google query and HTML challenge vocabulary", async () => {
  const result = await run(request => renderPage({ engine: "xiaohongshu", selectors: ["section.note-item"], html: normalNote + "<p>captcha-form consent.google.com /sorry/</p>", finalUrl: String(request.url) }).page,
    { query: "captcha-form" }, "xiaohongshu");
  assert.equal(result.results[0]?.title, "旅行笔记");
  assert.equal(new URL(result.results[0]!.url).searchParams.get("xsec_token"), "test");
  assert.equal(result.provider, "xiaohongshu");
  assert.equal((await run({ html: normalNote, finalUrl: "https://www.xiaohongshu.com/search_result?keyword=ordinary", googleChallenge: true }, { query: "ordinary" }, "xiaohongshu")).results.length, 1);
  await assert.rejects(run({ html: "<div>登录 login captcha</div>", finalUrl: "https://www.xiaohongshu.com/search_result" }, { query: "ordinary" }, "xiaohongshu"), /小红书需要登录或验证/);
});

test("search output order, de-duplication, redirects, limits and request filters remain intact", async () => {
  const html = '<a href="/url?q=https%3A%2F%2Fexample.com%2Fguide&amp;sa=U"><h3>Example &amp; guide</h3></a><p>One</p>'
    + '<a href="https://example.com/guide"><h3>Duplicate</h3></a><p>Duplicate text</p>'
    + '<a href="https://example.org/second"><h3>Second</h3></a><p>Two</p>'
    + '<a href="https://example.net/third"><h3>Third</h3></a><p>Three</p>';
  const result = await run(request => {
    const url = new URL(String(request.url));
    assert.equal(url.searchParams.get("q"), "topic site:example.com");
    assert.equal(url.searchParams.get("num"), "4");
    assert.equal(url.searchParams.get("tbs"), "qdr:w");
    return { html, finalUrl: url.href, googleChallenge: false };
  }, { query: " topic ", maxResults: 2, domains: ["https://example.com/path"], recency: "week" });
  assert.deepEqual(result.results, [
    { title: "Example & guide", url: "https://example.com/guide", snippet: "One" },
    { title: "Second", url: "https://example.org/second", snippet: "Two" }
  ]);
  assert.equal(result.query, "topic");
});

test("browser failures and invalid HTML still reject without fabricating results", async () => {
  const expected = new Error("inert browser failure");
  await assert.rejects(searchWith(async () => { throw expected; })(config, { query: "topic" }, endpoint), error => error === expected);
  const search = searchWith(async () => ({ html: null, finalUrl: "https://www.google.com/search", googleChallenge: false }));
  await assert.rejects(search(config, { query: "topic" }, endpoint), /无效的搜索页面/);
});
