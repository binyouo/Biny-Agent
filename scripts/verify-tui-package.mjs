import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2]);
const require = createRequire(path.join(root, 'package.json'));
const manifest = require(path.join(root, 'package.json'));
const tuiEntry = require.resolve('@earendil-works/pi-tui');
const { Editor } = await import(pathToFileURL(tuiEntry).href);
const tuiRoot = path.dirname(path.dirname(tuiEntry));
const native = process.platform === 'darwin' && process.arch === 'arm64'
  ? 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node'
  : process.platform === 'win32' && process.arch === 'x64'
    ? 'native/win32/prebuilds/win32-x64/win32-console-mode.node'
    : undefined;
if (native) require(path.join(tuiRoot, native));
assert.equal(Editor.prototype.expandPasteMarkers.call({ pastes: new Map([[1, '[paste #2]'], [2, 'unexpected']]) }, '[paste #1]'), '[paste #2]', 'TUI paste patch must be present');
const cliVersion = execFileSync(process.execPath, [path.join(root, 'dist/cli/index.js'), '--version'], { encoding: 'utf8' });
assert.ok(cliVersion.includes(manifest.version), 'CLI version must match package version');
console.log(`Verified ${manifest.name}@${manifest.version} on ${process.platform}/${process.arch}`);
