import assert from "node:assert/strict";
import { test } from "node:test";
import { parseXiaohongshuResults } from "../src/tools/web/search.js";
import { browserPageFixture } from "./helpers/browserPageFixture.js";

test("WebSearch carries real DOM challenge evidence through the browser socket", { timeout: 15_000 }, async context => {
  const page = await browserPageFixture(context);
  const resultHtml = '<a href="https://example.org/doc"><h3>Document</h3></a><p>Summary</p>';
  await context.test("query and result text are not challenge evidence, including ordinary empty results", async () => {
    for (const word of ["captcha-form", "consent.google.com", "/sorry/", "unusual traffic from your computer"]) {
      page.document.body.innerHTML = `<input value="${word}"><a href="https://example.org/doc"><h3>${word}</h3></a><p>${word}</p>`;
      const result = await page.search({ query: word });
      assert.equal(result.query, word);
      assert.deepEqual(result.results, [{ title: word, url: "https://example.org/doc", snippet: word }]);
      assert.equal(Number.isFinite(Date.parse(result.fetchedAt)), true);
      page.document.body.innerHTML = `<input value="${word}"><p>${word} did not match any documents</p>`;
      assert.deepEqual((await page.search({ query: word })).results, []);
    }
  });
  await context.test("challenge forms override results, including body-text readiness short circuits", async () => {
    for (const form of ['<form id="captcha-form"></form>', '<form action="https://consent.google.com"></form>']) {
      for (const prefix of [resultHtml, "<p>unusual traffic</p>"]) {
        page.document.body.innerHTML = prefix + form;
        await assert.rejects(page.search({ query: "ordinary" }), /Google 需要验证/);
      }
    }
  });
  await context.test("challenge URL detection uses Google hosts and path boundaries rather than query text", async () => {
    page.document.body.innerHTML = resultHtml;
    for (const url of ["https://consent.google.com/", "https://www.google.com/sorry", "https://google.co.uk/sorry/index", "https://google.de/SORRY"]) {
      page.setFinalUrl(url);
      await assert.rejects(page.search({ query: "ordinary" }), /Google 需要验证/);
    }
    for (const url of ["https://www.google.com/search?q=captcha-form#consent.google.com/sorry/", "https://www.google.com/sorry-news", "https://www.google.com/article/sorry/", "https://google.com.evil.test/sorry/", "https://notgoogle.com/sorry/", "https://consent.google.com.evil.test/"]) {
      page.setFinalUrl(url);
      assert.equal((await page.search({ query: "ordinary" })).results[0]?.title, "Document");
    }
    page.setFinalUrl();
  });
  await context.test("Xiaohongshu keeps its independent login detection and result links", async () => {
    page.document.body.innerHTML = '<section class="note-item"><a href="/search_result/abc123?xsec_token=test&amp;xsec_source=pc_search"></a><a class="title">旅行笔记</a></section><p>captcha-form consent.google.com /sorry/</p>';
    const parsed = parseXiaohongshuResults(page.document.body.innerHTML, 5);
    assert.equal(new URL(parsed[0]!.url).searchParams.get("xsec_token"), "test");
    const result = await page.search({ query: "captcha-form" }, "xiaohongshu");
    assert.equal(result.provider, "xiaohongshu");
    assert.equal(result.results[0]?.title, "旅行笔记");
    assert.equal(new URL(result.results[0]!.url).pathname, "/search_result/abc123");
    assert.doesNotMatch(result.results[0]!.url, /xsec_token=test/);
    page.document.body.innerHTML = '<div class="login-container">登录 login captcha</div>';
    await assert.rejects(page.search({ query: "ordinary" }, "xiaohongshu"), /小红书需要登录或验证/);
  });
  await context.test("search preserves request filters, result order, redirects, deduplication and limits", async () => {
    page.document.body.innerHTML = '<a href="/url?q=https%3A%2F%2Fexample.com%2Fguide&amp;sa=U"><h3>Example &amp; guide</h3></a><p>One</p>'
      + '<a href="https://example.com/guide"><h3>Duplicate</h3></a><p>Duplicate text</p>'
      + '<a href="https://example.org/second"><h3>Second</h3></a><p>Two</p>'
      + '<a href="https://example.net/third"><h3>Third</h3></a><p>Three</p>';
    const result = await page.search({ query: " topic ", maxResults: 2, domains: ["https://example.com/path"], recency: "week" });
    const url = new URL(page.document.URL);
    assert.equal(url.searchParams.get("q"), "topic site:example.com");
    assert.equal(url.searchParams.get("num"), "4");
    assert.equal(url.searchParams.get("tbs"), "qdr:w");
    assert.equal(result.query, "topic");
    assert.deepEqual(result.results, [
      { title: "Example & guide", url: "https://example.com/guide", snippet: "One" },
      { title: "Second", url: "https://example.org/second", snippet: "Two" }
    ]);
  });
});
