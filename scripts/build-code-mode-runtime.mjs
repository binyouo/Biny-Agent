import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const codeModeRuntimeBanner = "/*! Biny modified Code Mode execution-time protection (contract v1). Includes @ai-sdk/code-mode 1.0.50 and run 2.1.6, Copyright (c) Vercel, Inc., Apache-2.0; embedded MIT components. See THIRD_PARTY_NOTICES.txt and code-mode-runtime-provenance. */";

function packageFrom(requireFrom, name) {
  let directory = path.dirname(requireFrom.resolve(name));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const value = requireFrom(manifestPath);
      if (value.name === name) return { root: directory, value };
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Cannot find ${name} package`);
    directory = parent;
  }
}

async function distHashes(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const hashes = {};
  for (const entry of entries.filter(entry => entry.isFile()).sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    const file = path.join(entry.parentPath, entry.name);
    hashes[path.relative(root, file).split(path.sep).join("/")] = sha256(await readFile(file));
  }
  return hashes;
}

/** Reject an unpatched or drifted build input before it can produce an artifact. */
export async function verifyCodeModeRuntimeInputs(root = projectRoot) {
  const artifactRoot = path.join(root, "patches/runtime-timing");
  const identityBytes = await readFile(path.join(artifactRoot, "identity.json"));
  const identity = JSON.parse(identityBytes);
  const requireFrom = createRequire(path.join(root, "package.json"));
  const sdk = packageFrom(requireFrom, "@ai-sdk/code-mode");
  const run = packageFrom(createRequire(path.join(sdk.root, "package.json")), "run");
  const ai = packageFrom(requireFrom, "ai");
  const application = requireFrom(path.join(root, "package.json"));
  assert.equal(application.packageManager, "pnpm@10.6.5", "Source patch installation requires the pinned pnpm 10.6.5 toolchain");
  assert.equal(application.dependencies.ai, "7.0.93", "Distribution must pin the reviewed ai version");
  assert.equal(application.devDependencies.esbuild, "0.28.1", "Distribution must pin its bundler");
  assert.equal(esbuildVersion, "0.28.1", "Unexpected esbuild version");
  for (const [name, installed] of [["@ai-sdk/code-mode", sdk], ["run", run], ["ai", ai]]) {
    assert.equal(installed.value.version, identity.packages[name].version, `Unexpected ${name} version`);
  }
  for (const [name, installed] of [["@ai-sdk/code-mode", sdk], ["run", run]]) {
    assert.deepEqual(await distHashes(path.join(installed.root, "dist")), identity.patchedDistSha256[name],
      `${name} is not the reviewed patched distribution. Run corepack pnpm@10.6.5 install --frozen-lockfile before building.`);
  }
  const { experimental_runCodeMode } = await import(pathToFileURL(requireFrom.resolve("@ai-sdk/code-mode")).href);
  const runRequire = createRequire(path.join(sdk.root, "package.json"));
  const { createRunner } = await import(pathToFileURL(runRequire.resolve("run")).href);
  assert.equal(experimental_runCodeMode.executionTimeoutBudgetVersion, identity.contractVersion, "Missing SDK timing capability");
  assert.equal(createRunner.executionTimeoutBudgetVersion, identity.contractVersion, "Missing runtime timing capability");
  const { INLINE_RUN_WORKER_SOURCE } = await import(pathToFileURL(path.join(run.root, "dist/runtime/worker-source.js")).href);
  const wasm = /^globalThis\.__RUN_QUICKJS_WASM_BASE64__ = "([A-Za-z0-9+/=]+)";/u.exec(INLINE_RUN_WORKER_SOURCE);
  assert.ok(wasm, "Worker must contain its WASM asset");
  assert.equal(sha256(Buffer.from(wasm[1], "base64")), identity.embeddedWasmSha256, "Embedded WASM changed");
  const sourceFiles = ["identity.json", "run-2.1.6-source.diff", "code-mode-1.0.50-source.diff", "source-provenance.json", "MODIFICATIONS.txt"];
  const sourceSha256 = {};
  for (const file of sourceFiles) sourceSha256[file] = sha256(await readFile(path.join(artifactRoot, file)));
  const sourceProvenance = JSON.parse(await readFile(path.join(artifactRoot, "source-provenance.json"), "utf8"));
  assert.deepEqual(sourceProvenance.patchedDistSha256, identity.patchedDistSha256, "Source provenance differs from the reviewed package identity");
  const legalSha256 = {};
  for (const [file, expected] of Object.entries(sourceProvenance.legalInputs)) {
    const digest = sha256(await readFile(path.join(root, file)));
    assert.equal(digest, expected.sha256, `Legal input drift: ${file}`);
    legalSha256[file] = digest;
  }
  for (const expected of [...sourceProvenance.sourcePatches, sourceProvenance.modificationNotice, sourceProvenance.thirdPartyNotice]) {
    assert.equal(sha256(await readFile(path.join(root, expected.path))), expected.sha256, `Source/notice provenance drift: ${expected.path}`);
  }
  const patches = {};
  for (const [name, file] of Object.entries(application.pnpm.patchedDependencies)) {
    patches[name] = { path: file, sha256: sha256(await readFile(path.join(root, file))) };
  }
  const applicationInputSha256 = {};
  for (const file of ["package.json", "pnpm-lock.yaml", "src/agent/codeMode.ts", "scripts/build-code-mode-runtime.mjs", "electron.vite.config.ts"]) {
    applicationInputSha256[file] = sha256(await readFile(path.join(root, file)));
  }
  return {
    contractVersion: identity.contractVersion,
    upstream: identity.upstream,
    packages: identity.packages,
    bundler: { name: "esbuild", version: esbuildVersion },
    embeddedWasmSha256: identity.embeddedWasmSha256,
    patchedDistSha256: identity.patchedDistSha256,
    sourceSha256,
    legalSha256,
    patches,
    applicationInputSha256
  };
}

/** Used by both actual Electron main entries, including --biny-runtime-host. */
export function codeModeRuntimeProvenancePlugin(root = projectRoot) {
  let identity;
  return {
    name: "biny-code-mode-runtime-provenance",
    async buildStart() {
      identity = await verifyCodeModeRuntimeInputs(root);
      const requireFrom = createRequire(path.join(root, "package.json"));
      const vite = packageFrom(requireFrom, "vite");
      const viteRequire = createRequire(path.join(vite.root, "package.json"));
      identity.bundler = {
        name: "electron-vite",
        version: packageFrom(requireFrom, "electron-vite").value.version,
        vite: vite.value.version,
        rollup: packageFrom(viteRequire, "rollup").value.version,
        esbuild: packageFrom(viteRequire, "esbuild").value.version
      };
    },
    // Run after Vite's final transform, before Rollup computes chunk names.
    renderChunk: {
      order: "post",
      handler(code) {
        return code.startsWith(codeModeRuntimeBanner) ? null : `${codeModeRuntimeBanner}\n${code}`;
      }
    },
    generateBundle(_options, bundle) {
      const outputs = {};
      for (const [name, entry] of Object.entries(bundle)) {
        if (entry.type !== "chunk") continue;
        assert.ok(!entry.imports.some(specifier => specifier === "run" || specifier.startsWith("run/") || specifier === "@ai-sdk/code-mode" || specifier.startsWith("@ai-sdk/code-mode/")), "Patched runtime must not be externalized");
        assert.ok(entry.code.startsWith(codeModeRuntimeBanner), "Modified-file license notice was stripped from the final chunk");
        outputs[name] = sha256(entry.code);
      }
      this.emitFile({ type: "asset", fileName: "code-mode-runtime-provenance.json", source: `${JSON.stringify({ ...identity, artifact: "electron-main", outputs }, null, 2)}\n` });
    }
  };
}

export async function buildCodeModeRuntime(root = projectRoot) {
  const identity = await verifyCodeModeRuntimeInputs(root);
  const outputFile = path.join(root, "dist/agent/codeMode.js");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/agent/codeMode.ts"],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    target: "node22.13",
    format: "esm",
    external: ["ai", "typescript"],
    banner: { js: codeModeRuntimeBanner },
    legalComments: "inline",
    metafile: true,
    sourcemap: false,
    minify: false,
    write: true
  });
  for (const output of Object.values(result.metafile.outputs)) {
    assert.ok(!output.imports.some(entry => entry.external && (entry.path === "run" || entry.path.startsWith("run/") || entry.path === "@ai-sdk/code-mode" || entry.path.startsWith("@ai-sdk/code-mode/"))), "Patched runtime escaped the bundle");
  }
  const provenanceRoot = path.join(root, "dist/code-mode-runtime-provenance");
  await mkdir(provenanceRoot, { recursive: true });
  for (const file of Object.keys(identity.sourceSha256)) await cp(path.join(root, "patches/runtime-timing", file), path.join(provenanceRoot, file));
  await cp(path.join(root, "patches/runtime-timing/licenses"), path.join(provenanceRoot, "licenses"), { recursive: true });
  const provenance = { ...identity, artifact: "cli-node-host", outputs: { "dist/agent/codeMode.js": sha256(await readFile(outputFile)) } };
  await writeFile(path.join(provenanceRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--verify-only")) {
    await verifyCodeModeRuntimeInputs();
    console.log("Reviewed Code Mode runtime inputs verified.");
  } else {
    await buildCodeModeRuntime();
    console.log("Self-contained Code Mode runtime bundle built.");
  }
}
