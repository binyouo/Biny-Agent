import assert from "node:assert/strict";
import { test } from "node:test";
import { browserPageFixture } from "./helpers/browserPageFixture.js";

test("browser socket executes the real readiness script without extracting pending pages", { timeout: 15_000 }, async context => {
  const page = await browserPageFixture(context);
  for (const engine of ["google", "xiaohongshu"] as const) {
    await context.test(`${engine}: bounded real polling only extracts after result DOM appears`, async () => {
      page.document.body.innerHTML = "<p>loading</p>";
      const before = { ...page.counts };
      page.setBeforeRead(() => {
        assert.equal(page.counts.clones, before.clones);
        assert.equal(page.counts.encodes, before.encodes);
        if (page.counts.polls - before.polls === 3) {
          page.document.body.innerHTML = engine === "google"
            ? '<a href="https://example.org"><h3>Result</h3></a><script>secret</script>'
            : '<section class="note-item">Result</section><script>secret</script>';
        }
      });
      const result = await page.read(engine).finally(() => page.setBeforeRead());
      assert.equal(page.counts.polls - before.polls, 3);
      assert.equal(page.counts.clones - before.clones, 1);
      assert.equal(page.counts.encodes - before.encodes, 2);
      assert.equal(page.counts.closed - before.closed, 1);
      assert.equal(result.ready, true);
      assert.match(result.html, /Result/);
      assert.doesNotMatch(result.html, /<script>/);
      assert.equal(result.googleChallenge, engine === "google" ? false : undefined);
    });
  }
  await context.test("actual CAPTCHA and consent DOM stay ready and carry challenge evidence even when HTML is clipped", async () => {
    for (const form of ['<form id="captcha-form"></form>', '<form action="https://consent.google.com"></form>']) {
      page.document.body.innerHTML = `<p>${"padding ".repeat(20)}</p>${form}`;
      const result = await page.read("google", 32);
      assert.equal(result.ready, true);
      assert.equal(result.googleChallenge, true);
      assert.equal(result.truncatedAtByteLimit, true);
      assert.doesNotMatch(result.html, /<form/);
    }
  });
  await context.test("text readiness and other-engine DOM do not fabricate a Google challenge", async () => {
    for (const text of ["没有找到", "暂无搜索结果", "did not match any documents", "unusual traffic", "登录后查看"]) {
      page.document.body.textContent = text;
      assert.equal((await page.read("google")).googleChallenge, false);
      assert.equal((await page.read("xiaohongshu")).googleChallenge, undefined);
    }
    for (const html of ['<div class="login-container">login</div>', '<div class="login-modal">login</div>']) {
      page.document.body.innerHTML = html;
      assert.equal((await page.read("xiaohongshu")).ready, true);
    }
  });
  await context.test("WebFetch extracts immediately and preserves bounded UTF-8 output", async () => {
    page.document.body.textContent = "A你😀Z";
    Object.defineProperty(page.document, "contentType", { value: "text/plain", configurable: true });
    const result = await page.read(undefined, 5);
    assert.equal(result.ready, true);
    assert.equal(result.body, "A你�");
    assert.equal(result.html, "<html");
    assert.equal(result.truncatedAtByteLimit, true);
    assert.equal(result.googleChallenge, undefined);
    Object.defineProperty(page.document, "contentType", { value: "text/html", configurable: true });
  });
  await context.test("an unready page times out without extraction and releases its hidden window", async () => {
    page.document.body.textContent = "loading";
    const before = { ...page.counts };
    await assert.rejects(page.read("google"), /超时/);
    assert.equal(page.counts.clones, before.clones);
    assert.equal(page.counts.encodes, before.encodes);
    assert.equal(page.counts.closed - before.closed, 1);
  });
});
