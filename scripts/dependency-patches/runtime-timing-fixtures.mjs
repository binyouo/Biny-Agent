import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const runtimeArgument = process.argv.indexOf('--runtime');
const runtimePath = runtimeArgument === -1
  ? createRequire(require.resolve('@ai-sdk/code-mode/package.json')).resolve('run')
  : resolve(process.argv[runtimeArgument + 1]);
const { run, createRunner } = await import(pathToFileURL(runtimePath).href);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const limits = { timeoutMs: 3_000, executionTimeoutMs: 80 };
const results = [];

async function fixture(name, operation) {
  const started = performance.now();
  await operation();
  results.push({ name, elapsedMs: Math.round(performance.now() - started) });
}

async function expectCode(operation, code, expectedTimeoutMs) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    if (expectedTimeoutMs !== undefined) assert.equal(error.details.timeoutMs, expectedTimeoutMs);
    return true;
  });
}

await fixture('stock wall default remains bounded', async () => {
  await expectCode(() => run({
    source: 'await tools.wait(); return 1;',
    hostFunctions: { tools: { wait: () => delay(200) } },
    limits: { timeoutMs: 100 },
  }), 'RUN_TIMEOUT', 100);
});

await fixture('host await exceeds VM budget without replay', async () => {
  let calls = 0;
  const result = await run({
    source: 'const first = await tools.wait(); const second = await tools.wait(); return first + second;',
    hostFunctions: { tools: { wait: async () => { calls += 1; await delay(150); return calls; } } },
    limits,
  });
  assert.deepEqual(result, { status: 'completed', value: 3 });
  assert.equal(calls, 2);
});

await fixture('pure CPU loop consumes execution budget', () => expectCode(() => run({
  source: 'while (true) {}', limits,
}), 'RUN_TIMEOUT', limits.executionTimeoutMs));

await fixture('CPU remains bounded with a pending bridge', async () => {
  let calls = 0;
  await expectCode(() => run({
    source: 'await Promise.race([tools.wait(), tools.ready()]); while (true) {}',
    hostFunctions: { tools: { wait: async () => { calls += 1; await delay(500); }, ready: () => true } },
    limits,
  }), 'RUN_TIMEOUT', limits.executionTimeoutMs);
  assert.equal(calls, 1);
});

await fixture('multiple individually small slices accumulate', async () => {
  const slice = 'let sum = 0; for (let i = 0; i < 200000; i++) sum += i;';
  assert.equal((await run({ source: `${slice} return sum;`, limits })).status, 'completed');
  let calls = 0;
  await expectCode(() => run({
    source: `for (let j = 0; j < 100; j++) { ${slice} await tools.tick(sum); } return 1;`,
    hostFunctions: { tools: { tick: async () => { calls += 1; await delay(10); } } },
    limits,
  }), 'RUN_TIMEOUT', limits.executionTimeoutMs);
  assert.ok(calls >= 2 && calls < 100, `Expected cumulative expiration across slices; observed ${calls}`);
});

await fixture('parallel awaits retain normal Promise ordering', async () => {
  const result = await run({
    source: 'return await Promise.all([tools.wait(1), tools.wait(2)]);',
    hostFunctions: { tools: { wait: async n => { await delay(n === 1 ? 180 : 120); return n; } } },
    limits,
  });
  assert.deepEqual(result, { status: 'completed', value: [1, 2] });
});

await fixture('detached bridge still fails closed', () => expectCode(() => run({
  source: 'tools.wait(); return 1;',
  hostFunctions: { tools: { wait: () => delay(200) } },
  limits,
}), 'RUN_DETACHED_BRIDGE_REQUEST'));

await fixture('finite wall cap bounds never-settling guest Promise', () => expectCode(() => run({
  source: 'await new Promise(() => {}); return 1;',
  limits: { timeoutMs: 150, executionTimeoutMs: 500 },
}), 'RUN_TIMEOUT', 150));

await fixture('finite wall cap can be shorter than VM budget', () => expectCode(() => run({
  source: 'while (true) {}',
  limits: { timeoutMs: 150, executionTimeoutMs: 1_000 },
}), 'RUN_TIMEOUT', 150));

await fixture('serialization guest getter consumes execution budget', () => expectCode(() => run({
  source: 'return { get value() { while (true) {} } };', limits,
}), 'RUN_TIMEOUT', limits.executionTimeoutMs));

await fixture('result marshalling size bound stays active', () => assert.rejects(() => run({
  source: 'return "x".repeat(2048);', limits: { ...limits, maxResultBytes: 128 },
}), /size limit|exceeds/u));

await fixture('host input marshalling size bound stays active', () => assert.rejects(() => run({
  source: 'return await tools.echo("x".repeat(2048));',
  hostFunctions: { tools: { echo: value => value } },
  limits: { ...limits, maxHostFunctionArgumentsBytes: 128 },
}), /size limit|exceed/u));

await fixture('host output marshalling size bound stays active', () => assert.rejects(() => run({
  source: 'return await tools.large();',
  hostFunctions: { tools: { large: () => 'x'.repeat(2048) } },
  limits: { ...limits, maxHostFunctionOutputBytes: 128 },
}), /size limit|exceed/u));

await fixture('aggregate bridge bound stays active', () => expectCode(() => run({
  source: 'await tools.echo(1); await tools.echo(2); return await tools.echo(3);',
  hostFunctions: { tools: { echo: value => value } },
  limits: { ...limits, maxBridgeRequests: 2 },
}), 'RUN_BRIDGE_LIMIT'));

await fixture('parallel bridge admission bound stays active', () => expectCode(() => run({
  source: 'return await Promise.all([tools.wait(), tools.wait()]);',
  hostFunctions: { tools: { wait: () => delay(100) } },
  limits: { ...limits, maxInFlightBridgeRequests: 1 },
}), 'RUN_BRIDGE_LIMIT'));

await fixture('VM memory bound stays active independently of timing', () => assert.rejects(() => run({
  source: 'return new Array(5000000).fill("x");',
  limits: { ...limits, executionTimeoutMs: 1_000, memoryLimitBytes: 8 * 1024 * 1024 },
}), /out of memory/u));

await fixture('VM stack bound stays active independently of timing', () => assert.rejects(() => run({
  source: 'function recurse(n) { return recurse(n + 1); } return recurse(0);',
  limits: { ...limits, executionTimeoutMs: 1_000, maxStackSizeBytes: 64 * 1024 },
}), /stack overflow|stack/u));

await fixture('sync host actual blocking wait is excluded', async () => {
  const runner = createRunner({
    syncHostFunctions: { tools: { wait: async () => { await delay(180); return 7; } } },
    limits,
  });
  assert.deepEqual(await runner.run({ source: 'return tools.wait();' }), { status: 'completed', value: 7 });
});

await fixture('invalid execution budget rejects before running', async () => {
  for (const executionTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(() => run({ source: 'return 1;', limits: { executionTimeoutMs } }), /limits.executionTimeoutMs/u);
  }
});

console.log(JSON.stringify({ status: 'passed', runtimePath, fixtures: results }, null, 2));
