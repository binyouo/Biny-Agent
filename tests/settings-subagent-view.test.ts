import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { JSDOM } from "jsdom";

test("Coding Agent settings show configured ACP providers and keep disabled or busy choices unavailable", async () => {
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
        createElement(SettingsSubagent, { onOpenProviders() {} })))).window.document;
    };
    const native = render("builtin");
    assert.equal(native.querySelector('[aria-label="默认 Coding Agent"]')?.value, "builtin");
    assert.deepEqual([...native.querySelectorAll<HTMLSelectElement>('[aria-label="默认 Coding Agent"] option')].map(option => option.textContent),
      ["自动", "Claude Code", "内置 Agent", "Claude Code", "Codex CLI", "Offline"]);
    assert.equal(native.querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"] option[value="acp:offline"]')?.disabled, true);
    assert.match(native.body.textContent!, /ACP Providers: 3/u);
    assert.match(native.body.textContent!, /沿用当前聊天模型/);
    assert.doesNotMatch(native.body.textContent!, /沙箱测试限制/);
    assert.match(render("auto").body.textContent!, /优先.*Claude Code/);
    const acp = render("acp", true, false, undefined, "worker");
    assert.equal(acp.querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"]')?.value, "acp:worker");
    assert.match(acp.body.textContent!, /沙箱测试限制/);
    assert.equal(render("acp", true, false, undefined, "other-worker").querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"]')?.value, "acp:other-worker");
    assert.doesNotMatch(render("builtin", true, false, undefined, undefined, false).body.textContent!, /添加外部 Agent|管理 Agent 连接|ACP Providers: [1-9]/u);
    const cli = render("codex", true, false, "custom-id");
    assert.equal(cli.querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"]')?.value, "auto");
    assert.equal(cli.querySelector('input'), null);
    assert.match(cli.body.textContent!, /直接使用本地安装的 Claude Code CLI/u);
    assert.ok(render("codex", true, true).querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"]:disabled'));
    assert.equal(render("acp", true, false, "missing").querySelector<HTMLSelectElement>('[aria-label="默认 Coding Agent"]')?.value, "auto");
  } finally { await vite.close(); }
});
