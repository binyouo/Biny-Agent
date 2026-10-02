import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Rebuild from reviewed TypeScript. The generated/minified inline worker is never edited.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = join(projectRoot, 'patches/runtime-timing');
const identityPath = join(artifactRoot, 'identity.json');
const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
const write = process.argv.includes('--write');
assert.ok(write || process.argv.includes('--check'), 'Specify --check or --write');
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : resolve(process.argv[index + 1]);
}
const work = mkdtempSync(join(argument('--work-root') ?? tmpdir(), 'biny-runtime-timing-'));
const env = {
  ...process.env,
  HOME: process.env.HOME ?? join(work, 'home'),
  PNPM_HOME: join(work, 'pnpm-home'),
  XDG_DATA_HOME: join(work, 'xdg-data'),
  XDG_CACHE_HOME: join(work, 'xdg-cache'),
  XDG_STATE_HOME: join(work, 'xdg-state'),
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function command(binary, args, cwd, accepted = [0]) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!accepted.includes(result.status)) {
    throw new Error(`${binary} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function files(root) {
  return readdirSync(root, { recursive: true }).filter(file => statSync(join(root, file)).isFile()).sort();
}
function hashes(root) {
  return Object.fromEntries(files(root).map(file => [file, sha256(readFileSync(join(root, file)))]));
}
function assertSameTree(actual, expected, label) {
  assert.deepEqual(hashes(actual), hashes(expected), `${label} differs from its exact-version baseline`);
}
function manifest(requireFrom, name) {
  let directory = dirname(requireFrom.resolve(name));
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed.name === name) return { path: candidate, value: parsed };
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate ${name} manifest`);
    directory = parent;
  }
}

function packagePatch(before, after) {
  const pair = mkdtempSync(join(work, 'diff-'));
  cpSync(before, join(pair, 'before'), { recursive: true });
  cpSync(after, join(pair, 'after'), { recursive: true });
  return command('git', ['-c', 'core.quotePath=true', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-algorithm=myers', '--unified=3', '--abbrev=7', '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after'], pair, [0, 1])
    .replaceAll('a/before/', 'a/').replaceAll('a/after/', 'a/')
    .replaceAll('b/before/', 'b/').replaceAll('b/after/', 'b/');
}

async function assertEmbeddedWasm(packageRoot, expectedWorkerSha) {
  const workerPath = join(packageRoot, 'dist/runtime/worker-source.js');
  if (expectedWorkerSha !== undefined) assert.equal(sha256(readFileSync(workerPath)), expectedWorkerSha);
  const { INLINE_RUN_WORKER_SOURCE } = await import(pathToFileURL(workerPath).href + `?verify=${Math.random()}`);
  const match = /^globalThis\.__RUN_QUICKJS_WASM_BASE64__ = "([A-Za-z0-9+/=]+)";/u.exec(INLINE_RUN_WORKER_SOURCE);
  assert.ok(match, 'Inline worker must embed the stock WASM asset');
  assert.equal(sha256(Buffer.from(match[1], 'base64')), identity.embeddedWasmSha256, 'Embedded WASM changed');
}

try {
  const upstream = argument('--upstream') ?? join(work, 'upstream');
  if (!existsSync(upstream)) command('git', ['clone', '--depth', '1', '--branch', identity.upstream.tag, identity.upstream.url, upstream], work);
  assert.equal(command('git', ['rev-parse', 'HEAD'], upstream).trim(), identity.upstream.commit, 'Wrong upstream commit');
  assert.equal(command('git', ['config', '--get', 'remote.origin.url'], upstream).trim(), identity.upstream.url, 'Wrong upstream repository');
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: upstream, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(archive.status, 0, 'Could not archive exact upstream source');
  const archivePath = join(work, 'upstream.tar');
  writeFileSync(archivePath, archive.stdout);
  const source = join(work, 'source');
  mkdirSync(source);
  command('tar', ['-xf', archivePath, '-C', source], work);
  assert.equal(sha256(readFileSync(join(source, 'pnpm-lock.yaml'))), identity.upstream.lockfileSha256, 'Upstream lockfile changed');
  assert.equal(JSON.parse(readFileSync(join(source, 'packages/run/package.json'))).version, identity.packages.run.version);
  const runSource = join(source, 'packages/run');

  const pristine = {};
  const tarballs = argument('--tarball-dir') ?? join(work, 'tarballs');
  mkdirSync(tarballs, { recursive: true });
  for (const [name, expected] of Object.entries(identity.packages)) {
    const tarball = join(tarballs, expected.filename);
    if (!existsSync(tarball)) command('npm', ['pack', `${name}@${expected.version}`, '--ignore-scripts', '--pack-destination', tarballs, '--json'], work);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    assert.equal(integrity, expected.integrity, `Wrong ${name}@${expected.version} registry tarball`);
    const destination = join(work, `pristine-${name.replaceAll('/', '-').replaceAll('@', '')}`);
    mkdirSync(destination);
    command('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination], work);
    const packageJson = JSON.parse(readFileSync(join(destination, 'package.json')));
    assert.equal(packageJson.name, name);
    assert.equal(packageJson.version, expected.version);
    pristine[name] = destination;
  }

  const reusedToolchain = argument('--reuse-toolchain');
  if (reusedToolchain !== undefined) {
    assert.equal(sha256(readFileSync(join(reusedToolchain, 'pnpm-lock.yaml'))), identity.upstream.lockfileSha256);
    // Copy the locked pnpm layout so esbuild's dependency paths match a fresh
    // install. Linking this tree would put machine-specific paths in serde maps.
    cpSync(join(reusedToolchain, 'node_modules'), join(source, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(reusedToolchain, 'packages/run/node_modules'), join(runSource, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  } else {
    command('corepack', [`pnpm@${identity.toolchain.pnpm}`, 'install', '--frozen-lockfile', '--ignore-scripts', '--filter', 'run...', '--store-dir', join(work, 'pnpm-store')], source);
  }
  const toolRequire = createRequire(join(runSource, 'package.json'));
  for (const name of ['tsup', 'typescript', 'esbuild', 'quickjs-wasi', 'devalue']) {
    assert.equal(manifest(toolRequire, name).value.version, identity.toolchain[name], `Wrong ${name} build input`);
  }
  const tsupRequire = createRequire(manifest(toolRequire, 'tsup').path);
  assert.equal(manifest(tsupRequire, 'esbuild').value.version, identity.toolchain.tsupEsbuild, 'Wrong tsup esbuild input');
  assert.equal(sha256(readFileSync(toolRequire.resolve('quickjs-wasi/quickjs.wasm'))), identity.embeddedWasmSha256);

  const tsupCli = join(dirname(manifest(toolRequire, 'tsup').path), 'dist/cli-default.js');
  function buildRun() {
    rmSync(join(runSource, 'dist'), { recursive: true, force: true });
    command(process.execPath, [tsupCli, '--tsconfig', 'tsconfig.build.json'], runSource);
    command(process.execPath, ['scripts/embed-inline-worker.mjs'], runSource);
  }
  buildRun();
  assertSameTree(join(runSource, 'dist'), join(pristine.run, 'dist'), 'Unmodified run source build');
  await assertEmbeddedWasm(runSource, identity.baselineWorkerSha256);
  command('git', ['apply', '--check', join(artifactRoot, 'run-2.1.6-source.diff')], source);
  command('git', ['apply', join(artifactRoot, 'run-2.1.6-source.diff')], source);
  buildRun();
  const runHashes = hashes(join(runSource, 'dist'));
  await assertEmbeddedWasm(runSource);
  buildRun();
  assert.deepEqual(hashes(join(runSource, 'dist')), runHashes, 'Run build is not deterministic');
  command(process.execPath, [toolRequire.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--noEmit'], runSource);
  command(process.execPath, [toolRequire.resolve('typescript/bin/tsc'), '-p', 'src/tsconfig.json'], runSource);
  command(process.execPath, [join(projectRoot, 'scripts/dependency-patches/runtime-timing-fixtures.mjs'), '--runtime', join(runSource, 'dist/index.js')], projectRoot);

  const sdkSource = join(work, 'sdk-source');
  cpSync(pristine['@ai-sdk/code-mode'], sdkSource, { recursive: true });
  mkdirSync(join(sdkSource, 'node_modules/@types'), { recursive: true });
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  const aiRoot = argument('--ai-package') ?? dirname(projectRequire.resolve('ai/package.json'));
  assertSameTree(join(aiRoot, 'dist'), join(pristine.ai, 'dist'), 'Installed ai build input');
  assert.equal(JSON.parse(readFileSync(join(aiRoot, 'package.json'))).version, identity.packages.ai.version);
  for (const [name, target] of [['ai', aiRoot], ['run', runSource], ['tsup', dirname(manifest(toolRequire, 'tsup').path)], ['typescript', dirname(manifest(toolRequire, 'typescript').path)], ['@types/node', dirname(toolRequire.resolve('@types/node/package.json'))]]) {
    symlinkSync(target, join(sdkSource, 'node_modules', name), 'dir');
  }
  const config = JSON.parse(readFileSync(join(runSource, 'tsconfig.json')));
  config.compilerOptions.composite = false;
  writeFileSync(join(sdkSource, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(sdkSource, 'tsup.config.ts'), `import { defineConfig } from 'tsup';\nexport default defineConfig([{bundle:false,dts:false,entry:['src/**/*.ts'],format:['esm'],platform:'node',sourcemap:true,target:'es2023'},{dts:{only:true},entry:{index:'src/index.ts'},format:['esm'],platform:'node',target:'es2023'}]);\n`);
  function buildSdk() {
    rmSync(join(sdkSource, 'dist'), { recursive: true, force: true });
    command(process.execPath, [tsupCli, '--tsconfig', 'tsconfig.json'], sdkSource);
  }
  buildSdk();
  assertSameTree(join(sdkSource, 'dist'), join(pristine['@ai-sdk/code-mode'], 'dist'), 'Unmodified SDK source build');
  command('git', ['apply', '--check', join(artifactRoot, 'code-mode-1.0.50-source.diff')], sdkSource);
  command('git', ['apply', join(artifactRoot, 'code-mode-1.0.50-source.diff')], sdkSource);
  buildSdk();
  const sdkHashes = hashes(join(sdkSource, 'dist'));
  buildSdk();
  assert.deepEqual(hashes(join(sdkSource, 'dist')), sdkHashes, 'SDK build is not deterministic');
  command(process.execPath, [join(projectRoot, 'scripts/dependency-patches/runtime-timing-capability-fixtures.mjs'), '--sdk-root', sdkSource, '--stock-runtime', pristine.run, '--patched-runtime', runSource, '--ai-package', aiRoot], projectRoot);

  const runPatched = join(work, 'run-patched');
  cpSync(pristine.run, runPatched, { recursive: true });
  cpSync(join(runSource, 'dist'), join(runPatched, 'dist'), { recursive: true });
  const sdkPatched = join(work, 'sdk-patched');
  cpSync(pristine['@ai-sdk/code-mode'], sdkPatched, { recursive: true });
  cpSync(join(sdkSource, 'dist'), join(sdkPatched, 'dist'), { recursive: true });
  cpSync(join(sdkSource, 'src'), join(sdkPatched, 'src'), { recursive: true });
  const outputs = {
    'patches/run@2.1.6.patch': packagePatch(pristine.run, runPatched),
    'patches/@ai-sdk-code-mode@1.0.50.patch': packagePatch(pristine['@ai-sdk/code-mode'], sdkPatched),
  };
  for (const [name, contents] of Object.entries(outputs)) {
    if (write) writeFileSync(join(projectRoot, name), contents);
    else assert.equal(readFileSync(join(projectRoot, name), 'utf8'), contents, `${name} differs from its source-built patch`);
  }
  const emitted = { run: runHashes, '@ai-sdk/code-mode': sdkHashes };
  if (write) {
    identity.patchedDistSha256 = emitted;
    writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  } else assert.deepEqual(emitted, identity.patchedDistSha256, 'Emitted distribution hashes differ');
  console.log(JSON.stringify({ status: 'passed', mode: write ? 'write' : 'check', upstreamCommit: identity.upstream.commit, wasmSha256: identity.embeddedWasmSha256, workerSha256: runHashes['runtime/worker-source.js'], patches: Object.fromEntries(Object.entries(outputs).map(([name, contents]) => [name, sha256(contents)])) }, null, 2));
} finally {
  if (process.argv.includes('--keep-work')) console.log(`Build workspace: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
