import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const generatedIcons = ["build/icon-master.png", "build/icon-blink.png", "build/icon.icns", "build/icon.ico",
  "src/desktop/renderer/public/favicon.png", "src/desktop/renderer/src/assets/app-icon.png", "src/desktop/renderer/src/assets/app-icon-blink.png"];

// Source/output bytes detect edits and deletions. Installed dependencies use file metadata
// so an unchanged build does not reread gigabytes of binaries. This cache stays local.
export function fingerprint(root, files, metadataOnly = false, excluded = []) {
  const hash = createHash("sha256");
  const visited = new Set();
  const visit = file => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (excluded.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) return;
    let stat;
    try { stat = lstatSync(file, { bigint: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update(`${relative}:missing\0`);
      return;
    }
    hash.update(`${relative}:${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(file));
      if (existsSync(file)) visit(realpathSync(file));
    } else if (stat.isDirectory()) {
      if (visited.has(file)) return;
      visited.add(file);
      for (const entry of readdirSync(file).sort()) visit(path.join(file, entry));
    } else if (stat.isFile()) {
      hash.update(metadataOnly ? `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : readFileSync(file));
    }
    hash.update("\0");
  };
  for (const file of files) visit(path.resolve(root, file));
  return hash.digest("hex");
}

export async function cachedBuild({ root, target, inputs, outputs, toolchain, build, force = false }) {
  const stamp = path.join(root, "node_modules/.cache/biny/build", `${target}.json`);
  const source = () => fingerprint(root, inputs, false, generatedIcons);
  const dependencies = () => fingerprint(root, ["node_modules"], true, ["node_modules/.cache"]);
  const before = source();
  const installed = dependencies();
  const key = createHash("sha256").update(JSON.stringify([before, installed, toolchain])).digest("hex");
  let previous;
  try { previous = JSON.parse(readFileSync(stamp, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (!force && previous?.key === key && outputs.every(file => existsSync(path.join(root, file)))
    && previous.output === fingerprint(root, outputs)) {
    console.log(`${target} build is up to date.`);
    return false;
  }
  rmSync(stamp, { force: true });
  await build();
  if (!outputs.every(file => existsSync(path.join(root, file)))) throw new Error(`${target} build omitted an output`);
  // An editor may change inputs while the compiler is running; never cache that result.
  if (source() === before && dependencies() === installed) {
    mkdirSync(path.dirname(stamp), { recursive: true });
    writeFileSync(stamp, JSON.stringify({ key, output: fingerprint(root, outputs) }));
  }
  return true;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd") });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

async function main() {
  const target = process.argv[2];
  if (!["cli", "desktop"].includes(target)) throw new Error("Use build-project.mjs cli|desktop [--force]");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const script = (name, ...args) => run(process.execPath, [`scripts/${name}`, ...args]);
  const inputs = ["src", "scripts", "config", "native", "build", "patches", "vendor", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "tsconfig.json", "THIRD_PARTY_NOTICES.txt", ...readdirSync(repository).filter(file => file.startsWith(".env"))];
  const outputs = ["dist"];
  if (process.platform === "darwin") outputs.push("out/native/calendar-reader");
  if (target === "desktop") outputs.push("out/main", "out/preload", "out/renderer", "out/rtk", ...generatedIcons);
  if (target === "desktop" && process.platform === "darwin") outputs.push("out/native");
  const toolchain = [process.version, process.platform, process.arch,
    Object.entries(process.env).filter(([key]) => /^(?:NODE_|VITE_|ELECTRON_|SDKROOT$|DEVELOPER_DIR$|MACOSX_DEPLOYMENT_TARGET$)/u.test(key)).sort(),
    process.platform === "darwin" ? execFileSync("xcrun", ["swiftc", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : ""];
  if (target === "desktop") script("prepare-electron-background.mjs");
  const build = () => {
    if (target === "desktop") {
      script("prepare-rtk.mjs");
      run(pnpm, ["build:icons"]);
      run(pnpm, process.argv.includes("--force") ? ["build:cli", "--force"] : ["build:cli"]);
      script("build-activity-sidecar.mjs");
      run(pnpm, ["exec", "electron-vite", "build", "--config", "config/electron.vite.config.ts"]);
      script("copy-bundled-skills.mjs", "out/main/bundled-skills");
      script("copy-browser-extension.mjs", "out/main/browser-extension");
    } else {
      script("clean-dist.mjs");
      run(pnpm, ["exec", "tsc", "-p", "tsconfig.json"]);
      script("build-code-mode-runtime.mjs");
      script("build-calendar-sidecar.mjs");
      script("copy-bundled-skills.mjs", "dist/bundled-skills");
      script("copy-browser-extension.mjs", "dist/browser-extension");
    }
  };
  // Hosted jobs start with a fresh checkout; scanning the cache inputs there adds no reuse.
  if (process.env.CI === "true") build();
  else await cachedBuild({ root: repository, target, inputs, outputs, toolchain, force: process.argv.includes("--force"), build });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
