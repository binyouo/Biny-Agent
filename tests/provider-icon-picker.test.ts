/**
 * 服务商图标选择器：数据完整性 + 渲染器 + 选择器交互。
 *
 * 断言只依赖图标集自身与组件契约：期望值都从 PROVIDER_ICON_LIST 推导，
 * 不硬编码图标名，也不读用户机器上的任何状态。
 *
 * ⚠️ 导入顺序是硬要求：react-dom 必须在 jsdom 全局装好**之后**才被首次求值
 * （与 tests/desktop-ergonomics.test.ts 同一个做法）。否则 React 的 canUseDOM 恒为 false，
 * 会走 input 事件的 IE 兜底路径，onChange 永远不派发——测试会静默地测不到任何输入。
 * 所以组件一律走 loadComponents() 动态导入，不在文件顶部静态引入。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { PROVIDER_ICON_DATA, PROVIDER_ICON_LIST } from "../src/desktop/renderer/src/assets/provider-icon-data.js";
import { loadProviderIconData, resetProviderIconDataCache } from "../src/desktop/renderer/src/components/ProviderIconData.js";
import { PROVIDER_CATALOG_ICON_IDS, hasBuiltInProviderIcon, resolveProviderIconId } from "../src/desktop/renderer/src/providerIconIds.js";

type Components = {
  ProviderBrandIcon: typeof import("../src/desktop/renderer/src/components/ProviderBrandIcon.js").ProviderBrandIcon;
  ProviderIconPicker: typeof import("../src/desktop/renderer/src/components/settings/ProviderIconPicker.js").ProviderIconPicker;
};

let components: Components | undefined;

/** 只能在 setupDom() 之后调用——首次求值时机决定 React 走哪条事件路径。 */
async function loadComponents(): Promise<Components> {
  if (!components) {
    components = {
      ProviderBrandIcon: (await import("../src/desktop/renderer/src/components/ProviderBrandIcon.js")).ProviderBrandIcon,
      ProviderIconPicker: (await import("../src/desktop/renderer/src/components/settings/ProviderIconPicker.js")).ProviderIconPicker
    };
  }
  return components;
}

async function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  return {
    dom,
    root,
    render: async (node: React.ReactElement): Promise<void> => { await act(async () => { root.render(node); }); },
    restore: async (): Promise<void> => {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

type Harness = Awaited<ReturnType<typeof setupDom>>;

/** 与组件同构的过滤规则；用来独立算出"应该渲染哪些"，而不是抄一份硬编码名字。 */
function expectedTitles(query: string): string[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? PROVIDER_ICON_LIST.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle))
    : PROVIDER_ICON_LIST;
  return matched.map((entry) => entry.title).sort();
}

/** 打开选择器：同步 act，不 await 动态 import，这样加载态才可观测。 */
function openPicker(harness: Harness): HTMLButtonElement {
  const trigger = harness.dom.window.document.querySelector<HTMLButtonElement>(".provider-icon-trigger");
  assert.ok(trigger, "应当渲染出触发按钮");
  act(() => { trigger.click(); });
  return trigger;
}

/** 排除第一格「默认图标」：它不属于图标集，不该混进过滤结果里比较。 */
function renderedTitles(harness: Harness): string[] {
  return [...harness.dom.window.document.querySelectorAll<HTMLButtonElement>(".provider-icon-cell[title]:not(.is-default)")]
    .map((cell) => cell.title)
    .sort();
}

/** 与仓库里既有测试一致：原生 setter 赋值 + 异步 act，React 才会派发 onChange。 */
async function typeInto(dom: JSDOM, input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("图标数据与目录清单一一对应，且每条都能画出 svg", () => {
  const ids = Object.keys(PROVIDER_ICON_DATA).sort();
  const listed = PROVIDER_ICON_LIST.map((entry) => entry.id).sort();
  assert.equal(ids.length, 257, "图标数据条数");
  assert.equal(listed.length, 257, "目录清单条数");
  assert.deepEqual(ids, listed, "两边 id 集合必须完全一致");
  assert.equal(new Set(listed).size, listed.length, "目录清单不应有重复 id");
  for (const entry of PROVIDER_ICON_LIST) {
    assert.ok(entry.title.trim().length > 0, entry.id + " 必须有标题");
    assert.ok(["provider", "application", "model"].includes(entry.group), entry.id + " 的分组");
    const glyph = PROVIDER_ICON_DATA[entry.id]!;
    assert.match(glyph.vb, /^-?\d+(\.\d+)? -?\d+(\.\d+)? -?\d+(\.\d+)? -?\d+(\.\d+)?$/, entry.id + " 的 viewBox");
    assert.ok(glyph.body.includes("<"), entry.id + " 的 body 应当是 svg 片段");
  }
});

test("ProviderBrandIcon 命中数据时画品牌 svg，没有对应图标时退回 fallback", async () => {
  const harness = await setupDom();
  const { ProviderBrandIcon } = await loadComponents();
  try {
    await loadProviderIconData();
    await harness.render(React.createElement(ProviderBrandIcon, {
      className: "brand-logo",
      fallback: React.createElement("span", { "data-testid": "fallback" }, "兜底"),
      iconId: "OpenAI"
    }));
    const document = harness.dom.window.document;
    const svg = document.querySelector("svg.brand-logo");
    assert.ok(svg, "已加载数据时必须直接画出品牌 svg");
    assert.equal(svg!.getAttribute("viewBox"), PROVIDER_ICON_DATA.OpenAI!.vb);
    assert.equal(svg!.innerHTML, PROVIDER_ICON_DATA.OpenAI!.body);
    assert.equal(document.querySelector('[data-testid="fallback"]'), null, "命中图标时不该出现兜底");

    await harness.render(React.createElement(ProviderBrandIcon, {
      fallback: React.createElement("span", { "data-testid": "fallback" }, "兜底"),
      iconId: "这不是一个图标 id"
    }));
    assert.equal(document.querySelector("svg.brand-logo"), null);
    assert.ok(document.querySelector('[data-testid="fallback"]'), "查不到的 id 必须退回 fallback");
  } finally {
    await harness.restore();
  }
});

test("ProviderIconPicker 冷启动先给加载态，数据到位后铺满默认格与图标网格", async () => {
  resetProviderIconDataCache();
  const harness = await setupDom();
  const { ProviderIconPicker } = await loadComponents();
  try {
    await harness.render(React.createElement(ProviderIconPicker, { onChange: () => undefined, value: null }));
    const document = harness.dom.window.document;
    const trigger = openPicker(harness);
    assert.match(trigger.textContent ?? "", /默认图标/, "没有选择时标题是默认图标");
    assert.match(document.querySelector(".provider-icon-popover")?.textContent ?? "", /正在加载图标/);

    await act(async () => { await loadProviderIconData(); });
    assert.equal(renderedTitles(harness).length, PROVIDER_ICON_LIST.length, "网格里应当是全量图标");
    assert.equal(document.querySelectorAll(".provider-icon-cell").length, PROVIDER_ICON_LIST.length + 1, "再加上默认格");
    assert.equal(document.querySelectorAll(".provider-icon-cell.is-selected").length, 1, "默认格应当是选中态");
    assert.equal(document.querySelector(".provider-icon-empty"), null);
  } finally {
    await harness.restore();
  }
});

test("ProviderIconPicker 按标题和 id 过滤，没有命中时给出空结果提示", async () => {
  await loadProviderIconData();
  const harness = await setupDom();
  const { ProviderIconPicker } = await loadComponents();
  try {
    await harness.render(React.createElement(ProviderIconPicker, { onChange: () => undefined, value: null }));
    const document = harness.dom.window.document;
    openPicker(harness);
    const input = document.querySelector<HTMLInputElement>(".provider-icon-search input");
    assert.ok(input, "弹层里应当有搜索框");

    // 空查询等于整份清单。
    assert.deepEqual(renderedTitles(harness), expectedTitles(""));

    // 按 id 查，且大小写不敏感。
    const byId = expectedTitles("zhipu");
    assert.ok(byId.length > 0 && byId.length < PROVIDER_ICON_LIST.length, "zhipu 应当命中一部分而不是全部");
    await typeInto(harness.dom, input!, "zhipu");
    assert.deepEqual(renderedTitles(harness), byId);

    // 按标题查：拿一个真实标题当查询词。
    const sampleTitle = PROVIDER_ICON_LIST.find((entry) => entry.id === "Zhipu")!.title;
    await typeInto(harness.dom, input!, sampleTitle);
    assert.deepEqual(renderedTitles(harness), expectedTitles(sampleTitle));

    const miss = "qqqzzz 不存在的图标";
    assert.equal(expectedTitles(miss).length, 0, "前置条件：这个查询词在图标集里不该有命中");
    await typeInto(harness.dom, input!, miss);
    assert.equal(renderedTitles(harness).length, 0);
    assert.match(document.querySelector(".provider-icon-empty")?.textContent ?? "", /未找到图标/);
  } finally {
    await harness.restore();
  }
});

test("ProviderIconPicker 选图标回传 id，选默认格回传 null", async () => {
  await loadProviderIconData();
  const harness = await setupDom();
  const { ProviderIconPicker } = await loadComponents();
  const received: (string | null)[] = [];
  const openAiTitle = PROVIDER_ICON_LIST.find((entry) => entry.id === "OpenAI")!.title;
  const targetTitle = PROVIDER_ICON_LIST.find((entry) => entry.id === "Zhipu")!.title;
  try {
    await harness.render(React.createElement(ProviderIconPicker, {
      onChange: (iconId: string | null) => { received.push(iconId); },
      value: "OpenAI"
    }));
    const document = harness.dom.window.document;
    const trigger = openPicker(harness);
    assert.ok((trigger.textContent ?? "").includes(openAiTitle), "已选图标时标题显示它的名字：" + openAiTitle);
    assert.equal(trigger.querySelector("svg.provider-icon-trigger-glyph")?.getAttribute("viewBox"), PROVIDER_ICON_DATA.OpenAI!.vb);

    const selected = document.querySelector<HTMLButtonElement>(".provider-icon-cell.is-selected");
    assert.equal(selected?.getAttribute("title"), openAiTitle, "选中态应当落在当前图标上");

    const target = document.querySelector<HTMLButtonElement>('.provider-icon-cell[title="' + targetTitle + '"]');
    assert.ok(target, "应当能点到目标图标");
    await act(async () => { target!.click(); });
    assert.deepEqual(received, ["Zhipu"]);

    openPicker(harness);
    const defaultCell = document.querySelector<HTMLButtonElement>(".provider-icon-cell.is-default");
    assert.ok(defaultCell, "网格第一格必须是默认图标");
    await act(async () => { defaultCell!.click(); });
    assert.deepEqual(received, ["Zhipu", null], "点默认格必须回传 null 才能清除覆盖");
  } finally {
    await harness.restore();
  }
});

test("图标边界：自带品牌图标的服务商一律用自带的，只有自定义服务商才受选择影响", () => {
  // 映射表里每一个 id 都必须真实存在于图标集 —— 防的是手打错大小写。
  for (const [catalogId, iconId] of Object.entries(PROVIDER_CATALOG_ICON_IDS)) {
    assert.ok(PROVIDER_ICON_DATA[iconId], catalogId + " 映射到的图标 " + iconId + " 在图标集里不存在");
  }

  // 自带图标：不该给选择入口。
  for (const catalogId of ["deepseek", "openai", "anthropic", "ollama"]) {
    assert.equal(hasBuiltInProviderIcon(catalogId), true, catalogId + " 应当算自带图标");
  }
  // 没有品牌的服务商（自定义端点）才给入口。
  for (const catalogId of ["custom", "openai-compatible", "不存在的目录 id", undefined]) {
    assert.equal(hasBuiltInProviderIcon(catalogId), false, String(catalogId) + " 不该算自带图标");
  }

  // 关键一条：自带图标优先于配置里存的值（DeepSeek 就是用他自带的）。
  assert.equal(resolveProviderIconId("Zhipu", "deepseek"), "DeepSeek");
  // 自定义服务商才用存下来的选择；没选过就交回手写字形。
  assert.equal(resolveProviderIconId("Zhipu", "custom"), "Zhipu");
  assert.equal(resolveProviderIconId(undefined, "custom"), undefined);
  assert.equal(resolveProviderIconId(undefined, undefined), undefined);
});
