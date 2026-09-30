/** Parse every new native/Agent TS module using Node's actual strip-only parser; do not execute them. */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
const modules = [
  ...(await readdir(new URL("../src/computer/", import.meta.url))).filter(name => name.endsWith(".ts")).map(name => `src/computer/${name}`),
  "src/tools/computerUse.ts", "src/desktop/electron/main/computerUseService.ts", "src/desktop/electron/main/ComputerPreviewWindow.ts",
  "src/desktop/electron/main/cuaQaProfile.ts", "src/desktop/electron/preload/computerUse.ts",
  ...(await readdir(new URL("../tests/", import.meta.url))).filter(name => name.startsWith("computer-use-") && name.endsWith(".ts")).map(name => `tests/${name}`)
];
for (const module of modules) {
  const source = await readFile(new URL(`../${module}`, import.meta.url), "utf8");
  assert.equal(typeof stripTypeScriptTypes(source, { mode: "strip", sourceUrl: module }), "string", module);
}
console.log(JSON.stringify({ mode: "strip", parsed: modules.length, executed: 0 }));
