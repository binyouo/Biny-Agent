/** 真实图表渲染器的 SVG 契约，不以源码字符串或截图作为视觉验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("真实美化图表与 SVG 隔离", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "DOMParser", "XMLSerializer", "Element", "HTMLElement", "SVGElement", "Node", "getComputedStyle"]) globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const { renderBeautifulDiagram, sanitizeDiagramSvg, normalizeDiagramSource } = await import("../src/desktop/renderer/src/components/diagram/diagramRendering.js");
  const colors = { background: "#f5f5f5", primaryColor: "#f1f1f4", primaryTextColor: "#1c1c21", primaryBorderColor: "#c8c8d2", lineColor: "#4b4b53", textColor: "#1c1c21", secondaryColor: "#eeedfd", secondaryTextColor: "#1c1c21", secondaryBorderColor: "#4f46e5", tertiaryColor: "#ffffff", tertiaryTextColor: "#1c1c21", tertiaryBorderColor: "#e3e3e8", noteBkgColor: "#fbf0df", noteTextColor: "#96520a", noteBorderColor: "#b45309", edgeLabelBackground: "#ffffff", clusterBkg: "#f1f1f4", clusterBorder: "#e3e3e8", titleColor: "#1c1c21" };
  const theme = { dark: false, colors };
  const diagrams = [
    { name: "流程图", code: "flowchart TD\nStart[开始] --> Decision{继续？}\nDecision -->|是| Done[完成]", labels: ["开始", "继续？", "完成"] },
    { name: "时序图", code: "sequenceDiagram\nparticipant Alice\nparticipant Bob\nAlice->>Bob: 你好\nBob-->>Alice: 收到", labels: ["Alice", "Bob", "你好", "收到"] },
    { name: "类图", code: "classDiagram\nclass Account {\n+String name\n+save()\n}\nAccount --> Record", labels: ["Account", "name", "save", "Record"] },
    { name: "实体关系图", code: "erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\nstring name\n}", labels: ["CUSTOMER", "ORDER", "places", "name"] },
    { name: "状态图", code: "stateDiagram-v2\n[*] --> Idle\nIdle --> Running\nRunning --> [*]", labels: ["Idle", "Running"] },
    { name: "XY图", code: 'xychart-beta\ntitle "Sales"\nx-axis [Jan, Feb, Mar]\ny-axis "Revenue" 0 --> 100\nbar [20, 50, 80]\nline [15, 45, 90]', labels: ["Sales", "Revenue", "Jan", "Feb"] }
  ];
  try {
    for (const { name, code, labels } of diagrams) await t.test(`${name}使用真实渲染器保持文字、几何和主题`, () => {
      const output = renderBeautifulDiagram(code, theme);
      assert.ok(output, `${name}不应降级为源码`);
      const svg = new dom.window.DOMParser().parseFromString(output.svg, "image/svg+xml").documentElement;
      const viewBox = svg.getAttribute("viewBox")?.split(/\s+/u).map(Number);
      assert.ok(viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0);
      assert.ok(svg.querySelector("path, rect, polygon, line, polyline"));
      const visibleText = [...svg.querySelectorAll("text")].map(element => element.textContent).join(" ");
      for (const label of labels) assert.ok(visibleText.includes(label), `${name}缺少可见标签 ${label}`);
      assert.ok(svg.querySelector("style")?.textContent?.includes("font-family"));
      assert.ok(svg.getAttribute("style")?.includes("--bg: #f5f5f5") || svg.getAttribute("style")?.includes("--bg:#f5f5f5"));
      assert.equal(svg.querySelector("foreignObject, script, image"), null);
      assert.doesNotMatch(output.svg, /fonts\.googleapis|@import/u);
    });
    await t.test("多张图的 marker 和 clipPath 引用各自拥有独立 ID", () => {
      const first = renderBeautifulDiagram(diagrams[1]!.code, theme)!;
      const second = renderBeautifulDiagram(diagrams[1]!.code, { dark: true, colors: { ...colors, background: "#1a1a1a", textColor: "#f5f5f5" } })!;
      document.body.innerHTML = `<div>${first.svg}</div><div>${second.svg}</div>`;
      const ids = [...document.querySelectorAll("[id]")].map(element => element.id);
      assert.equal(new Set(ids).size, ids.length);
      for (const svg of document.querySelectorAll("svg")) {
        for (const element of svg.querySelectorAll("[marker-end], [marker-start], [clip-path]")) {
          for (const name of ["marker-end", "marker-start", "clip-path"]) {
            const local = element.getAttribute(name)?.match(/url\(['"]?#([^)'"\s]+)['"]?\)/u)?.[1];
            if (local) assert.ok([...svg.querySelectorAll("[id]")].some(candidate => candidate.id === local), "局部引用不能指向另一张图");
          }
        }
        const sheet = new dom.window.CSSStyleSheet();
        sheet.replaceSync(svg.querySelector("style")?.textContent ?? "");
        for (const rule of [...sheet.cssRules]) if (rule.type === 1) assert.ok((rule as CSSStyleRule).selectorText.startsWith(`#${svg.id}`), "图表 CSS 不影响其他图或页面元素");
      }
      const raw = '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><rect clip-path="url(#clip)" width="10" height="10"/></svg>';
      const clip = new dom.window.DOMParser().parseFromString(sanitizeDiagramSvg(raw), "image/svg+xml").documentElement;
      const reference = clip.querySelector("rect[clip-path]")!.getAttribute("clip-path")!.match(/#([^)]*)/u)![1];
      assert.equal(clip.querySelector("clipPath")?.id, reference);
    });
    await t.test("SVG 样式只能作用于图形，不能覆盖应用页面", () => {
      const svg = new dom.window.DOMParser().parseFromString(sanitizeDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;inset:0;z-index:9999;fill:red"><style>svg{position:fixed;z-index:9999;fill:blue}@keyframes move{to{position:fixed;fill:green}}</style><rect width="10" height="10"/></svg>'), "image/svg+xml").documentElement;
      assert.doesNotMatch(svg.getAttribute("style") ?? "", /position|inset|z-index/u);
      assert.ok(svg.getAttribute("style")?.includes("fill"));
      const sheet = new dom.window.CSSStyleSheet(); sheet.replaceSync(svg.querySelector("style")!.textContent!);
      for (const rule of [...sheet.cssRules]) assert.doesNotMatch(rule.cssText, /position|z-index/u);
    });
    await t.test("不存在的片段引用不能读取页面其他图的定义", () => {
      const svg = new dom.window.DOMParser().parseFromString(sanitizeDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#other-chart"/><rect fill="url(#other-chart)"/></svg>'), "image/svg+xml").documentElement;
      assert.equal(svg.querySelector("[href]"), null);
      assert.equal(svg.querySelector("rect")?.getAttribute("fill"), "none");
    });
    await t.test("流式完整前缀可以立即成为有效图，最终完整源包含最后一行", () => {
      const prefix = "sequenceDiagram\nAlice->>Bob: hello";
      const partial = renderBeautifulDiagram(`${prefix}\nAlice->>`, theme, true);
      assert.equal(partial?.code, prefix);
      assert.ok(partial?.svg.includes("hello"));
      const final = renderBeautifulDiagram(`${prefix}\nBob-->>Alice: done`, theme);
      assert.equal(final?.code, `${prefix}\nBob-->>Alice: done`);
      assert.ok(final?.svg.includes("done"));
      assert.equal(renderBeautifulDiagram("gantt\ntitle Release", theme), undefined);
    });
    await t.test("样式色函数、重复匿名分组和显式底色文字被正确呈现", () => {
      const code = "flowchart TD\nsubgraph 中文\nA[Bright]\nend\nsubgraph 中文\nB[Dark]\nend\nA-->B\nstyle A fill:rgb(255, 255, 255)\nstyle B fill:#000000";
      const output = renderBeautifulDiagram(code, theme);
      assert.ok(output);
      assert.equal(normalizeDiagramSource(code).match(/subgraph subgraph_/gu)?.length, 2);
      const svg = new dom.window.DOMParser().parseFromString(output.svg, "image/svg+xml").documentElement;
      const bright = [...svg.querySelectorAll("text")].find(element => element.textContent === "Bright");
      const dark = [...svg.querySelectorAll("text")].find(element => element.textContent === "Dark");
      assert.equal(bright?.getAttribute("fill"), "#1f2328");
      assert.equal(dark?.getAttribute("fill"), "#f6f8fa");
    });
  } finally { dom.window.close(); }
});
