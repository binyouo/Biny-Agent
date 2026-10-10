/** Public formatting stays identical while unused CLI imports avoid ICU initialization. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const target = new URL("../src/runtime/statusReport.ts", import.meta.url).href;
const preload = `
const Original = Intl.NumberFormat;
globalThis.formatterProbe = { calls: [], Original };
Intl.NumberFormat = new Proxy(Original, {
  construct(target, args, newTarget) {
    globalThis.formatterProbe.calls.push(args);
    if (process.env.BINY_FORMATTER_FAIL === "1") throw new Error("formatter construction failed");
    return Reflect.construct(target, args, newTarget);
  }
});`;

const cases = [
  {
    name: "unused imports, exact values, and one shared formatter",
    fail: false,
    code: `
import assert from "node:assert/strict";
import { formatCount } from ${JSON.stringify(target)};
const probe = globalThis.formatterProbe;
assert.equal(probe.calls.length, 0, "importing the reporting module must not initialize ICU");
const reference = new probe.Original("en-US");
for (const value of [-Infinity, -100.5, -0, 0, 0.49, 0.5, 1, 999.5, 1234567.6, Number.MAX_SAFE_INTEGER, 1e21, Infinity, NaN]) {
  assert.equal(formatCount(value), reference.format(Math.max(0, Math.round(value))), String(value));
}
assert.deepEqual(probe.calls, [["en-US"]], "all reporting calls must share one en-US formatter");`
  },
  {
    name: "constructor failures remain visible when formatting is first requested",
    fail: true,
    code: `
import assert from "node:assert/strict";
import { formatCount } from ${JSON.stringify(target)};
assert.equal(globalThis.formatterProbe.calls.length, 0);
assert.throws(() => formatCount(1000), /formatter construction failed/);
assert.throws(() => formatCount(2000), /formatter construction failed/);
assert.equal(globalThis.formatterProbe.calls.length, 2, "failed initialization must not cache a broken formatter");`
  }
];

for (const testCase of cases) {
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    "--input-type=module", "--eval", testCase.code
  ], {
    env: { ...process.env, BINY_FORMATTER_FAIL: testCase.fail ? "1" : "0" },
    encoding: "utf8",
    timeout: 20_000
  });
  assert.equal(child.status, 0, `${testCase.name}\n${child.error?.message ?? ""}\n${child.stderr}\n${child.stdout}`);
}
console.log("status formatter lazy initialization tests passed");
