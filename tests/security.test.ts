import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, stableSystemPromptForCache, systemPromptForTelemetry } from "../src/agent/prompts.js";
import { renderSoulPrompt } from "../src/agent/builtinSoul.js";
import { readSecurityPolicy, securityPolicyPath } from "../src/agent/context/securityPolicy.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-security-test-"));
try {
  assert.equal(securityPolicyPath({ configDir: root }), path.join(root, "SECURITY.md"));
  assert.equal(await readSecurityPolicy({ configDir: root }), undefined);

  const securityPath = securityPolicyPath({ configDir: root });
  await writeFile(securityPath, "\n", "utf8");
  assert.equal(await readSecurityPolicy({ configDir: root }), undefined);

  await writeFile(securityPath, "禁止把未验证的结果说成完成。\n只允许收紧行为。", "utf8");
  const firstSecurity = await readSecurityPolicy({ configDir: root });
  assert.ok(firstSecurity);
  assert.match(firstSecurity, /SECURITY RULES \(HIGHEST PRIORITY/u);
  assert.match(firstSecurity, /禁止把未验证的结果说成完成/u);
  assert.match(firstSecurity, /overrides all other instructions/u);

  const first = buildSystemPrompt({
    cwd: "/workspace",
    securityPrompt: firstSecurity,
    soulPrompt: renderSoulPrompt("Soul should remain stable.", "user"),
    identityPrompt: "<biny_identity>USER PROFILE\nprivate user preference</biny_identity>",
    parentThreadPrompt: "PARENT THREAD\nprivate parent context",
    tools: [{ name: "Read", promptSnippet: "Read a file" }]
  });
  const securityIndex = first.indexOf("<!-- biny-security:start -->");
  const soulIndex = first.indexOf("<!-- biny-soul:start -->");
  const modeIndex = first.indexOf("Use the provided project context");
  const identityIndex = first.indexOf("<!-- biny-identity:start -->");
  const toolsIndex = first.indexOf("<!-- biny-runtime-tools:start -->");
  assert.ok(securityIndex > -1 && securityIndex < soulIndex);
  assert.ok(soulIndex < identityIndex && identityIndex < modeIndex && modeIndex < toolsIndex);
  assert.match(first, /private user preference/u);
  assert.match(first, /Soul should remain stable\./u);
  assert.doesNotMatch(first, /Alma/u);

  const baselineStable = stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace" }));
  assert.notEqual(
    baselineStable,
    stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace", securityPrompt: firstSecurity }))
  );
  assert.notEqual(
    baselineStable,
    stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace", soulPrompt: renderSoulPrompt("A different stable Soul.", "user") }))
  );
  assert.notEqual(
    baselineStable,
    stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace", identityPrompt: "USER PROFILE\nA different user." }))
  );

  const telemetry = systemPromptForTelemetry(first) ?? "";
  assert.match(telemetry, /<biny_security omitted="true" \/>/u);
  assert.match(telemetry, /<biny_parent_thread omitted="true" \/>/u);
  assert.doesNotMatch(telemetry, /禁止把未验证的结果说成完成|private user preference|Soul should remain stable/u);
  assert.doesNotMatch(telemetry, /private parent context/u);

  const dynamic = buildSystemPrompt({
    cwd: "/workspace",
    securityPrompt: firstSecurity,
    extensionPrompt: "dynamic-one"
  });
  const dynamicChanged = buildSystemPrompt({
    cwd: "/workspace",
    securityPrompt: firstSecurity,
    extensionPrompt: "dynamic-two"
  });
  assert.notEqual(stableSystemPromptForCache(dynamic), stableSystemPromptForCache(dynamicChanged));

  await writeFile(securityPath, "下一轮立即生效的安全规则。", "utf8");
  const secondSecurity = await readSecurityPolicy({ configDir: root });
  assert.ok(secondSecurity);
  assert.match(secondSecurity, /下一轮立即生效的安全规则/u);
  assert.notEqual(
    stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace", securityPrompt: firstSecurity })),
    stableSystemPromptForCache(buildSystemPrompt({ cwd: "/workspace", securityPrompt: secondSecurity }))
  );

  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
  try {
    await mkdir(path.join(root, "agent"), { recursive: true });
    await writeFile(path.join(root, "agent", "SECURITY.md"), "通过全局配置目录解析。", "utf8");
    const envSecurity = await readSecurityPolicy();
    assert.match(envSecurity ?? "", /通过全局配置目录解析/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("security tests passed");
