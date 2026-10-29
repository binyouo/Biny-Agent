import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const project = process.cwd();
const destination = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(project, 'package.json'));
const stage = await mkdtemp(path.join(os.tmpdir(), 'biny-npm-pack-'));

async function packageRoot(entry, expectedName) {
  let dir = path.dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
      if (manifest.name === expectedName) return dir;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate ${expectedName}`);
    dir = parent;
  }
}

try {
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.bundleDependencies = ['@earendil-works/pi-tui'];
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const item of ['dist', 'benchmarks', 'README.md', 'THIRD_PARTY_NOTICES.txt']) {
    await cp(path.join(project, item), path.join(stage, item), { recursive: true });
  }
  const tuiRoot = await packageRoot(require.resolve('@earendil-works/pi-tui'), '@earendil-works/pi-tui');
  const tuiRequire = createRequire(path.join(tuiRoot, 'package.json'));
  for (const [name, root] of [
    ['@earendil-works/pi-tui', tuiRoot],
    ...['marked', 'get-east-asian-width'].map(name => [name, tuiRequire.resolve(name)]),
  ]) {
    const source = name === '@earendil-works/pi-tui' ? root : await packageRoot(root, name);
    const target = path.join(stage, 'node_modules', name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, filter: sourcePath => path.basename(sourcePath) !== 'node_modules' });
  }
  await cp(path.join(project, 'scripts/licenses/pi-tui.LICENSE'), path.join(stage, 'node_modules/@earendil-works/pi-tui/LICENSE'));
  await mkdir(destination, { recursive: true });
  const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: stage, encoding: 'utf8' }))[0];
  const names = new Set(result.files.map(file => file.path));
  for (const required of [
    'dist/cli/index.js',
    'node_modules/@earendil-works/pi-tui/dist/components/editor.js',
    'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
    'node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node',
    'node_modules/@earendil-works/pi-tui/LICENSE',
  ]) {
    if (!names.has(required)) throw new Error(`Missing package file: ${required}`);
  }
  if ([...names].some(name => name.split(/[\\/]/).includes('..'))) throw new Error('Package contains an unsafe path');
  console.log(path.join(destination, result.filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
