import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsDraftContext, type SettingsDraftContextValue } from "../src/desktop/renderer/src/components/settings/SettingsDraftContext.js";

const imports = registerHooks({ load(url, context, next) {
  if (/\.(svg|png|css)$/u.test(url)) return { format: "module", source: 'export default "asset";', shortCircuit: true };
  return next(url, context);
} });
const { ProviderSettings } = await import("../src/desktop/renderer/src/components/settings/ProviderSettings.js");
const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.assign(globalThis, { React });

function renderConnection(enabled: boolean, providerType: "openai-compatible" | "deepseek" = "openai-compatible", hasCredential = true, modelCount = 0): string {
  const context = { draft: { models: { upserts: [], removeAliases: [], oauthCredentialHandles: [], modelProfiles: {} } } } as unknown as SettingsDraftContextValue;
  const unavailable = async (): Promise<never> => { throw new Error("Rendering must not perform an operation"); };
  return renderToStaticMarkup(React.createElement(SettingsDraftContext.Provider, { value: context },
    React.createElement(ProviderSettings, {
      active: true, loading: false, models: Array.from({ length: modelCount }, (_, index) => ({
        alias: `relay-${index}`, displayName: `Model ${index}`, provider: "relay", providerType: "openai-compatible", model: `model-${index}`, modelKey: `relay/model-${index}`,
        efforts: [], defaultThinking: "off" as const, thinkingLevelMap: {}, available: true, source: "configured" as const
      })), catalogs: {}, projectId: "project",
      connections: [{ providerAlias: providerType === "deepseek" ? "deepseek" : "relay", providerType, baseUrl: providerType === "deepseek" ? "https://api.deepseek.com" : "https://relay.invalid/v1", enabled, requiresApiKey: true, hasCredential, credentialSource: hasCredential ? "keychain" : undefined }],
      onTest: unavailable, onFetchCatalog: unavailable, onReadModelApiKey: unavailable,
      onStartLogin: unavailable, onCompleteLogin: unavailable, onCancelLogin: unavailable,
      onNotify: () => undefined, onOpenExternal: unavailable
    })));
}

test("零模型连接展示下一步和可操作的供应商开关；已有覆盖只验证模型列表，不保护首次配置", () => {
  const html = renderConnection(true);
  assert.match(html, /尚未选择模型/u);
  const toggle = html.match(/<button[^>]*aria-label="停用整个服务商"[^>]*>/u)?.[0];
  assert.ok(toggle);
  assert.doesNotMatch(toggle, /disabled/u);
  assert.match(html, /获取模型/u);
  assert.match(html, /手动添加/u);
  assert.match(html, /先获取或添加模型/u);
});

test("连接测试显示文字名称且保留禁用语义，不能再依赖星形图标表达操作", () => {
  const html = renderConnection(true);
  const button = html.match(/<button[^>]*aria-label="测试连接"[^>]*>[\s\S]*?<\/button>/u)?.[0];
  assert.ok(button);
  assert.match(button, /<span>测试<\/span>/u);
  assert.match(button, /disabled/u, "没有模型时仍不可发起测试");
});

test("多模型测试入口保留下拉状态，且实际按钮不再匹配全局圆形几何规则", () => {
  const css = readFileSync(new URL("../src/desktop/renderer/src/styles/icon-buttons.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<style>${css}</style>${renderConnection(true, "openai-compatible", true, 2)}`);
  try {
    const button = dom.window.document.querySelector('button[aria-label="测试连接"]')!;
    assert.equal(button.textContent, "测试");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(button.hasAttribute("disabled"), false);
    assert.ok(button.querySelector(".provider-test-caret"));
    for (const rule of dom.window.document.styleSheets[0]!.cssRules) {
      if (rule instanceof dom.window.CSSStyleRule && rule.style.getPropertyValue("border-radius") === "50%") {
        assert.equal(button.matches(rule.selectorText), false, "文字按钮不能被圆形控件样式挤压");
      }
    }
  } finally { dom.window.close(); }
});

for (const enabled of [true, false]) {
  test(`零模型连接状态颜色由供应商启用状态决定，不能由模型选择或远端健康推导 enabled=${enabled}`, () => {
    const html = renderConnection(enabled);
    assert.match(html, enabled ? /status-pill is-ok[^>]*>已启用/u : /status-pill is-muted[^>]*>已停用/u);
    assert.match(html, enabled ? /aria-checked="true" aria-label="停用整个服务商"/u : /aria-checked="false" aria-label="启用整个服务商"/u);
    if (!enabled) assert.match(html, /请先启用服务商，再测试模型请求/u);
  });
}

test("空模型面板只呈现添加引导，连接地址与协议默认收起；保护紧凑的首次配置流程", () => {
  const html = renderConnection(true);
  assert.doesNotMatch(html, /aria-label="搜索模型"/u);
  assert.match(html, /<details class="provider-endpoint-details">/u);
  assert.match(html, /API 端点/u);
});

test("内置服务商也提供默认收起的端点设置，常用密钥和模型保持可见", () => {
  const html = renderConnection(true, "deepseek");
  assert.ok(/<details class="provider-endpoint-details">/u.test(html), "built-in endpoints should be accessible in a disclosure");
  assert.ok(/服务地址/u.test(html));
  assert.ok(/API 格式/u.test(html));
});

test("停用状态优先展示，缺少密钥不会把停用连接标成已启用故障", () => {
  const html = renderConnection(false, "openai-compatible", false);
  assert.ok(/status-pill is-muted[^>]*>已停用/u.test(html), "disabled provider should retain its explicit status");
});

test("已保存密钥只显示打码输入，不展示存储说明或删除入口；已有覆盖未保护密钥区域的简化展示", () => {
  const html = renderConnection(true);
  const input = html.match(/<input[^>]*id="[^"]*-api-key"[^>]*>/u)?.[0];
  assert.ok(input);
  assert.match(input, /type="password"/u);
  assert.match(input, /placeholder="••••••••"/u);
  assert.doesNotMatch(html, /已存入 macOS 钥匙串|修改后自动保存|删除已保存密钥|再次点击确认删除密钥/u);
});

test.after(() => {
  imports.deregister();
  if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
  else Reflect.deleteProperty(globalThis, "React");
});
