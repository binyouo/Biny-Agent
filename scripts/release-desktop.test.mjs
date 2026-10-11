import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"));
const signingCheck = workflow.jobs.build.steps.find(step => step.name === "Verify macOS signing configuration").run;

// 执行发布工作流的真实检查；现有应用测试不覆盖无凭据的 Beta 发布。
for (const [name, unsigned, tag, credentials, expected] of [
  ["unsigned Beta can build without Apple credentials", "true", "v0.0.1-beta.1", false, 0],
  ["unsigned stable release is rejected", "true", "v1.0.0", false, 1],
  ["signed release still requires Apple credentials", "false", "v0.0.1-beta.1", false, 1],
  ["signed release accepts complete Apple credentials", "false", "v0.0.1-beta.1", true, 0],
]) {
  test(name, () => {
    const env = { PATH: process.env.PATH, RELEASE_UNSIGNED: unsigned, RELEASE_TAG: tag };
    for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      env[key] = credentials ? "fixture" : "";
    }
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", signingCheck], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, expected, result.stdout + result.stderr);
  });
}

// 首次发布的版本可能已经写入包元数据，不能因版本未变而阻止创建首个 tag。
test("prepare release accepts the current package version without changing it", () => {
  const prepare = parse(readFileSync(new URL("../.github/workflows/prepare-release.yml", import.meta.url), "utf8"));
  const update = prepare.jobs.prepare.steps.find(step => step.name === "Update package version").run;
  const cwd = mkdtempSync(path.join(os.tmpdir(), "biny-release-version-"));
  const manifest = { name: "release-fixture", version: "0.0.1-beta.1" };
  try {
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify(manifest));
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", update], {
      cwd, env: { PATH: process.env.PATH, VERSION: manifest.version }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")), manifest);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// 未配置的 GitHub Secrets 会成为空环境变量，打包器仍会把空证书路径解析为工作目录。
test("unsigned packager does not receive empty signing credential variables", () => {
  const build = workflow.jobs.build.steps.find(step => step.name === "Build macOS package").run.replaceAll("${{ matrix.arch }}", "arm64");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "biny-release-packager-"));
  try {
    const pnpm = path.join(cwd, "pnpm");
    writeFileSync(pnpm, `#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "electron-builder" ]; then
  [ "\${CSC_LINK+x}\${CSC_KEY_PASSWORD+x}\${APPLE_ID+x}\${APPLE_APP_SPECIFIC_PASSWORD+x}\${APPLE_TEAM_ID+x}" = "" ] || exit 42
  printf '%s\\n' "$@"
fi
`);
    chmodSync(pnpm, 0o755);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-c", build], {
      cwd, env: { PATH: `${cwd}:${process.env.PATH}`, RELEASE_UNSIGNED: "true", CSC_LINK: "", CSC_KEY_PASSWORD: "", APPLE_ID: "", APPLE_APP_SPECIFIC_PASSWORD: "", APPLE_TEAM_ID: "" },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, "Unsigned packaging must remove credential variables, including empty ones");
    assert.ok(result.stdout.split("\n").includes("--config.mac.identity=-"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
