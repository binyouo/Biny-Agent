/** Actual source closure, inert UI only. Never initialize pi-tui or product IO. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import * as ts from "typescript";
// Local fixture shapes avoid pulling product types into isolated test compilation.
// Runtime behavior still comes exclusively from the actual-source VM closure.
type PermissionChoice = "allow_once" | "allow_always" | "deny" | "deny_with_reason";
type TuiPermissionRequest = {
  tool: string;
  title: string;
  details: string;
  actionType: string;
  riskLevel: string;
  requireFullYes: boolean;
  command?: string;
  targetPath?: string;
  reason?: string;
  diff?: string;
  preview?: string;
};

type Dialog = {
  render(width: number): string[];
  setRequest(request: TuiPermissionRequest): void;
  setDetailsExpanded(expanded: boolean): void;
  handleInput(data: string): void;
};
type DialogExports = { PermissionDialog: new (
  request: TuiPermissionRequest,
  answer: (choice: PermissionChoice, reason?: string) => void,
  toggle: () => void,
  maxLines?: number | (() => number)
) => Dialog };

// All actual-source initialization and calls remain within a timed VM bridge.
// This bounds known source execution; it is not a sandbox for arbitrary code.
function evaluate<T>(relative: string, imports: Record<string, unknown>): T {
  const source = readFileSync(resolve(process.cwd(), relative), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: relative,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  });
  assert.ok(!compiled.diagnostics?.some(entry => entry.category === ts.DiagnosticCategory.Error), "source transpilation");
  const context = createContext({ exports: {}, instances: [], args: [] as unknown[], exportName: "", methodName: "", instanceIndex: 0,
    console: undefined, process: undefined,
    require: (name: string): unknown => {
      assert.ok(Object.hasOwn(imports, name), "only explicit inert or actual pure imports");
      return imports[name];
    }
  });
  const run = (code: string): unknown => new Script(code, { filename: relative }).runInContext(context, { timeout: 1000 });
  run(compiled.outputText);
  const facade: Record<string, unknown> = {};
  for (const name of run("Object.keys(exports)") as string[]) {
    context.exportName = name;
    if (run("typeof exports[exportName]") !== "function") {
      facade[name] = run("exports[exportName]");
      continue;
    }
    facade[name] = function (...args: unknown[]): unknown {
      context.exportName = name;
      context.args = args;
      if (!new.target) return run("exports[exportName](...args)");
      const index = run("instances.push(new exports[exportName](...args)) - 1") as number;
      return new Proxy({}, { get: (_target, method: string | symbol) => (...values: unknown[]): unknown => {
        assert.ok(typeof method === "string", "named actual method");
        context.instanceIndex = index;
        context.methodName = method as string;
        context.args = values;
        return run("instances[instanceIndex][methodName](...args)");
      } });
    };
  }
  return facade as T;
}

const forbidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const trustedOpen = "\u001b[36m";
const trustedClose = "\u001b[39m";
function unstyle(text: string): string {
  return text.replaceAll(trustedOpen, "").replaceAll(trustedClose, "");
}
function fixture() {
  const confirmation = evaluate<Record<string, unknown>>("src/permission/confirmation.ts", {});
  const options = evaluate<Record<string, unknown>>("src/tui/permissionOptions.ts", {
    "../permission/confirmation.js": confirmation
  });
  const presentation = evaluate<Record<string, unknown>>("src/permission/presentation.ts", {});
  const styled: string[] = [];
  const wrapped: string[] = [];
  const texts: string[] = [];
  type Child = { render(width: number): string[] };
  class Container {
    children: Child[] = [];
    addChild(child: Child): void { this.children.push(child); }
    clear(): void { this.children = []; }
    render(width: number): string[] { return this.children.flatMap(child => child.render(width)); }
  }
  class Text {
    constructor(private text: string, ..._options: unknown[]) { texts.push(text); }
    setText(text: string): void { this.text = text; texts.push(text); }
    render(_width: number): string[] { return this.text.split("\n"); }
  }
  class Unused { constructor(..._args: unknown[]) { throw new Error("unused selector must not initialize"); } }
  const paint = (text: string): string => { styled.push(text); return trustedOpen + text + trustedClose; };
  const components = evaluate<DialogExports>("src/tui/components/dialogs.ts", {
    "../../permission/presentation.js": presentation,
    "../permissionOptions.js": options,
    "../theme/index.js": { theme: { fg: (_token: string, text: string) => paint(text), bold: paint },
      selectListTheme: () => { throw new Error("unused selector theme"); } },
    "@earendil-works/pi-tui": { Container, Text, Input: Unused, SelectList: Unused,
      matchesKey: (data: string, key: string) => data === `<${key}>`,
      truncateToWidth: (text: string) => text,
      wrapTextWithAnsi: (text: string) => { wrapped.push(text); return text.split("\n"); } }
  });
  const answers: Array<{ choice: PermissionChoice; reason?: string }> = [];
  let toggles = 0;
  const create = (request: TuiPermissionRequest, maxLines?: number | (() => number)) => new components.PermissionDialog(
    request, (choice, reason) => answers.push({ choice, reason }), () => { toggles += 1; }, maxLines
  );
  const clean = (): void => {
    assert.ok(styled.every(value => !forbidden.test(unstyle(value))), "external controls absent before theme");
    assert.ok(wrapped.every(value => !forbidden.test(unstyle(value))), "external controls absent before wrap");
    assert.ok(texts.every(value => !forbidden.test(unstyle(value))), "external controls absent at Text boundary");
  };
  return { create, answers, styled, wrapped, texts, clean, toggles: () => toggles };
}
function request(): TuiPermissionRequest {
  return { tool: "Bash", title: "unused", details: "ordinary details", actionType: "shell", riskLevel: "medium", requireFullYes: false };
}
// Explicit expectations, not a copy of the display conversion algorithm.
// Literal backslash-u text can match a control's notation; it is not reversible.
const cases: ReadonlyArray<readonly [string, string, string]> = [
  ["ordinary", "中文\nnext\tcell", "中文\nnext\tcell"],
  ["CSI", "a\u001b[2J\u001b[1;1H\u001b[31mb", "a\\u001b[2J\\u001b[1;1H\\u001b[31mb"],
  ["OSC", "a\u001b]0;title\u0007b", "a\\u001b]0;title\\u0007b"],
  ["APC", "a\u001b_pi:c\u0007b", "a\\u001b_pi:c\\u0007b"],
  ["C1", "a\u009b2J\u009dtitle\u009cb", "a\\u009b2J\\u009dtitle\\u009cb"],
  ["C0 DEL", "a\u0000\u0008\u000b\u000c\u001f\u007fb", "a\\u0000\\u0008\\u000b\\u000c\\u001f\\u007fb"],
  ["partial", "a\u001b[", "a\\u001b["],
  ["CRLF", "a\r\nb", "a\\u000d\nb"],
  ["bare CR", "a\rb", "a\\u000db"],
  ["Windows path", "C:\\Users\\name\\file.txt", "C:\\Users\\name\\file.txt"],
  ["literal spelling", "\\u001b[2J &#27;", "\\u001b[2J &#27;"]
];
for (const field of ["command", "targetPath", "details", "reason", "diff", "preview"] as const) {
  test(`permission ${field} constructor, update and expanded rendering visibly escape actual source`, () => {
    for (const [label, source, expected] of cases) {
      const f = fixture();
      const input = { ...request(), [field]: `field ${source}` };
      const before = JSON.stringify(input);
      const dialog = f.create(input);
      if (field === "preview") dialog.setDetailsExpanded(true);
      const rendered = unstyle(dialog.render(100).join("\n"));
      // Existing presentation normalizes details CRLF before this display boundary.
      const projected = field === "details" && label === "CRLF" ? "a\nb" : expected;
      assert.ok(rendered.includes(`field ${projected}`), `${label} field visible and ordinary layout preserved`);
      assert.ok(!forbidden.test(rendered), `${label} rendered boundary`);
      assert.ok(f.texts.at(-1)!.includes(trustedOpen), "trusted styling survives");
      dialog.setRequest({ ...input, [field]: `updated ${source}` });
      assert.ok(unstyle(dialog.render(100).join("\n")).includes(`updated ${projected}`), `${label} updated request`);
      assert.ok(JSON.stringify(input) === before, "original request unchanged");
      f.clean();
    }
  });
}

test("collapsed diff and optional preview retain disclosure behavior", () => {
  const f = fixture();
  const dialog = f.create({ ...request(), diff: Array.from({ length: 8 }, (_, i) => `+ line${i}`).join("\n"), preview: "preview-only" });
  const collapsed = unstyle(dialog.render(100).join("\n"));
  assert.ok(collapsed.includes("line5") && !collapsed.includes("line6") && !collapsed.includes("preview-only"), "collapsed six diff lines only");
  dialog.handleInput("<ctrl+o>");
  assert.ok(f.toggles() === 1, "toggle callback unchanged");
  dialog.setDetailsExpanded(true);
  const expanded = unstyle(dialog.render(100).join("\n"));
  assert.ok(expanded.includes("line7") && expanded.includes("preview-only"), "expanded details preserved");
  f.clean();
});

test("display escaping does not change strong confirmation or answer callbacks", () => {
  const f = fixture();
  const dialog = f.create({ ...request(), requireFullYes: true });
  dialog.handleInput("<enter>");
  assert.ok(Number(f.answers.length) === 0, "empty strong confirmation does not approve");
  for (const letter of "yes") dialog.handleInput(letter);
  dialog.render(80);
  dialog.handleInput("<enter>");
  assert.ok(Number(f.answers.length) === 1 && f.answers[0]!.choice === "allow_once", "full yes callback preserved");
  dialog.setRequest({ ...request(), requireFullYes: true });
  dialog.handleInput("<enter>");
  assert.ok(Number(f.answers.length) === 1, "new request resets confirmation");
  dialog.handleInput("<escape>");
  assert.ok(f.answers.at(-1)!.choice === "deny", "escape callback preserved");
  f.clean();
});

test("local C1 input is escaped for display only, not silently rewritten for submission", () => {
  const f = fixture();
  const dialog = f.create({ ...request(), requireFullYes: true });
  dialog.handleInput("\u009d");
  assert.ok(unstyle(dialog.render(80).join("\n")).includes("\\u009d"), "confirmation control visible");
  dialog.handleInput("<enter>");
  assert.ok(Number(f.answers.length) === 0, "C1 is not full yes");
  dialog.setRequest(request());
  dialog.handleInput("<up>");
  dialog.handleInput("\u009d");
  dialog.handleInput("x");
  assert.ok(unstyle(dialog.render(80).join("\n")).includes("\\u009dx"), "denial control visible");
  dialog.handleInput("<enter>");
  assert.ok(Number(f.answers.length) === 1 && f.answers[0]!.choice === "deny_with_reason", "denial callback preserved");
  assert.ok(f.answers[0]!.reason === "\u009dx", "raw denial state and submission unchanged");
  f.clean();
});

test("bounded detail budget retains approval action text", () => {
  const f = fixture();
  const dialog = f.create({ ...request(), details: "line\n".repeat(30) }, () => 8);
  const rendered = unstyle(dialog.render(80).join("\n"));
  assert.ok(rendered.includes("允许一次") && rendered.includes("部分详情已收起"), "bounded actions and truncation marker");
  f.clean();
});
