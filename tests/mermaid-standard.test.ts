/** 标准图种用真实 Mermaid 装配；jsdom 几何接口只用于 SVG 契约，不代表视觉验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("标准渲染器的图种、文字、安全与临时节点生命周期", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["window", "document", "DOMParser", "XMLSerializer", "Element", "HTMLElement", "SVGElement", "Node", "CSSStyleSheet", "screen", "getComputedStyle"]) globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", { value(this: SVGElement) { return { x: 0, y: 0, width: Math.max(20, (this.textContent?.length ?? 0) * 8), height: 20 }; } });
  Object.defineProperty(dom.window.SVGElement.prototype, "getComputedTextLength", { value(this: SVGElement) { return Math.max(20, (this.textContent?.length ?? 0) * 8); } });
  // Cytoscape 的布局使用真实 CPU 算法；画布边界不绘制像素，只提供文本测量与绘制接口。
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value(this: HTMLCanvasElement) {
    return new Proxy({ canvas: this, measureText: (text: string) => ({ width: text.length * 8 }) }, { get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; } });
  } });
  const { renderStandardDiagram } = await import("../src/desktop/renderer/src/components/diagram/diagramRendering.js");
  const colors = { background: "#f5f5f5", primaryColor: "#f1f1f4", primaryTextColor: "#1c1c21", primaryBorderColor: "#c8c8d2", lineColor: "#4b4b53", textColor: "#1c1c21", secondaryColor: "#eeedfd", secondaryTextColor: "#1c1c21", secondaryBorderColor: "#4f46e5", tertiaryColor: "#ffffff", tertiaryTextColor: "#1c1c21", tertiaryBorderColor: "#e3e3e8", noteBkgColor: "#fbf0df", noteTextColor: "#96520a", noteBorderColor: "#b45309", edgeLabelBackground: "#ffffff", clusterBkg: "#f1f1f4", clusterBorder: "#e3e3e8", titleColor: "#1c1c21" };
  const theme = { dark: false, colors };
  const diagrams = [
    { name: "甘特图", code: "gantt\ntitle Release\ndateFormat YYYY-MM-DD\nsection Work\nBuild :a1, 2026-10-01, 2d", text: "Release" },
    { name: "饼图", code: 'pie title Usage\n"Read" : 40\n"Write" : 60', text: "Usage" },
    { name: "时间线", code: "timeline\ntitle History\n2026 : Launch\n2027 : Update", text: "History" },
    { name: "用户旅程", code: "journey\ntitle Day\nsection Morning\nCoffee: 5: User\nWork: 3: User", text: "Day" },
    { name: "象限图", code: "quadrantChart\ntitle Priorities\nx-axis Low --> High\ny-axis Low --> High\nTask: [0.3, 0.7]", text: "Priorities" },
    { name: "需求图", code: "requirementDiagram\nrequirement TestReq {\nid: 1\ntext: \"test requirement\"\nrisk: low\nverifymethod: test\n}", text: "TestReq" },
    { name: "Git图", code: "gitGraph\ncommit id: \"Init\"\nbranch develop\ncheckout develop\ncommit id: \"Work\"", text: "Init" },
    { name: "看板", code: "kanban\nTodo[Todo]\n task[Write tests]", text: "Write tests" },
    { name: "桑基图", code: "sankey-beta\nSource,Target,10", text: "Source" },
    { name: "思维导图", code: "mindmap\nroot((Project))\n  Tests\n  Release", text: "Project" },
    { name: "方块图", code: "block-beta\ncolumns 2\nA[\"Start\"] B[\"Done\"]\nA-->B", text: "Start" },
    { name: "C4图", code: 'C4Context\nPerson(user, "User", "Reader")\nSystem(system, "App", "Local")\nRel(user, system, "Uses")', text: "User" },
    { name: "架构图", code: "architecture-beta\ngroup cloud(cloud)[Cloud]\nservice db(database)[Database] in cloud\nservice api(server)[API] in cloud\ndb:R -- L:api", text: "Database" },
    { name: "数据包图", code: 'packet-beta\n0-7: "Header"\n8-15: "Data"', text: "Header" },
    { name: "雷达图", code: 'radar-beta\ntitle Radar\naxis a["Speed"], b["Cost"], c["Safety"]\ncurve c1["Option"]{80, 60, 90}', text: "Radar" },
    { name: "矩形树图", code: 'treemap-beta\n"Section"\n  "First": 30\n  "Second": 70', text: "Section" }
  ];
  try {
    for (const { name, code, text } of diagrams) await t.test(name, { timeout: 10000 }, async () => {
      const output = await renderStandardDiagram(code, theme, new AbortController().signal);
      const svg = new dom.window.DOMParser().parseFromString(output.svg, "image/svg+xml").documentElement;
      assert.equal(svg.localName, "svg");
      assert.ok([...svg.querySelectorAll("text, tspan")].some(element => element.textContent?.includes(text)), `${name}标签必须在禁用 HTML label 后仍可见`);
      assert.ok(svg.querySelector("style")?.textContent);
      assert.equal(svg.querySelector("foreignObject, script, image"), null);
      assert.equal(document.body.children.length, 0, "临时渲染节点必须释放");
    });
    await t.test("画布布局抛错时也释放渲染器创建的临时节点", async () => {
      const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext")!;
      let failed = false;
      Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { ...descriptor, value() { failed = true; throw new Error("canvas boundary unavailable"); } });
      try {
        await assert.rejects(renderStandardDiagram("mindmap\nroot((Broken))\n  Node", theme, new AbortController().signal));
        assert.equal(failed, true);
        assert.equal(document.body.children.length, 0, "依赖失败不能留下布局节点");
      } finally { Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", descriptor); }
    });
    await t.test("解析失败与取消仍释放临时 DOM", async () => {
      await assert.rejects(renderStandardDiagram("gantt\ninvalid source !!", theme, new AbortController().signal));
      assert.equal(document.body.children.length, 0);
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(renderStandardDiagram("pie\n\"A\":1", theme, cancelled.signal));
      assert.equal(document.body.children.length, 0);
    });
  } finally { dom.window.close(); }
});
