import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DiagnosticsRunner, formatDiagnostics } from "../src/tools/diagnostics.js";

const require = createRequire(import.meta.url);
const posixOnly = process.platform === "win32";
const config = { enabled: true, commands: [], autoDetect: true, autoDetectTimeoutMs: 15_000, maxOutputBytes: 4096 };
async function fixture(name: string, run: (root: string) => Promise<void>) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "biny-diagnostics-literal-"));
  const root = path.join(parent, name);
  try {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await symlink(require.resolve("typescript/bin/tsc"), path.join(root, "node_modules", ".bin", "tsc"));
    await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"noEmit":true},"files":["sample.ts"]}');
    await writeFile(path.join(root, "sample.ts"), "const answer: number = 42;\n");
    await run(root);
  } finally { await rm(parent, { recursive: true, force: true }); }
}
for (const name of ["ordinary", "space project", "budget$BINY_LITERAL_PATH", "literal`printf expanded`", "single'quote", 'double"quote']) {
  test(`auto-detected diagnostics run the literal local compiler in ${JSON.stringify(name)}`, { skip: posixOnly }, async () => {
    await fixture(name, async root => {
      const outcome = await new DiagnosticsRunner(root, config).run("sample.ts");
      assert.ok(outcome);
      assert.equal(outcome.exitCode, 0, outcome.output);
      assert.equal(formatDiagnostics(outcome).status, "clean");
    });
  });
}
test("literal-path diagnostics still report actual TypeScript errors", { skip: posixOnly }, async () => {
  await fixture("bad$BINY_LITERAL_PATH", async root => {
    await writeFile(path.join(root, "sample.ts"), 'const answer: number = "not a number";\n');
    const outcome = await new DiagnosticsRunner(root, config).run("sample.ts");
    assert.ok(outcome);
    assert.notEqual(outcome.exitCode, 0);
    assert.match(outcome.output, /TS2322/u);
    assert.equal(formatDiagnostics(outcome).status, "failed");
  });
});
test("explicit configured commands retain shell syntax and are not path-quoted", { skip: posixOnly }, async () => {
  await fixture("configured$BINY_LITERAL_PATH", async root => {
    const command = 'value=custom; printf "%s" "$value"';
    const runner = new DiagnosticsRunner(root, { ...config, commands: [{ extensions: [".ts"], command, timeoutMs: 5000 }] });
    assert.equal(runner.resolveCommand("sample.ts")?.command, command);
    const outcome = await runner.run("sample.ts");
    assert.equal(outcome?.output, "custom");
    assert.equal(outcome?.exitCode, 0);
  });
});
test("disabled, unsupported, missing local compiler and pre-aborted diagnostics retain behavior", { skip: posixOnly }, async () => {
  await fixture("controls", async root => {
    assert.equal(await new DiagnosticsRunner(root, { ...config, enabled: false }).run("sample.ts"), undefined);
    assert.equal(await new DiagnosticsRunner(root, config).run("sample.py"), undefined);
    const reason = new Error("cancelled before diagnostics");
    await assert.rejects(new DiagnosticsRunner(root, config).run("sample.ts", AbortSignal.abort(reason)), error => error === reason);
    await rm(path.join(root, "tsconfig.json"));
    assert.equal(await new DiagnosticsRunner(root, config).run("sample.ts"), undefined);
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    await rm(path.join(root, "node_modules", ".bin", "tsc"));
    assert.equal(await new DiagnosticsRunner(root, config).run("sample.ts"), undefined);
  });
});
