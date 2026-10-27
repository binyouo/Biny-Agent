import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const renderer = workflow.jobs.renderer;
const fontName = "Install CJK screenshot fonts";

function namedStep(job, name) {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${name} step`);
  return matches[0];
}

test("CJK font acquisition keeps bounded command-scoped retries and the three-minute cap", () => {
  // Exact parsed-YAML source contract, not a shell execution or network recovery test.
  // Timeout covers connection/data inactivity, not the entire transfer duration.
  assert.deepEqual(namedStep(renderer, fontName), {
    name: fontName,
    "timeout-minutes": 3,
    run: [
      "date -u '+%Y-%m-%dT%H:%M:%SZ CJK fonts: apt update start'",
      "sudo apt-get -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1 update",
      "date -u '+%Y-%m-%dT%H:%M:%SZ CJK fonts: apt install start'",
      "sudo apt-get -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1 install -y fonts-noto-cjk",
      "date -u '+%Y-%m-%dT%H:%M:%SZ CJK fonts: apt install complete'",
      "dpkg-query -W -f='${binary:Package} ${Version}\\n' fonts-noto-cjk",
      ""
    ].join("\n")
  });
  // Retain GitHub's fail-fast default shell; no failure masking or extra authority.
  assert.equal(workflow.defaults, undefined);
  assert.equal(renderer.defaults, undefined);
  assert.equal(renderer["continue-on-error"], undefined);
  assert.equal(renderer.permissions, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(renderer["runs-on"], "ubuntu-latest");
  assert.equal(renderer["timeout-minutes"], 15);
});

test("font installation still precedes mandatory production fixture and native input checks", () => {
  const fontIndex = renderer.steps.indexOf(namedStep(renderer, fontName));
  assert.deepEqual(renderer.steps.slice(fontIndex + 1, fontIndex + 3), [
    {
      name: "Build production-component fixture",
      env: { BINY_DISCLOSURE_BASE_REF: "${{ github.event.pull_request.base.sha }}" },
      run: "node scripts/build-memory-disclosure-fixture.mjs"
    },
    {
      name: "Test real rendering and native keyboard input",
      run: [
        'xvfb-run -a --server-args="-screen 0 1600x2400x24" pnpm exec electron --no-sandbox scripts/memory-disclosure-browser.test.mjs',
        'node -e \'const r = require("./.memory-disclosure-results/results.json"); if (!r.passed || r.variants.length !== 4 || !r.input?.events.length) process.exit(1)\'',
        ""
      ].join("\n")
    }
  ]);
  assert.deepEqual(renderer.needs, ["plan", "static"]);
  assert.equal(renderer.if, "needs.plan.outputs.renderer == 'true'");
});

test("renderer evidence and selected-lane validation remain required", () => {
  assert.deepEqual(renderer.steps.at(-1), {
    uses: "actions/upload-artifact@v7",
    if: "${{ always() }}",
    with: {
      name: "memory-disclosure-renderer",
      path: ".memory-disclosure-results/",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 7
    }
  });
  const validate = workflow.jobs.validate;
  assert.equal(validate.if, "${{ always() }}");
  assert.ok(validate.needs.includes("renderer"));
  assert.equal(validate["continue-on-error"], undefined);
  assert.deepEqual(namedStep(validate, "Require exactly the selected validation lanes to pass"), {
    name: "Require exactly the selected validation lanes to pass",
    env: { NEEDS_JSON: "${{ toJSON(needs) }}" },
    run: "node scripts/ci-test-plan.mjs --check-results"
  });
});

test("the static gate runs this contract alongside existing CI policy regressions", () => {
  assert.deepEqual(namedStep(workflow.jobs.static, "Test CI selection, runner, model metadata and release policy"), {
    name: "Test CI selection, runner, model metadata and release policy",
    run: "node --test scripts/ci-test-plan.test.mjs scripts/run-tests.test.mjs scripts/sync-model-metadata.test.mjs scripts/release-desktop.test.mjs scripts/ci-cjk-fonts.test.mjs"
  });
});
