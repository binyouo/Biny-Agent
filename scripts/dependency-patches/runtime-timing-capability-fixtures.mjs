import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `Missing ${name}`);
  return resolve(process.argv[index + 1]);
}
const sdkRoot = argument('--sdk-root');
const stockRuntime = argument('--stock-runtime');
const patchedRuntime = argument('--patched-runtime');
const aiRoot = process.argv.includes('--ai-package')
  ? argument('--ai-package') : dirname(require.resolve('ai/package.json'));
const temporary = mkdtempSync(join(tmpdir(), 'biny-timing-capability-'));
try {
  async function isolatedSdk(name, runtime) {
    const root = join(temporary, name);
    cpSync(sdkRoot, root, { recursive: true, filter: path => !path.includes(`${sdkRoot}/node_modules`) });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(runtime, join(root, 'node_modules/run'), 'dir');
    symlinkSync(aiRoot, join(root, 'node_modules/ai'), 'dir');
    return await import(pathToFileURL(join(root, 'dist/index.js')).href);
  }

  const { createRunner: patchedCreateRunner } = await import(pathToFileURL(join(patchedRuntime, 'dist/index.js')).href);
  const { createRunner: stockCreateRunner } = await import(pathToFileURL(join(stockRuntime, 'dist/index.js')).href);
  const patched = await isolatedSdk('patched-sdk-and-runtime', patchedRuntime);
  const missingRuntime = await isolatedSdk('patched-sdk-stock-runtime', stockRuntime);
  assert.equal(stockCreateRunner.executionTimeoutBudgetVersion, undefined);
  assert.equal(patchedCreateRunner.executionTimeoutBudgetVersion, 1);
  assert.equal(patched.experimental_runCodeMode.executionTimeoutBudgetVersion, 1);
  assert.equal(missingRuntime.experimental_runCodeMode.executionTimeoutBudgetVersion, undefined);
  for (const target of [patchedCreateRunner, patched.experimental_runCodeMode]) {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'executionTimeoutBudgetVersion');
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.throws(() => { target.executionTimeoutBudgetVersion = 2; }, TypeError);
    assert.throws(() => { delete target.executionTimeoutBudgetVersion; }, TypeError);
  }
  await assert.rejects(() => missingRuntime.experimental_runCodeMode({
    js: 'return 1;', tools: {}, options: { executionPolicy: { timeoutMs: 1_000, executionTimeoutMs: 80 } },
  }), error => {
    assert.equal(error.code, 'CODE_MODE_PROTOCOL_ERROR');
    assert.match(error.message, /exact run@2\.1\.6 runtime timing patch/u);
    return true;
  });
  assert.equal(await missingRuntime.experimental_runCodeMode({ js: 'return 1;', tools: {} }), 1);
  assert.equal(await patched.experimental_runCodeMode({
    js: 'return 2;', tools: {}, options: { executionPolicy: { timeoutMs: 1_000, executionTimeoutMs: 80 } },
  }), 2);
  console.log(JSON.stringify({ status: 'passed', fixtures: ['stock runtime has no timing capability', 'patched markers are immutable', 'SDK does not advertise a missing runtime patch', 'opt-in fails closed without runtime patch', 'stock default remains usable', 'matching patched SDK and runtime execute'] }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
