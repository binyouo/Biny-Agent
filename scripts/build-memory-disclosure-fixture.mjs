import { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const root = process.cwd();
const output = path.join(root, ".memory-disclosure-build");
const baseline = process.env.BINY_DISCLOSURE_BASE_REF;
if (baseline && !/^[a-f0-9]{40}$/u.test(baseline)) throw new Error("Baseline must be a full commit SHA");
const sources = [
  "src/desktop/renderer/src/components/settings/SettingsMemory.tsx",
  "src/desktop/renderer/src/styles/desktop-v2.css"
];
await rm(output, { recursive: true, force: true });
for (const phase of baseline ? ["before", "after"] : ["after"]) {
  const previous = new Map(phase === "before" ? sources.map(file => [path.join(root, file),
    execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" })]) : []);
  if (phase === "before") {
    // CSS @imports are read by PostCSS, outside Vite's module load hooks.
    const baselineCss = path.join(root, ".memory-disclosure-build/baseline-input/desktop-v2.css");
    await mkdir(path.dirname(baselineCss), { recursive: true });
    await writeFile(baselineCss, previous.get(path.join(root, sources[1])));
    const layers = path.join(root, "src/desktop/renderer/src/styles/layers.css");
    previous.set(layers, (await readFile(layers, "utf8")).replace('"./desktop-v2.css"', JSON.stringify(baselineCss)));
  }
  await build({
    root: path.join(root, "tests/fixtures/memory-disclosure"), configFile: false, base: "./",
    plugins: [{ name: "memory-disclosure-baseline", enforce: "pre", load: id => previous.get(id.split("?")[0]) }, react()],
    build: { outDir: path.join(root, ".memory-disclosure-build", phase), emptyOutDir: true }
  });
}
await writeFile(path.join(output, "source.json"), JSON.stringify({
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseline: baseline ?? null, baselineSources: baseline ? sources : []
}, null, 2));
