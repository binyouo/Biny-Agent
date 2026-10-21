import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

function sourceFiles(directory) {
  if (!existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const filename = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(filename) : /\.[jt]sx?$/.test(filename) && !filename.endsWith(".d.ts") ? [filename] : [];
  });
}

async function check(name, entryPoints, violation) {
  if (!entryPoints.length) return;
  await build({
    absWorkingDir: root, entryPoints, bundle: true, write: false,
    outdir: ".project-boundary-check", platform: "node", format: "esm", packages: "external",
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".jpg": "empty", ".woff2": "empty" },
    logLevel: "silent",
    plugins: [{
      name: "project-boundaries",
      setup(builder) {
        builder.onLoad({ filter: /.*/ }, args => {
          if (args.suffix === "?raw") return { contents: readFileSync(args.path, "utf8"), loader: "text" };
        });
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === "entry-point") return;
          const target = args.path.startsWith(".") || path.isAbsolute(args.path)
            ? path.relative(root, path.resolve(args.resolveDir, args.path)).split(path.sep).join("/") : args.path;
          const reason = violation(target);
          if (reason) return { errors: [{ text: `${name}: ${reason}: ${target} (from ${path.relative(root, args.importer)})` }] };
        });
      }
    }]
  });
  console.log(`${name} boundary passed: ${entryPoints.length} source entries.`);
}

try {
  if (process.argv.length > 2) throw new Error("Usage: node scripts/check-boundaries.mjs");
  const renderer = sourceFiles("src/desktop/renderer");
  const core = ["agent", "runtime", "session", "tools", "permission", "llm"].flatMap(directory => sourceFiles(`src/${directory}`));
  const tui = sourceFiles("src/tui/components");
  if (![renderer, core, tui].some(entries => entries.length)) throw new Error("No boundary source entries found under src/.");
  await check("renderer", renderer, target =>
    builtins.has(target) || target.startsWith("node:") || /^electron(?:\/|$)/.test(target) ? "platform access is forbidden" : undefined);
  await check("core", core, target =>
    /^src\/(?:desktop|cli|tui)\//.test(target) ? "client runtime dependency is forbidden" : undefined);
  await check("tui", tui, target =>
    /^(?:node:)?(?:fs(?:\/.*)?|child_process|worker_threads|cluster|net|http|https|http2|tls|dgram|dns(?:\/.*)?)$/.test(target)
      || /^electron(?:\/|$)/.test(target)
      || /^src\/(?:tools\/|agent\/AgentSession\.|runtime\/(?:InteractiveAgentRuntime|CommandRuntime|RuntimeHost)\.|session\/(?:store|recorder|cleanup|searchIndex)\.)/.test(target)
      ? "execution or persistence access is forbidden" : undefined);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
