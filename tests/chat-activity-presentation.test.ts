/** 活动详情的换行与密度契约；不替代真实界面验收。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const css = ["desktop-v2", "biny", "chat", "inspector", "providers", "thread-brief"].map(name =>
  readFileSync(new URL(`../src/desktop/renderer/src/styles/${name}.css`, import.meta.url), "utf8")
).join("\n");

function checkStyles(check: (get: (selector: string) => CSSStyleDeclaration) => void): void {
  const dom = new JSDOM(`<style>${css}</style><div class="biny-chat-scroll">
    <div class="chat-activity-rail"><div class="chat-activity-thinking"><div class="markdown-body is-thinking" style="font-size: 16px">
      <p>第一段</p>\n<p>很长的思考段落</p><pre class="markdown-code-pre"><code>const value = 1;</code></pre>
    </div></div><div class="tool-details"><section class="tool-section">
      <div class="chat-command"><div class="chat-command-input"><pre>cd /tmp && python3 - &lt;&lt;'EOF'</pre></div><div class="chat-command-result"><pre>long output</pre></div><div class="chat-command-status">已完成</div></div>
    </section></div></div></div>`);
  try { check(selector => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!)); }
  finally { dom.window.close(); }
}

test("思考正文自然换行，不保留 Markdown 节点间的空白行", () => {
  checkStyles(get => {
    assert.equal(get(".chat-activity-thinking").whiteSpace, "normal");
    assert.equal(get(".is-thinking").overflowWrap, "anywhere");
    assert.equal(get(".is-thinking").maxWidth, "100%");
    assert.ok(parseFloat(get(".is-thinking p").marginBottom) < 16, "段距小于测试设定的一行字号");
  });
});

test("长命令框与输出区一样限定高度并内部滚动，不把整条命令撑满活动段", () => {
  // 长命令（如多行 Python 脚本）若不限高，会把执行卡片撑到几屏高，遮住后续工具与回复。
  checkStyles(get => {
    assert.equal(get(".chat-command-input pre").maxHeight, get(".chat-command-result pre").maxHeight);
    assert.equal(get(".chat-command-input pre").maxHeight, "288px");
    assert.equal(get(".chat-command-input pre").overflow, "auto");
  });
});

test("命令日志自然折行且内部滚动，状态使用弱化文字色", () => {
  checkStyles(get => {
    assert.equal(get(".chat-command-result pre").whiteSpace, "pre-wrap");
    assert.equal(get(".chat-command-result pre").overflowWrap, "anywhere");
    assert.equal(get(".chat-command-status").color, "var(--biny-text-tertiary)");
  });
});
