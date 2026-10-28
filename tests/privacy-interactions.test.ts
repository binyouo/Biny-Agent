import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { DesktopMaskRecord, DesktopMaskRecordSummary } from "../src/desktop/protocol.js";
import { SettingsDraftContext, type SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";
import { privacyView, privacyDay } from "../src/desktop/renderer/src/components/settings/privacyViewData.js";
import { privacyExcerpt } from "../src/desktop/renderer/src/components/settings/privacyExcerpt.js";

// 服务商品牌图标按需引用静态 SVG 资源；测试环境没有打包器，用加载钩子把资源换成占位模块。
registerHooks({ load(url, context, next) {
  if (/.(svg|png)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return url.endsWith(".css") ? { format: "module", source: "export {}", shortCircuit: true } : next(url, context);
} });

const now = new Date(2026, 9, 28, 12);
const day = (offset: number): string => { const date = new Date(now); date.setDate(date.getDate() - offset); date.setMinutes(0, 0, 0); return date.toISOString(); };

// 直接构造脱敏摘要，不依赖任何内置示例数据。
function summary(id: string, overrides: Partial<DesktopMaskRecordSummary> = {}): DesktopMaskRecordSummary {
  return { id, time: day(0), provider: "OpenAI", model: "gpt-4.1", sessionId: "session-alpha", operation: "agent", count: 1, uniqueValues: 1, kinds: { API_KEY: 1 }, ...overrides };
}

test("date filters use local calendar days and combine with provider, session and kind", () => {
  const records: DesktopMaskRecordSummary[] = [
    summary("today-a"),
    summary("today-b", { provider: "Anthropic", sessionId: "session-beta", kinds: { EMAIL: 2 } }),
    summary("yesterday", { time: day(1) }),
    summary("old", { time: day(10), provider: "DeepSeek" }),
    summary("unmasked", { count: 0, uniqueValues: 0, kinds: {} })
  ];
  const filter = { days: 7, day: "", provider: "", session: "", kind: "" };
  const week = privacyView(records, filter, now);
  assert.equal(week.records.length, 4);
  assert.equal(week.days.length, 7);
  assert.equal(privacyDay(week.days.at(-1)!.day), privacyDay(now));
  assert.equal(privacyView(records, { ...filter, days: 30 }, now).records.length, 5);
  assert.equal(privacyView(records, { ...filter, day: privacyDay(now) }, now).records.length, 3);
  assert.equal(privacyView(records, { ...filter, provider: "OpenAI", session: "session-beta" }, now).records.length, 0);
  const emails = privacyView(records, { ...filter, kind: "EMAIL" }, now);
  assert.deepEqual(emails.records.map(record => record.id), ["today-b"]);
  assert.equal(week.total, 3);
});

test("long-field excerpts reveal a late match with aligned offsets in both columns", () => {
  const prefix = "Earlier unchanged line.\n".repeat(200), suffix = "\nLater unchanged line.".repeat(200);
  const secret = "fixture-secret", tag = "{{SECRET_abcdefgh}}";
  const excerpt = privacyExcerpt({ path: "messages[1].content", original: prefix + secret + suffix, masked: prefix + tag + suffix,
    segments: [{ original: secret, masked: tag, start: prefix.length, end: prefix.length + secret.length, kind: "SECRET" }] });
  assert.ok(excerpt.original.startsWith("…\n"));
  assert.ok(excerpt.original.endsWith("\n…"));
  assert.ok(excerpt.original.length < 1000);
  assert.ok(excerpt.masked.includes(tag));
  assert.equal(excerpt.original.slice(excerpt.segments[0]!.start, excerpt.segments[0]!.end), secret);
  assert.equal(excerpt.masked.replace(tag, secret), excerpt.original);
});

test("records list filters, pages, inspects a request and returns without mutating settings", async t => {
  const { SettingsPrivacy } = await import("../src/desktop/renderer/src/components/settings/SettingsPrivacy.js");
  t.mock.timers.enable({ apis: ["Date"], now });
  const dom = new JSDOM("<dialog open><section class='settings-modal'><div id='root'></div></section></dialog>", { url: "http://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  class Observer { observe() {} disconnect() {} }
  for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // 25 条同一天记录，全部可被命中；覆盖分页、筛选和详情。
  const records: DesktopMaskRecordSummary[] = Array.from({ length: 25 }, (_, index) => summary(`record-${index}`, {
    provider: index % 2 ? "Anthropic" : "OpenAI",
    sessionId: index % 3 === 0 ? "session-alpha" : "session-beta",
    kinds: index % 5 === 0 ? { EMAIL: index + 1 } : { API_KEY: index + 1 },
    count: index + 1, uniqueValues: 1,
    model: index === 0 ? "claude-sonnet-4" : "gpt-4.1"
  }));
  const detail: DesktopMaskRecord = {
    id: "record-0", time: records[0]!.time, provider: "OpenAI", model: "claude-sonnet-4", sessionId: "session-alpha",
    operation: "agent", count: 1, uniqueValues: 1, kinds: { EMAIL: 1 }, requestBytes: 2048, truncated: false,
    preview: [
      { path: "messages[0].role", role: "system", original: "system", masked: "system", segments: [] },
      { path: "messages[1].content", role: "user", original: "联系 fixture@example.invalid", masked: "联系 {{EMAIL_abcde234}}",
        segments: [{ original: "fixture@example.invalid", masked: "{{EMAIL_abcde234}}", start: 3, end: 24, kind: "EMAIL" }] }
    ]
  };
  let reads = 0, details = 0, clears = 0;
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    biny: {
      maskingOverview: async () => { reads++; return { records, summary: { total: records.reduce((sum, r) => sum + r.count, 0), requests: records.length, byKind: {}, byProvider: {} } }; },
      maskingDetail: async (_projectId: string, id: string) => { details++; return id === "record-0" ? detail : undefined; },
      maskingClear: async () => { clears++; }, onAgentEvent: () => () => {}
    }
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close(); t.mock.timers.reset();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const context = { snapshot: { projectId: "test", redaction: { enabled: false } }, draft: { redaction: { enabled: false } }, setRedaction() { throw new Error("must not change settings"); } } as unknown as SettingsDraftContextValue;
  await act(async () => root.render(React.createElement(SettingsDraftContext.Provider, { value: context }, React.createElement(SettingsPrivacy))));
  const document = dom.window.document;
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll("button")].find(node => node.textContent === label && !node.closest("[hidden]"));
    assert.ok(found, `button ${label} must exist`); return found;
  };
  const click = async (node: HTMLElement) => { await act(async () => node.click()); };
  assert.equal(document.querySelectorAll(".privacy-record-list li").length, 20);
  assert.match(document.querySelector(".privacy-pagination")!.textContent!, /1–20 \/ 25/u);
  await click(button("下一页"));
  assert.match(document.querySelector(".privacy-pagination")!.textContent!, /21–25 \/ 25/u);
  await click(button("上一页"));
  await click(button("邮箱"));
  assert.equal(document.querySelectorAll(".privacy-record-list li").length, 5);
  await click(button("全部"));
  await click(document.querySelector<HTMLButtonElement>(".privacy-record-list li button")!);
  assert.match(document.querySelector(".privacy-request-detail")!.textContent!, /厂商看到的样子/u);
  assert.match(document.querySelector(".privacy-request-summary")!.textContent!, /发送模型claude-sonnet-4OpenAI/u);
  assert.match(document.querySelector(".privacy-request-summary")!.textContent!, /发现 1 个值/u);
  assert.ok(document.querySelector(".privacy-comparison.is-compare"));
  const unchanged = document.querySelector<HTMLDetailsElement>(".privacy-unchanged")!;
  assert.equal(unchanged.open, false);
  await click(unchanged.querySelector("summary")!);
  assert.equal(unchanged.open, true);
  assert.match(unchanged.textContent!, /messages\[0\]\.role/u);
  assert.match(unchanged.textContent!, /system/u);
  await click(button("厂商看到的样子"));
  assert.equal(document.querySelector(".privacy-comparison.is-compare"), null);
  await act(async () => document.querySelector<HTMLButtonElement>(".privacy-hit button")!.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
  assert.match(document.querySelector('[role="tooltip"]')!.textContent!, /fixture@example\.invalid/u);
  assert.equal(document.querySelector('[role="tooltip"]')!.closest("dialog"), document.querySelector("dialog"), "tooltip must remain inside the modal top layer");
  await click(button("对照"));
  await click(button("下一条"));
  assert.match(document.querySelector(".privacy-request-detail .privacy-actions")!.textContent!, /2 \/ 25/u);
  await click(button("‹ 返回列表"));
  assert.equal(document.querySelectorAll(".privacy-record-list li").length, 20);
  assert.equal(reads, 1);
  assert.ok(details >= 1);
  assert.equal(clears, 0);
});
