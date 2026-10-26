import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const workflow = record(parse(readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as unknown);
const jobs = record(workflow.jobs);
const renderer = record(jobs.renderer);
assert.ok(Array.isArray(renderer.steps));
const steps = (renderer.steps as unknown[]).map(record);

function namedStep(name: string): Record<string, unknown> {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

const fonts = namedStep("Install CJK screenshot fonts");
const fixture = namedStep("Build production-component fixture");
const rendering = namedStep("Test real rendering and native keyboard input");

test("CJK dependency setup has its own budget below the Renderer job budget", () => {
  assert.equal(renderer["timeout-minutes"], 15);
  assert.equal(fonts["timeout-minutes"], 3);
  assert.ok(Number(fonts["timeout-minutes"]) < Number(renderer["timeout-minutes"]));
  assert.deepEqual(fonts, {
    name: "Install CJK screenshot fonts",
    "timeout-minutes": 3,
    run: "sudo apt-get update && sudo apt-get install -y fonts-noto-cjk",
  });
});

test("font budgeting preserves real rendering and native keyboard validation", () => {
  assert.deepEqual(renderer.needs, ["plan", "static"]);
  assert.equal(renderer.if, "needs.plan.outputs.renderer == 'true'");
  assert.equal(renderer["continue-on-error"], undefined);
  assert.deepEqual(fixture, {
    name: "Build production-component fixture",
    env: { BINY_DISCLOSURE_BASE_REF: "${{ github.event.pull_request.base.sha }}" },
    run: "node scripts/build-memory-disclosure-fixture.mjs",
  });
  assert.deepEqual(rendering, {
    name: "Test real rendering and native keyboard input",
    run: 'xvfb-run -a --server-args="-screen 0 1600x2400x24" pnpm exec electron --no-sandbox scripts/memory-disclosure-browser.test.mjs\n'
      + 'node -e \'const r = require("./.memory-disclosure-results/results.json"); if (!r.passed || r.variants.length !== 4 || !r.input?.events.length) process.exit(1)\'\n',
  });
  assert.equal(steps.indexOf(fixture), steps.indexOf(fonts) + 1);
  assert.equal(steps.indexOf(rendering), steps.indexOf(fixture) + 1);
});

test("Renderer artifacts and final validation still fail visibly", () => {
  const uploads = steps.filter((step) => step.uses === "actions/upload-artifact@v7");
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], {
    uses: "actions/upload-artifact@v7",
    if: "${{ always() }}",
    with: {
      name: "memory-disclosure-renderer",
      path: ".memory-disclosure-results/",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 7,
    },
  });
  assert.equal(steps.indexOf(uploads[0]!), steps.indexOf(rendering) + 1);
  const validate = record(jobs.validate);
  assert.equal(validate.if, "${{ always() }}");
  assert.equal(validate["continue-on-error"], undefined);
  assert.ok(Array.isArray(validate.needs) && validate.needs.includes("renderer"));
  assert.ok(Array.isArray(validate.steps));
  const gates = (validate.steps as unknown[]).map(record).filter((step) => step.name === "Require exactly the selected validation lanes to pass");
  assert.deepEqual(gates, [{
    name: "Require exactly the selected validation lanes to pass",
    env: { NEEDS_JSON: "${{ toJSON(needs) }}" },
    run: "node scripts/ci-test-plan.mjs --check-results",
  }]);
});
