/**
 * Read only the actual display sources; evaluate transpiled code with inert
 * pi-tui/theme imports. No product module loader, terminal, capability detection,
 * Host, provider, storage or clipboard. Never include raw payloads in diagnostics.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import * as ts from "typescript";

type TextFilters = {
  sanitizeTerminalText(text: string): string;
  sanitizeMarkdownText(text: string): string;
};
type Item = { id: string; kind: "user" | "assistant"; content: string; attachments?: Array<{ name: string; mimeType: string }> };
type Message = { update(item: Item): void };
type Components = {
  UserMessageComponent: new (item: Item) => Message;
  AssistantMessageComponent: new (item: Item) => Message;
  ActivitySummaryComponent: new (item: Record<string, unknown>) => { update(item: Record<string, unknown>): void };
  NoticeComponent: new (item: Record<string, unknown>) => { update(item: Record<string, unknown>): void };
  ToolExecutionComponent: new (item: Record<string, unknown>) => {
    render(width: number): string[];
    toggleDetails(): void;
    update(item: Record<string, unknown>): void;
    invalidate(): void;
  };
};

function evaluate<T>(source: string, filename: string, imports: Record<string, unknown>): T {
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  });
  assert.ok(!compiled.diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error), "source transpilation");
  const context = createContext({
    exports: {}, instances: [], args: [] as unknown[], exportName: "", methodName: "", instanceIndex: 0,
    require: (name: string): unknown => {
      assert.ok(Object.hasOwn(imports, name), "only allowlisted inert imports");
      return imports[name];
    },
    console: undefined,
    process: undefined
  });
  const run = (code: string): unknown => new Script(code, { filename }).runInContext(context, { timeout: 1000 });
  run(compiled.outputText);
  // Only host-side call bridges escape. Product functions/instances stay in the
  // retained context; initialization AND each tested operation have a timeout.
  // This is an execution bound, not a security sandbox for arbitrary source.
  const facade: Record<string, unknown> = {};
  for (const name of run("Object.keys(exports)") as string[]) {
    facade[name] = function (...args: unknown[]): unknown {
      context.exportName = name;
      context.args = args;
      if (!new.target) return run("exports[exportName](...args)");
      const index = run("instances.push(new exports[exportName](...args)) - 1") as number;
      return new Proxy({}, {
        get: (_target, method: string | symbol) => (...methodArgs: unknown[]): unknown => {
          assert.ok(typeof method === "string", "named component method");
          context.instanceIndex = index;
          context.methodName = method as string;
          context.args = methodArgs;
          return run("instances[instanceIndex][methodName](...args)");
        }
      });
    };
  }
  return facade as T;
}

function fixture() {
  const filters = evaluate<TextFilters>(readFileSync(resolve(process.cwd(), "src/tui/terminalText.ts"), "utf8"), "terminalText.ts", {});
  const markdown: Array<{ text: string; options: unknown[]; updates: number }> = [];
  const textInputs: string[] = [];
  class Container {
    children: unknown[] = [];
    addChild(child: unknown): void { this.children.push(child); }
    removeChild(child: unknown): void { this.children = this.children.filter((value) => value !== child); }
    invalidate(): void { /* Inert: no render scheduling. */ }
    render(_width: number): string[] { return []; }
  }
  class Markdown {
    readonly record: { text: string; options: unknown[]; updates: number };
    constructor(text: string, ...options: unknown[]) {
      this.record = { text, options, updates: 0 };
      markdown.push(this.record);
    }
    setText(text: string): void { this.record.text = text; this.record.updates += 1; }
  }
  class Text {
    constructor(private text: string, ..._options: unknown[]) { textInputs.push(text); }
    setText(text: string): void { this.text = text; textInputs.push(text); }
    render(_width: number): string[] { return this.text.split("\n"); }
  }
  class Box extends Container { constructor(..._options: unknown[]) { super(); } }
  class Spacer { constructor(..._options: unknown[]) {} }
  const styledInputs: Array<{ token: string; text: string }> = [];
  const theme = {
    fg: (token: string, value: string) => { styledInputs.push({ token, text: value }); return value; },
    bg: (_token: string, value: string) => value,
    bold: (value: string) => value,
    italic: (value: string) => value
  };
  const markdownTheme = { marker: "trusted-theme" };
  const components = evaluate<Components>(readFileSync(resolve(process.cwd(), "src/tui/components/messages.ts"), "utf8"), "messages.ts", {
    "@earendil-works/pi-tui": { Container, Markdown, Text, Box, Spacer,
      truncateToWidth: (text: string) => text, visibleWidth: (text: string) => text.length },
    "../../utils/diffLines.js": { classifyDiffLines: () => [] },
    "../theme/index.js": { theme, markdownTheme: () => markdownTheme },
    "../transcriptText.js": { formatToolDuration: () => "", thinkingHeaderLabel: () => "" },
    "../terminalText.js": filters
  });
  return { filters, components, markdown, markdownTheme, textInputs, styledInputs };
}

const cases: ReadonlyArray<readonly [string, string, string]> = [
  ["ordinary", "中文 👩🏽‍💻 cafe\u0301", "中文 👩🏽‍💻 cafe\u0301"],
  ["LF/TAB", "a\nb\tc", "a\nb\tc"],
  ["CR", "a\rb\r\nc", "ab\nc"],
  ["CSI erase", "a\u001b[2Jb", "ab"],
  ["CSI cursor", "a\u001b[1;1Hb", "ab"],
  ["external SGR", "a\u001b[31mb", "ab"],
  ["OSC title BEL", "a\u001b]0;title\u0007b", "a]0;titleb"],
  ["OSC clipboard-shaped", "a\u001b]52;c;WA==\u0007b", "a]52;c;WA==b"],
  ["OSC title ST", "a\u001b]0;title\u001b\\b", "a]0;title\\b"],
  ["C1 OSC/ST", "a\u009d0;title\u009cb", "a0;titleb"],
  ["C1 CSI", "a\u009b2Jb", "a2Jb"],
  ["APC", "a\u001b_pi:c\u0007b", "a_pi:cb"],
  ["incomplete ESC", "a\u001b", "a"],
  ["incomplete CSI", "a\u001b[", "a["],
  ["CSI final letter", "a\u001b[b", "a"],
  ["C0 and DEL", "a\u0000\u0007\u0008\u000b\u000c\u001f\u007fb", "ab"],
  ["entity spelling", "&#27;[2J &#x1b;]0;title&#7; &NewLine;", "&#27;[2J &#x1b;]0;title&#7; &NewLine;"],
  ["escape spelling", "\\u001b[2J %1B%5D0%3Btitle%07", "\\u001b[2J %1B%5D0%3Btitle%07"]
];
const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

// Boolean assertions intentionally prevent assertion reporters from dumping controls.
test("display filters remove external controls while preserving layout whitespace", () => {
  const { filters } = fixture();
  for (const [label, source, expected] of cases) {
    assert.ok(filters.sanitizeTerminalText(source) === expected, label);
    assert.ok(!forbidden.test(filters.sanitizeTerminalText(source)), `${label} boundary`);
  }
  assert.ok(filters.sanitizeMarkdownText("a\rb\r\nc\nd\te") === "a\nb\nc\nd\te", "Markdown CR normalization");
  for (let code = 0; code <= 0x9f; code += 1) {
    if (code >= 0x20 && code < 0x7f || code === 9 || code === 10) continue;
    assert.ok(filters.sanitizeTerminalText(String.fromCharCode(code)) === "", "C0/DEL/C1 coverage");
  }
});

for (const kind of ["user", "assistant"] as const) {
  test(`${kind} Markdown constructor and update use the actual boundary`, () => {
    const { components, filters, markdown, markdownTheme } = fixture();
    const Constructor = kind === "user" ? components.UserMessageComponent : components.AssistantMessageComponent;
    for (const [label, source] of cases) {
      const item: Item = { id: "message", kind, content: source };
      const before = item.content;
      const component = new Constructor(item);
      const record = markdown.at(-1)!;
      assert.ok(record.text === filters.sanitizeMarkdownText(source), `${label} constructor`);
      assert.ok(record.options[2] === markdownTheme, "trusted theme passed untouched");
      assert.ok(item.content === before, "source message unchanged");
      component.update({ ...item, content: `updated\r${source}` });
      assert.ok(record.text === filters.sanitizeMarkdownText(`updated\r${source}`), `${label} update`);
      assert.ok(record.updates === 1, "existing Markdown instance updated");
      const after = record.text;
      component.update({ ...item, kind: kind === "user" ? "assistant" : "user", content: "wrong kind" });
      assert.ok(record.text === after, "wrong-kind update ignored");
    }
  });

  test(`${kind} ordinary Markdown syntax and CR layout reach renderer intact`, () => {
    const { components, markdown } = fixture();
    const Constructor = kind === "user" ? components.UserMessageComponent : components.AssistantMessageComponent;
    const ordinary = "## 标题\r\n\r> quote\r\n\r\n| x | y |\n|---|---|\n| a | b |\n\n```ts\nconst x = 1;\n```\n\n`code` **bold** [link](https://example.test/a%1B)\n&#27; &NewLine;\n\tindent\\";
    const expected = ordinary.replace(/\r\n|\r/gu, "\n");
    const component = new Constructor({ id: "message", kind, content: ordinary });
    const record = markdown.at(-1)!;
    assert.ok(record.text === expected, "ordinary constructor");
    component.update({ id: "message", kind, content: ordinary + "\rnext" });
    assert.ok(record.text === expected + "\nnext", "ordinary update");
    if (kind === "user") {
      const options = record.options[4] as { preserveOrderedListMarkers: boolean; preserveBackslashEscapes: boolean };
      assert.ok(options.preserveOrderedListMarkers && options.preserveBackslashEscapes, "user Markdown options unchanged");
    }
  });
}

test("all Markdown syntax placements are sanitized before the inert parser boundary", () => {
  const { components, markdown } = fixture();
  const control = "\u001b]0;title\u0007\u009d";
  const placements = [control, `\`${control}\``, `\`\`\`txt\n${control}\n\`\`\``, `# ${control}`, `> ${control}`,
    `| column |\n|---|\n| ${control} |`, `<span>${control}</span>`, `[${control}](https://example.test)`,
    `[label](https://example.test/${control})`, `[label][ref]\n\n[ref]: https://example.test/${control}`,
    `<https://example.test/${control}>`];
  for (const content of placements) {
    new components.AssistantMessageComponent({ id: "message", kind: "assistant", content });
    assert.ok(!forbidden.test(markdown.at(-1)!.text), "syntax placement control removal");
  }
});

test("stream updates sanitize complete accumulated content, not individual deltas", () => {
  const { components, markdown, filters } = fixture();
  const component = new components.AssistantMessageComponent({ id: "message", kind: "assistant", content: "" });
  const record = markdown.at(-1)!;
  let accumulated = "";
  for (const delta of ["first\r", "\nnext", "\u001b", "[2", "J", "\u001b]0;title", "\u001b", "\\", "\u009d", "last"]) {
    accumulated += delta;
    component.update({ id: "message", kind: "assistant", content: accumulated });
    assert.ok(record.text === filters.sanitizeMarkdownText(accumulated), "accumulated update");
    assert.ok(!forbidden.test(record.text), "each partial update control-free");
  }
  assert.ok(record.text.startsWith("first\nnext"), "split CRLF stays one line break");
});

test("tool body retains old CR deletion, TAB expansion, cap and trimming", () => {
  const { components, textInputs } = fixture();
  for (const [, source] of [...cases, ["long", "x".repeat(16_001), ""] as const]) {
    const original = source + "\r\tend  \n";
    const legacy = original.slice(0, 16_000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replaceAll("\t", "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "").trimEnd();
    for (const expanded of [false, true]) {
      const tool = new components.ToolExecutionComponent({ id: "tool", kind: "tool", tool: "Bash", title: "Ran check",
        status: "failed", output: original, details: original });
      if (expanded) tool.toggleDetails();
      tool.render(80);
      assert.ok(textInputs.at(-1) === legacy, "legacy body passed to inert Text");
    }
  }
});


for (const kind of ["activity", "notification", "error"] as const) {
  test(`${kind} constructor and update filter content before styling`, () => {
    const { components, filters, styledInputs } = fixture();
    const Constructor = kind === "activity" ? components.ActivitySummaryComponent : components.NoticeComponent;
    for (const [label, source] of cases) {
      const item = { id: "message", kind, content: source, tone: "warning" };
      const prefix = kind === "activity" ? "" : kind === "error" ? "Error " : "• ";
      const component = new Constructor(item);
      assert.ok(styledInputs.at(-1)!.text === prefix + filters.sanitizeTerminalText(source), `${label} constructor`);
      component.update({ ...item, content: "updated " + source });
      assert.ok(styledInputs.at(-1)!.text === prefix + filters.sanitizeTerminalText("updated " + source), `${label} update`);
      assert.ok(item.content === source, "source item unchanged");
    }
    for (const tone of ["success", "warning", "muted"]) {
      new Constructor({ id: "plain", kind, tone, content: "ordinary 中文\nnext" });
      const expected = (kind === "activity" ? "" : kind === "error" ? "Error " : "• ") + "ordinary 中文\nnext";
      assert.ok(styledInputs.at(-1)!.text === expected, "ordinary notice/activity semantics");
    }
  });
}

test("attachment labels filter controls before styling on constructor and update", () => {
  const { components, styledInputs, filters } = fixture();
  for (const [label, name] of cases) {
    const item: Item = { id: "user", kind: "user", content: "ordinary", attachments: [{ name, mimeType: "image/png" }] };
    const component = new components.UserMessageComponent(item);
    assert.ok(styledInputs.at(-1)!.text === "[Image #1] " + filters.sanitizeTerminalText(name), `${label} constructor`);
    component.update({ ...item, attachments: [{ name: "updated " + name, mimeType: "text/plain" }] });
    assert.ok(styledInputs.at(-1)!.text === "[Attachment #1] " + filters.sanitizeTerminalText("updated " + name), `${label} update`);
    assert.ok(item.attachments![0]!.name === name, "attachment source unchanged");
    const count = styledInputs.length;
    component.update({ ...item, attachments: [] });
    assert.ok(styledInputs.length === count, "attachment removal adds no label");
  }
});

test("tool title filtering precedes split/style and retains cache invalidation", () => {
  const { components, styledInputs } = fixture();
  for (const [label, source] of cases) {
    const item = { id: "tool", kind: "tool", tool: "Bash", title: "Ran " + source, status: "success" };
    const component = new components.ToolExecutionComponent(item);
    const first = component.render(80);
    assert.ok(!forbidden.test(first.join("\n")), `${label} rendered title boundary`);
    assert.ok(styledInputs.every((entry) => !forbidden.test(entry.text)), `${label} before style`);
    assert.ok(component.render(80) === first, "completed title render cached");
    component.update({ ...item, title: "Read " + source });
    const updated = component.render(80);
    assert.ok(updated !== first && updated.join("\n").includes("Read"), "update invalidates title cache");
    assert.ok(!forbidden.test(updated.join("\n")), "updated title filtered");
    component.invalidate();
    assert.ok(component.render(80) !== updated, "theme invalidation recomputes title");
    assert.ok(item.title === "Ran " + source, "original title retained");
  }
  const ordinary = new components.ToolExecutionComponent({ id: "plain", kind: "tool", tool: "Bash", title: "Ran tests", status: "success" });
  assert.ok(ordinary.render(80).join("\n") === "\n✓ Ran tests", "ordinary title text preserved");
  assert.ok(ordinary.render(40).join("\n") === "\n✓ Ran tests", "ordinary width path preserved with inert metrics");
});
