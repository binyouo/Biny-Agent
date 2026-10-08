import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";

const importPattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
const requirePattern = /\brequire\(["']([^"']+)["']\)/g;
const terminalPattern = /(?=(\b(?:from|import|export)\s+["'][^"']+["']))/g;
const nativeMatchAll = String.prototype.matchAll;

function previousImports(content: string): string[] {
  const fromImports = [...content.matchAll(importPattern)].map((match) => match[1]);
  const requires = [...content.matchAll(requirePattern)].map((match) => match[1]);
  return [...new Set([...fromImports, ...requires].filter((value): value is string => Boolean(value)))].slice(0, 16);
}

async function inspect(content: string): Promise<{ imports: string[]; importSubjects: string[]; requireSubjects: string[]; terminalSubjects: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-import-terminal-"));
  const importSubjects: string[] = [];
  const requireSubjects: string[] = [];
  const terminalSubjects: string[] = [];
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "entry.ts"), content);
    String.prototype.matchAll = function (this: string, regexp: RegExp) {
      if (regexp.source === importPattern.source) importSubjects.push(String(this));
      if (regexp.source === requirePattern.source) requireSubjects.push(String(this));
      if (regexp.source === terminalPattern.source) terminalSubjects.push(String(this));
      return nativeMatchAll.call(this, regexp);
    };
    const context = new WorkspaceContext(root, [".git"], 4096, undefined);
    const result = await context.prepareTurn("src/entry.ts");
    return { imports: result.repoMapCandidates.find((entry) => entry.path === "src/entry.ts")?.imports ?? [], importSubjects, requireSubjects, terminalSubjects };
  } finally {
    String.prototype.matchAll = nativeMatchAll;
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [
  "",
  "export const answer = 42;",
  'import { one } from "a";\nimport { again } from "a";\nrequire("b");\nrequire("a");',
  'require("before");\nimport { one } from "after";\nrequire("last");',
  'import {\n one, two\n} from "multi";\nexport { one } from "reexport";\nimport "side-effect";',
  '// import item from "comment"\nconst text = `export item from "string"`;\nrequire("required");',
  'import item from "mixed\';\r\nexport { item } from \'later";\nrequire("required\');',
  'import "bare";\nrequire("required");\nexport const unrelated = "value";',
  'from "import "nested-direct";\nrequire("late");',
  'from "export "nested-export";\nrequire("late");',
  'import outer from "from "nested-from";\nrequire("late");',
  'import "one"; from "export "two"; from "import "three";',
  'import item from "good";\nimport { broken } from "unterminated\nrequire("late");',
  'import\u00a0item\u2028from\u2003"unicode";\nexport\t"tabbed";\nrequire("last");',
  `${Array.from({ length: 20 }, (_, index) => `require("r${index}");`).join("\n")}\nimport one from "first";`,
  `${Array.from({ length: 20 }, () => 'import item from "duplicate";').join("\n")}\n${Array.from({ length: 20 }, (_, index) => `import item from "i${index}";`).join("\n")}`,
];
for (const content of cases) {
  assert.deepEqual((await inspect(content)).imports, previousImports(content), "Public repo-map imports preserve the complete previous heuristic output.");
}

const terminal = 'import value from "first"';
const trailingRequires = '\nrequire("late-only");';
const longTail = `${terminal};\n${'export const unrelated = 1;\n'.repeat(512)}${trailingRequires}`;
const bounded = await inspect(longTail);
assert.deepEqual(bounded.imports, previousImports(longTail));
assert.deepEqual(bounded.importSubjects, [terminal], "The unchanged import/export regex must not search a suffix without a possible quoted terminal.");
assert.deepEqual(bounded.requireSubjects, [longTail], "Late require calls must retain the complete original head.");

const noTerminal = `${'export function unrelated() {}\n'.repeat(512)}\nrequire("still-visible");`;
const emptyPrefix = await inspect(noTerminal);
assert.deepEqual(emptyPrefix.imports, previousImports(noTerminal));
assert.deepEqual(emptyPrefix.importSubjects, [""]);
assert.deepEqual(emptyPrefix.requireSubjects, [noTerminal]);
const noQuotes = 'export const value = 0;\n'.repeat(128);
const unquoted = await inspect(noQuotes);
assert.deepEqual(unquoted.imports, previousImports(noQuotes));
assert.deepEqual(unquoted.terminalSubjects, [], "No quoted terminal can exist without a quote character.");
assert.deepEqual(unquoted.importSubjects, [""]);
assert.deepEqual(unquoted.requireSubjects, [noQuotes]);

const quotedNoTerminal = 'const label = "ordinary value";\n'.repeat(128);
const quoted = await inspect(quotedNoTerminal);
assert.deepEqual(quoted.imports, previousImports(quotedNoTerminal));
assert.deepEqual(quoted.terminalSubjects, [], "An import/export match cannot exist without either literal keyword.");
assert.deepEqual(quoted.importSubjects, [""]);
assert.deepEqual(quoted.requireSubjects, [quotedNoTerminal]);
const quotedKeywordNoTerminal = 'const label = "import no terminal";\n'.repeat(128);
const keyword = await inspect(quotedKeywordNoTerminal);
assert.deepEqual(keyword.imports, previousImports(quotedKeywordNoTerminal));
assert.deepEqual(keyword.terminalSubjects, [quotedKeywordNoTerminal], "The gate is a necessary literal check, not a grammar replacement.");
assert.deepEqual(keyword.importSubjects, [""]);
assert.deepEqual(keyword.requireSubjects, [quotedKeywordNoTerminal]);

const standaloneFrom = 'from "standalone";\nrequire("late");';
const standalone = await inspect(standaloneFrom);
assert.deepEqual(standalone.imports, previousImports(standaloneFrom));
assert.deepEqual(standalone.terminalSubjects, []);
assert.deepEqual(standalone.importSubjects, [""]);
assert.deepEqual(standalone.requireSubjects, [standaloneFrom]);
console.log("workspace import terminal-bound tests passed (22 public-output fixtures and bounded subjects)");
