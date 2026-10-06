/**
 * Artifact-level QA, intentionally run by plain Node after build:cli/build:desktop.
 *
 * Default: pack the already-built application, install it with pnpm --ignore-scripts,
 * and execute the installed CLI artifact. No publication or native app launch.
 * Options: --artifact-root DIR, --tarball FILE, --desktop-root PROJECT_DIR,
 * --stock-packages DIR (reviewed upstream archives), --offline, --skip-install,
 * --skip-desktop (explicitly omit the generated Desktop artifact checks),
 * --skip-global (explicitly omit the isolated global install/bin smoke).
 * --derive-consumer-lock derives a stock, frozen consumer graph from the reviewed
 * source lockfile for offline stores that have package content but no metadata.
 * Optional environment: PNPM_BIN, BINY_PACKAGED_RUNTIME_STORE_DIR.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(argument("--artifact-root", sourceRoot));
const desktopRoot = process.argv.includes("--skip-desktop") ? undefined : argument("--desktop-root", root);
const stockPackages = argument("--stock-packages");
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-packaged-runtime-")));
const fixturePath = fileURLToPath(new URL("./code-mode-runtime-artifact-fixture.mjs", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const checks = [];
const childEnvironment = { ...process.env, BINY_AGENT_DIR: path.join(temporary, "agent"),
  HOME: path.join(temporary, "home"), XDG_CONFIG_HOME: path.join(temporary, "config"),
  XDG_CACHE_HOME: path.join(temporary, "cache"), XDG_DATA_HOME: path.join(temporary, "data"),
  XDG_STATE_HOME: path.join(temporary, "state") };
delete childEnvironment.NODE_OPTIONS;
delete childEnvironment.BINY_RUNTIME_HOST_ENTRY;

try {
  await check("compiled CLI integrity, embedded WASM, licenses and provenance", () => validateCli(root));
  await check("plain Node compiled CLI behavioral fixtures", () => runFixture(root));
  await check("compiled runtime refuses either missing timing capability", () => runtimeFailClosed(root));
  await check("build rejects stock, missing, drifted or widened runtime inputs", () => buildFailClosed());

  if (desktopRoot) {
    await check("generated Desktop normal/reentry graph uses the tested runtime chunk", () => desktopArtifact(path.resolve(desktopRoot)));
  }

  if (!process.argv.includes("--skip-install")) {
    await check("scripts-disabled packed pnpm consumer uses its bundled runtime with stock SDK/run", async () => {
      const consumer = path.join(temporary, "consumer");
      await mkdir(consumer, { recursive: true });
      const packed = argument("--tarball") ? path.resolve(argument("--tarball")) : await packArtifact();
      const derived = process.argv.includes("--derive-consumer-lock") ? await deriveConsumerLock(consumer, packed) : undefined;
      const versions = { "@ai-sdk/code-mode": "1.0.50", run: "2.1.6", ai: "7.0.93" };
      const dependencies = { "@biny012/biny": `file:${packed}`, ...(!derived ? versions : {}) };
      const overrides = derived ? { ...derived.overrides } : { ...versions };
      if (stockPackages) {
        const identity = JSON.parse(await readFile(path.join(root, "dist/code-mode-runtime-provenance/identity.json"), "utf8"));
        for (const name of ["@ai-sdk/code-mode", "run", "ai"]) {
          const identityPackage = identity.packages[name];
          const archive = path.resolve(stockPackages, identityPackage.filename);
          const bytes = await readFile(archive);
          assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, identityPackage.integrity,
            `${name} stock archive must match the reviewed published package`);
          if (!derived) {
            dependencies[name] = `file:${archive}`;
            overrides[name] = `file:${archive}`;
          }
        }
      }
      await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ name: "biny-artifact-qa-consumer", private: true,
        type: "module", dependencies, pnpm: { overrides } }, null, 2)}\n`);
      // pnpm 10 reads package.json; newer pnpm versions read this same root policy.
      await writeFile(path.join(consumer, "pnpm-workspace.yaml"), `packages:\n  - .\noverrides:\n${Object.entries(overrides)
        .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join("\n")}\n`);
      if (derived) await writeFile(path.join(consumer, "pnpm-lock.yaml"), derived.contents);
      const pnpm = process.env.PNPM_BIN || "pnpm";
      const version = await command(pnpm, ["--version"], { cwd: consumer });
      const arguments_ = ["install", "--ignore-scripts", "--prod", derived ? "--frozen-lockfile" : "--no-frozen-lockfile"];
      if (process.argv.includes("--offline")) arguments_.push("--offline");
      if (process.env.BINY_PACKAGED_RUNTIME_STORE_DIR) arguments_.push("--store-dir", process.env.BINY_PACKAGED_RUNTIME_STORE_DIR);
      await command(pnpm, arguments_, { cwd: consumer, timeoutMs: 300_000 });
      const packageRoot = await realPackageRoot(consumer, "@biny012/biny");
      const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      assert.equal(installed.dependencies.ai, "7.0.93", "Packed consumer must retain the exact reviewed ai pin");
      await validateCli(packageRoot);
      const external = await stockExternalRuntime(packageRoot);
      await runFixture(packageRoot);
      await command(process.execPath, [path.join(packageRoot, "dist/cli/index.js"), "--help"], { cwd: consumer });

      // No source rewrite or fallback: the exact installed artifact runs when SDK/run
      // cannot be resolved at all, while its unrelated dependencies remain installed.
      for (const [entry, name] of [[external.sdkPath, "@ai-sdk/code-mode"], [external.runPath, "run"]]) {
        const externalRoot = await packageRootFromEntry(entry, name);
        const relative = path.relative(consumer, externalRoot);
        assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
          "Only isolated consumer package trees may be removed for the stock-absent probe");
        await rm(externalRoot, { recursive: true });
      }
      await command(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        const require = createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))});
        assert.throws(() => require.resolve('@ai-sdk/code-mode')); assert.throws(() => require.resolve('run'));`], { cwd: consumer });
      await runFixture(packageRoot, ["--deny-external-runtime"]);
      checks.push({ name: "packed consumer installer evidence", pnpmVersion: version.stdout.trim(),
        scriptsDisabled: arguments_.includes("--ignore-scripts"), stockSeededFromReviewedArchives: Boolean(stockPackages) && !derived,
        reviewedStockArchivesVerified: Boolean(stockPackages), lockedGraphDerivation: derived?.description,
        stockPresentAndAbsentBothExecuted: true, external });

      if (!process.argv.includes("--skip-global")) {
        const globalDirectory = path.join(temporary, "global-install");
        const globalBinDirectory = path.join(temporary, "global-bin");
        await mkdir(globalBinDirectory, { recursive: true });
        const globalFlags = ["--global", "--global-dir", globalDirectory];
        const globalEnvironment = { PATH: `${globalBinDirectory}${path.delimiter}${childEnvironment.PATH}`, PNPM_HOME: globalBinDirectory,
          npm_config_global_dir: globalDirectory, npm_config_global_bin_dir: globalBinDirectory };
        const rootResult = await command(pnpm, ["root", "--global"], { cwd: consumer, env: globalEnvironment });
        const globalRoot = path.dirname(rootResult.stdout.trim().split("\n").at(-1));
        assert.ok(globalRoot.startsWith(`${globalDirectory}${path.sep}`), "Global pnpm installation must remain in its private prefix");
        await mkdir(globalRoot, { recursive: true });
        await writeFile(path.join(globalRoot, "package.json"), `${JSON.stringify({ private: true, type: "module",
          ...(derived ? { dependencies } : {}), pnpm: { overrides } }, null, 2)}\n`);
        await cp(path.join(consumer, "pnpm-workspace.yaml"), path.join(globalRoot, "pnpm-workspace.yaml"));
        const globalDerived = derived ? await deriveConsumerLock(globalRoot, packed) : undefined;
        if (globalDerived) await writeFile(path.join(globalRoot, "pnpm-lock.yaml"), globalDerived.contents);
        const globalArguments = derived
          ? ["install", ...globalFlags, "--ignore-scripts", "--prod", "--frozen-lockfile"]
          : ["add", ...globalFlags, "--ignore-scripts", `--config.global-bin-dir=${globalBinDirectory}`, `file:${packed}`];
        if (process.argv.includes("--offline")) globalArguments.push("--offline");
        if (process.env.BINY_PACKAGED_RUNTIME_STORE_DIR) globalArguments.push("--store-dir", process.env.BINY_PACKAGED_RUNTIME_STORE_DIR);
        await command(pnpm, globalArguments, { cwd: consumer, timeoutMs: 300_000,
          env: globalEnvironment });
        const globalPackageRoot = await realPackageRoot(globalRoot, "@biny012/biny");
        await validateCli(globalPackageRoot);
        await stockExternalRuntime(globalPackageRoot);
        await runFixture(globalPackageRoot, ["--deny-external-runtime"]);
        // Frozen global install creates its executable shim inside the actual
        // global prefix; add -g additionally publishes the PNPM_HOME alias. Test
        // the real manager-created shim, never manufacture or manually link one.
        const globalShimRoot = derived ? path.join(globalRoot, "node_modules/.bin") : globalBinDirectory;
        await command(path.join(globalShimRoot, process.platform === "win32" ? "biny.cmd" : "biny"), ["--help"], { cwd: consumer });
        checks.push({ name: "literal isolated global pnpm install and bin", installer: "pnpm", scriptsDisabled: true,
          installerAction: derived ? "pnpm install --global --frozen-lockfile" : "pnpm add --global",
          autoInstallPeers: derived ? true : "normal default", frozenLockfile: Boolean(derived), offline: process.argv.includes("--offline"),
          configFlags: derived ? ["--frozen-lockfile"] : [],
          binLocation: derived ? "actual global prefix node_modules/.bin/biny" : "configured global-bin-dir/biny",
          binInvoked: "biny --help", plainNodeArtifactFixtures: "passed", stockExternalRuntime: "present and unable to shadow bundled patch",
          lockedGraphDerivation: globalDerived?.description,
          automaticPeerInstallation: "normal default",
          userGlobalPrefix: "untouched" });
      }
    });
  }

  console.log(JSON.stringify({ status: "passed", compiledArtifact: true,
    packedConsumer: process.argv.includes("--skip-install") ? "explicitly skipped" : "passed",
    globalInstall: process.argv.includes("--skip-install") || process.argv.includes("--skip-global") ? "explicitly skipped" : "passed (isolated pnpm prefix)",
    desktop: desktopRoot ? "generated Linux-compatible runtime chunk passed; no full Electron/macOS app launch" : "not requested",
    checks }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} requires a value`);
  return process.argv[index + 1];
}

async function check(name, operation) {
  const started = performance.now();
  await operation();
  checks.push({ name, elapsedMs: Math.round(performance.now() - started) });
}

async function runFixture(artifactRoot, extra = []) {
  const result = await command(process.execPath, [fixturePath, "--artifact-root", artifactRoot, ...extra], { cwd: artifactRoot });
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.status, "passed");
  return report;
}

async function validateCli(artifactRoot) {
  const provenanceRoot = path.join(artifactRoot, "dist/code-mode-runtime-provenance");
  const provenance = JSON.parse(await readFile(path.join(provenanceRoot, "provenance.json"), "utf8"));
  for (const localPath of [sourceRoot, temporary]) assert.ok(!JSON.stringify(provenance).includes(localPath), "Provenance must not leak actual local build/test roots");
  assert.equal(provenance.artifact, "cli-node-host");
  assert.equal(provenance.contractVersion, 1);
  assert.equal(provenance.packages.ai.version, "7.0.93");
  assert.equal(provenance.packages["@ai-sdk/code-mode"].version, "1.0.50");
  assert.equal(provenance.packages.run.version, "2.1.6");
  assert.equal(provenance.bundler.version, "0.28.1");
  assert.match(provenance.upstream.commit, /^[a-f0-9]{40}$/u);
  for (const [relative, hash] of Object.entries(provenance.outputs)) {
    assert.equal(sha256(await readFile(path.join(artifactRoot, relative))), hash, `Compiled output checksum: ${relative}`);
  }
  assert.ok(provenance.outputs["dist/agent/codeMode.js"], "Provenance must attest the executed adapter");
  for (const [relative, hash] of Object.entries(provenance.sourceSha256)) {
    assert.equal(sha256(await readFile(path.join(provenanceRoot, relative))), hash, `Source provenance checksum: ${relative}`);
  }
  const code = await readFile(path.join(artifactRoot, "dist/agent/codeMode.js"), "utf8");
  for (const localPath of [sourceRoot, temporary]) assert.ok(!code.includes(localPath), "Compiled runtime must not leak actual local build/test roots");
  validateBundledRuntime(code, provenance.embeddedWasmSha256);
  const sourceProvenance = JSON.parse(await readFile(path.join(provenanceRoot, "source-provenance.json"), "utf8"));
  assert.equal(sourceProvenance.packages.ai.locallyModified, false);
  assert.equal(sourceProvenance.packages.run.locallyModified, true);
  assert.equal(sourceProvenance.packages["@ai-sdk/code-mode"].locallyModified, true);
  const notice = await readFile(path.join(artifactRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.equal(sha256(notice), sourceProvenance.thirdPartyNotice.sha256, "Packaged third-party notice must match the reviewed legal input");
  for (const [sourcePath, expected] of Object.entries(sourceProvenance.legalInputs)) {
    assert.ok(sourcePath.startsWith("patches/runtime-timing/licenses/"), "Legal paths must stay within the packaged licenses directory");
    const relative = sourcePath.slice("patches/runtime-timing/".length);
    assert.equal(sha256(await readFile(path.join(provenanceRoot, relative))), expected.sha256, `Packaged license checksum: ${relative}`);
  }
  for (const text of ["run 2.1.6", "@ai-sdk/code-mode 1.0.50", "ai 7.0.93", "Vercel", "devalue", "quickjs-wasi", "QuickJS", "modified"]) {
    assert.ok(notice.toLowerCase().includes(text.toLowerCase()), `Packaged notice must include ${text}`);
  }
  assert.match(await readFile(path.join(provenanceRoot, "MODIFICATIONS.txt"), "utf8"), /execution|budget/iu);
  assert.match(await readFile(path.join(provenanceRoot, "licenses/APACHE-2.0.txt"), "utf8"), /Apache License[\s\S]*Version 2\.0/u);
  assert.match(await readFile(path.join(provenanceRoot, "licenses/DEVALUE-MIT.txt"), "utf8"), /Permission is hereby granted/u);
  const embeddedNotices = await readFile(path.join(provenanceRoot, "licenses/RUN-THIRD-PARTY-NOTICES.txt"), "utf8");
  for (const text of ["QuickJS", "quickjs-wasi", "devalue", "Permission is hereby granted"]) assert.ok(embeddedNotices.includes(text));
  for (const name of ["run-2.1.6-source.diff", "code-mode-1.0.50-source.diff"]) {
    assert.match(await readFile(path.join(provenanceRoot, name), "utf8"), /^diff --git /mu);
  }
}

function validateBundledRuntime(code, wasmHash) {
  assert.match(code, /Biny modified Code Mode execution-time protection/u);
  assert.match(code, /executionTimeoutBudgetVersion/u);
  const wasm = /__RUN_QUICKJS_WASM_BASE64__\s*=\s*\\?"([A-Za-z0-9+/=]+)\\?"/u.exec(code);
  assert.ok(wasm, "Actual compiled artifact must contain the embedded QuickJS WASM");
  assert.equal(sha256(Buffer.from(wasm[1], "base64")), wasmHash);
  assert.doesNotMatch(code, /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["'](?:@ai-sdk\/code-mode|run)(?:\/[^"']*)?["']/u,
    "Compiled artifact must not import stock external SDK/run");
}

async function runtimeFailClosed(artifactRoot) {
  const original = await readFile(path.join(artifactRoot, "dist/agent/codeMode.js"), "utf8");
  const directory = path.join(temporary, "runtime-capabilities");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await symlink(path.join(artifactRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
  for (const functionName of ["createRunner", "runCodeMode"]) {
    const marker = new RegExp(`(Object\\.defineProperty\\(${functionName},\\s*"executionTimeoutBudgetVersion",\\s*\\{\\s*value:\\s*)1`, "u");
    assert.match(original, marker, `Expected compiled ${functionName} timing capability marker`);
    const altered = original.replace(marker, "$10");
    assert.notEqual(altered, original);
    const target = path.join(directory, `${functionName}.js`);
    await writeFile(target, altered);
    await runFixture(artifactRoot, ["--module", target, "--expect-fail-closed", "--deny-external-runtime"]);
  }
}

async function buildFailClosed() {
  const buildScript = path.join(sourceRoot, "scripts/build-code-mode-runtime.mjs");
  const fixtureRoot = path.join(temporary, "build-inputs");
  await mkdir(path.join(fixtureRoot, "node_modules/@ai-sdk"), { recursive: true });
  const packageBytes = await readFile(path.join(sourceRoot, "package.json"));
  await writeFile(path.join(fixtureRoot, "package.json"), packageBytes);
  await cp(path.join(sourceRoot, "patches"), path.join(fixtureRoot, "patches"), { recursive: true });
  for (const file of ["THIRD_PARTY_NOTICES.txt", "pnpm-lock.yaml", "src/agent/codeMode.ts", "scripts/build-code-mode-runtime.mjs", "electron.vite.config.ts"]) {
    await mkdir(path.dirname(path.join(fixtureRoot, file)), { recursive: true });
    await cp(path.join(sourceRoot, file), path.join(fixtureRoot, file));
  }
  const sdkRoot = await realPackageRoot(sourceRoot, "@ai-sdk/code-mode");
  const requireSdk = createRequire(path.join(sdkRoot, "package.json"));
  const runRoot = await packageRootFromEntry(requireSdk.resolve("run"), "run");
  const sdkFixture = path.join(fixtureRoot, "node_modules/@ai-sdk/code-mode");
  const runFixture = path.join(fixtureRoot, "node_modules/run");
  await cp(sdkRoot, sdkFixture, { recursive: true });
  await cp(runRoot, runFixture, { recursive: true });
  await symlink(await realPackageRoot(sourceRoot, "ai"), path.join(fixtureRoot, "node_modules/ai"), "dir");
  const verify = async failure => {
    const result = await command(process.execPath, ["--input-type=module", "--eval",
      `const { verifyCodeModeRuntimeInputs } = await import(${JSON.stringify(pathToFileURL(buildScript).href)}); await verifyCodeModeRuntimeInputs(${JSON.stringify(fixtureRoot)});`],
    { allowFailure: true });
    if (failure) {
      assert.notEqual(result.code, 0, "Invalid runtime inputs must fail before bundling");
      assert.match(result.stderr + result.stdout, failure);
    } else assert.equal(result.code, 0, result.stderr);
  };
  await verify();
  const manifest = JSON.parse(packageBytes);
  manifest.dependencies.ai = "^7.0.93";
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify(manifest));
  await verify(/pin the reviewed ai version/u);
  await writeFile(path.join(fixtureRoot, "package.json"), packageBytes);
  manifest.dependencies.ai = "7.0.93";
  manifest.devDependencies.esbuild = "^0.28.1";
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify(manifest));
  await verify(/pin its bundler/u);
  await writeFile(path.join(fixtureRoot, "package.json"), packageBytes);
  manifest.devDependencies.esbuild = "0.28.1";
  manifest.packageManager = "pnpm@11.19.0";
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify(manifest));
  await verify(/pinned pnpm 10\.6\.5 toolchain/u);
  await writeFile(path.join(fixtureRoot, "package.json"), packageBytes);
  for (const [packageDirectory, packageName] of [[sdkFixture, "@ai-sdk/code-mode"], [runFixture, "run"]]) {
    const packagePath = path.join(packageDirectory, "package.json");
    const original = await readFile(packagePath);
    const packageManifest = JSON.parse(original);
    packageManifest.version = "0.0.0";
    await writeFile(packagePath, JSON.stringify(packageManifest));
    await verify(new RegExp(`Unexpected ${packageName}`, "u"));
    await writeFile(packagePath, original);
    const entry = path.join(packageDirectory, "dist/index.js");
    const entryBytes = await readFile(entry);
    await writeFile(entry, Buffer.concat([entryBytes, Buffer.from("\n// artifact QA drift fixture\n")]));
    await verify(/not the reviewed patched distribution/u);
    await writeFile(entry, entryBytes);
  }
  const worker = path.join(runFixture, "dist/runtime/worker-source.js");
  const workerBytes = await readFile(worker);
  await rm(worker);
  await verify(/not the reviewed patched distribution/u);
  await writeFile(worker, workerBytes);
  if (stockPackages) {
    for (const [directory, filename] of [[sdkFixture, "ai-sdk-code-mode-1.0.50.tgz"], [runFixture, "run-2.1.6.tgz"]]) {
      const backup = path.join(temporary, `${path.basename(directory)}-dist-backup`);
      await cp(path.join(directory, "dist"), backup, { recursive: true });
      await rm(path.join(directory, "dist"), { recursive: true });
      await command("tar", ["-xzf", path.resolve(stockPackages, filename), "--strip-components=1", "-C", directory, "package/dist"]);
      await verify(/not the reviewed patched distribution/u);
      await rm(path.join(directory, "dist"), { recursive: true });
      await cp(backup, path.join(directory, "dist"), { recursive: true });
    }
  }
  await verify();
}

async function desktopArtifact(projectRoot) {
  const mainRoot = path.join(projectRoot, "out/main");
  const provenance = JSON.parse(await readFile(path.join(mainRoot, "code-mode-runtime-provenance.json"), "utf8"));
  for (const localPath of [sourceRoot, temporary]) assert.ok(!JSON.stringify(provenance).includes(localPath), "Desktop provenance must not leak actual local build/test roots");
  assert.equal(provenance.artifact, "electron-main");
  assert.equal(provenance.contractVersion, 1);
  for (const [relative, hash] of Object.entries(provenance.outputs)) {
    assert.equal(sha256(await readFile(path.join(mainRoot, relative))), hash, `Desktop output checksum: ${relative}`);
  }
  const main = await readFile(path.join(mainRoot, "index.js"), "utf8");
  const runtimeImport = /from\s*["'](\.\/chunks\/code-mode-runtime-[^"']+\.js)["']/u.exec(main);
  assert.ok(runtimeImport, "Actual Desktop main must import its dedicated bundled runtime");
  const hostImport = /import\(["'](\.\/chunks\/hostProcess-[^"']+\.js)["']\)/u.exec(main);
  assert.ok(hostImport, "Normal --biny-runtime-host reentry must resolve a real generated host chunk");
  assert.match(main, /process\.argv\.indexOf\(["']--biny-runtime-host["']\)/u);
  const host = await readFile(path.resolve(mainRoot, hostImport[1]), "utf8");
  assert.match(host, /from\s*["']\.\.\/index\.js["']/u, "Reentry host must use the same generated main graph");
  const runtimePath = path.resolve(mainRoot, runtimeImport[1]);
  const runtime = await readFile(runtimePath, "utf8");
  for (const localPath of [sourceRoot, temporary]) assert.ok(!runtime.includes(localPath), "Generated Desktop runtime must not leak actual local build/test roots");
  validateBundledRuntime(runtime, provenance.embeddedWasmSha256);
  assert.ok(provenance.outputs[path.relative(mainRoot, runtimePath).split(path.sep).join("/")]);
  await runFixture(projectRoot, ["--module", runtimePath, "--adapter-only", "--deny-external-runtime"]);
  checks.push({ name: "Desktop execution scope", normalMain: "out/main/index.js", reentryHost: hostImport[1], runtimeChunk: runtimeImport[1],
    actuallyExecuted: "unmodified generated runtime chunk with plain Node", macOSApplicationLaunch: "not performed" });
}

async function stockExternalRuntime(packageRoot) {
  const script = `import assert from 'node:assert/strict'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';
    const require = createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))});
    const sdkPath = require.resolve('@ai-sdk/code-mode'); const sdk = await import(pathToFileURL(sdkPath));
    const sdkRequire = createRequire(sdkPath); const runPath = sdkRequire.resolve('run'); const runtime = await import(pathToFileURL(runPath));
    assert.equal(sdk.experimental_runCodeMode.executionTimeoutBudgetVersion, undefined);
    assert.equal(runtime.createRunner.executionTimeoutBudgetVersion, undefined);
    console.log(JSON.stringify({ sdkMarker: 'absent (stock)', runMarker: 'absent (stock)', sdkPath, runPath }));`;
  const result = await command(process.execPath, ["--input-type=module", "--eval", script], { cwd: packageRoot });
  const report = JSON.parse(result.stdout.trim());
  for (const [entry, name, expected] of [[report.sdkPath, "@ai-sdk/code-mode", "1.0.50"], [report.runPath, "run", "2.1.6"]]) {
    const externalRoot = await packageRootFromEntry(entry, name);
    const manifest = JSON.parse(await readFile(path.join(externalRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, expected, `External stock ${name} version`);
  }
  const aiRoot = await realPackageRoot(packageRoot, "ai");
  assert.equal(JSON.parse(await readFile(path.join(aiRoot, "package.json"), "utf8")).version, "7.0.93");
  return { ...report, versions: { sdk: "1.0.50", run: "2.1.6", ai: "7.0.93" } };
}

async function realPackageRoot(projectRoot, name) {
  return await packageRootFromEntry(createRequire(path.join(projectRoot, "package.json")).resolve(name), name);
}

async function deriveConsumerLock(installRoot, packed) {
  const { parse, stringify } = createRequire(path.join(sourceRoot, "package.json"))("yaml");
  const sourceBytes = await readFile(path.join(sourceRoot, "pnpm-lock.yaml"));
  // Keep exact registry integrities and versions. Removing only patch identities
  // deliberately makes the package manager install original SDK/run archives.
  const lock = parse(sourceBytes.toString().replace(/\(patch_hash=[a-f0-9]+\)/gu, ""));
  delete lock.patchedDependencies;
  const application = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const sourceImporter = lock.importers["."];
  const dependencies = Object.fromEntries(Object.entries(sourceImporter.dependencies).map(([name, entry]) => [name, entry.version]));
  const optionalDependencies = Object.fromEntries(Object.entries(sourceImporter.optionalDependencies ?? {}).map(([name, entry]) => [name, entry.version]));
  const relative = `file:${path.relative(installRoot, packed).split(path.sep).join("/")}`;
  const key = `${application.name}@${relative}`;
  const archive = await readFile(packed);
  lock.packages[key] = { resolution: { integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, tarball: relative },
    version: application.version, hasBin: true };
  lock.snapshots[key] = { dependencies, optionalDependencies };
  lock.importers = { ".": { dependencies: { [application.name]: { specifier: `file:${packed}`, version: relative } } } };
  return { contents: stringify(lock), overrides: lock.overrides ?? {},
    description: `Reviewed source lock SHA256 ${sha256(sourceBytes)}; exact production dependency snapshot, source patch identities removed, local packed app added; real pnpm frozen install` };
}

async function packageRootFromEntry(entry, name) {
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(directory);
    assert.notEqual(directory, parent, `Package manifest not found: ${name}`);
    directory = parent;
  }
}

async function packArtifact() {
  await command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: root });
  const tarballs = (await readdir(temporary)).filter(name => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "Pack must produce exactly one local artifact");
  return path.join(temporary, tarballs[0]);
}

async function command(executable, arguments_, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: options.cwd ?? sourceRoot, env: { ...childEnvironment, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Timed out: ${executable} ${arguments_.join(" ")}\n${stdout}\n${stderr}`)); }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 && !options.allowFailure) reject(new Error(`Command failed (${code}): ${executable} ${arguments_.join(" ")}\n${stdout}\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}
