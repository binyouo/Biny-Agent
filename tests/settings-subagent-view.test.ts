import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { JSDOM } from "jsdom";

test("Subagent settings show runtime-specific model choices and external restrictions; disabled and busy controls cannot edit defaults", async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true } });
  try {
    const { SettingsSubagent } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsSubagent.tsx");
    const { SettingsDraftContext } = await vite.ssrLoadModule("/src/desktop/renderer/src/components/settings/SettingsDraftContext.ts");
    const models = [{ alias: "native", provider: "api", providerType: "openai", displayName: "Native model", model: "native-id", supportsTools: true },
      { alias: "external", provider: "worker", providerType: "acp", displayName: "ACP model", model: "acp-id", supportsTools: true },
      { alias: "other", provider: "other-worker", providerType: "acp", displayName: "Other model", model: "other-id", supportsTools: true }];
    const render = (runtime: string, enabled = true, busy = false, model?: string, providerAlias?: string, connected = true) => {
      const value = { draft: { subagent: { enabled, runtime, model, providerAlias }, permission: { mode: "ask", denyPaths: [".env"] } },
        snapshot: { hasRunningTasks: busy, externalSubagentBlockers: ["沙箱测试限制"], models: { configured: models,
          connections: connected ? [{ providerAlias: "api", providerType: "openai" }, { providerAlias: "worker", providerType: "acp", displayName: "Claude Code" },
            { providerAlias: "other-worker", providerType: "acp", displayName: "Codex CLI" },
            { providerAlias: "offline", providerType: "acp", displayName: "Offline", enabled: false }] : [] } },
        saveState: "idle", setSubagent() {} };
      return new JSDOM(renderToStaticMarkup(createElement(SettingsDraftContext.Provider, { value },
        createElement(SettingsSubagent, { onOpenModels() {} })))).window.document;
    };
    const native = render("builtin");
    assert.ok(native.querySelector('[aria-label="默认子代理"]'));
    assert.match(native.body.textContent!, /跟随主模型/);
    assert.match(native.body.textContent!, /Native model/);
    assert.doesNotMatch(native.body.textContent!, /ACP model|沙箱测试限制/);
    const automatic = render("auto");
    assert.equal(automatic.querySelector('select')?.value, "auto");
    assert.equal(automatic.querySelector('[aria-label="子代理模型"]'), null);
    assert.equal(automatic.querySelector('input[aria-label="子代理模型 ID"]'), null);
    assert.match(automatic.body.textContent!, /优先使用.*Claude Code/);
    const options = [...native.querySelectorAll('select[aria-label="默认子代理"] option')];
    assert.ok(options.some((option) => option.textContent === "Claude Code（ACP）"));
    assert.ok(options.some((option) => option.textContent === "Codex CLI（ACP）"));
    assert.ok(!options.some((option) => option.textContent === "ACP"));
    assert.ok(native.querySelector('option[value="acp:offline"]:disabled'));
    const acp = render("acp", true, false, "external", "worker");
    assert.equal(acp.querySelector('select')?.value, "acp:worker");
    assert.match(acp.body.textContent!, /ACP model/);
    assert.doesNotMatch(acp.body.textContent!, /Native model|Other model|跟随主模型/);
    assert.match(acp.body.textContent!, /沙箱测试限制/);
    const other = render("acp", true, false, undefined, "other-worker");
    assert.match(other.body.textContent!, /Other model/);
    assert.doesNotMatch(other.body.textContent!, /ACP model/);
    const empty = render("builtin", true, false, undefined, undefined, false);
    assert.equal(empty.querySelector('option[value^="acp:"]'), null);
    assert.match(empty.body.textContent!, /添加外部 Agent/);
    const cli = render("codex", true, false, "custom-id");
    assert.equal(cli.querySelector('input[aria-label="子代理模型 ID"]')?.getAttribute("value"), "custom-id");
    assert.equal(cli.querySelector('[role="combobox"]'), null);
    assert.match(cli.body.textContent!, /路径/);
    assert.equal(render("builtin", false).querySelector('[aria-label="默认子代理"]'), null);
    assert.ok(render("codex", true, true).querySelector('input[aria-label="子代理模型 ID"]:disabled'));
    assert.match(render("acp", true, false, "missing").body.textContent!, /不可用/);
  } finally { await vite.close(); }
});
