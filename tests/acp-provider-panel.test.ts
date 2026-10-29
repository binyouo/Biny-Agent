import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { AcpProviderPanel } from "../src/desktop/renderer/src/components/settings/AcpProviderPanel.js";
import { providerCatalog } from "../src/desktop/renderer/src/providerCatalog.js";
import { acpConfigSchema } from "../src/acp/config.js";
import type { DesktopModelConfigurationInput } from "../src/desktop/protocol.js";

const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
Object.assign(globalThis, { React });
const unavailable = async (): Promise<never> => { throw new Error("Rendering cannot start or save an Agent"); };

// 捕获 React 元素公开的回调，直接验证业务动作；不生成点击事件或替代人工界面验收。
function connectionAction(props: React.ComponentProps<typeof AcpProviderPanel>): () => Promise<void> {
  let action: (() => Promise<void>) | undefined;
  const currentReact = Reflect.get(globalThis, "React");
  Object.assign(globalThis, { React: { ...React, createElement(type: React.ElementType, attributes: Record<string, unknown> | null, ...children: React.ReactNode[]) {
    if (type === "button" && String(attributes?.className ?? "").split(/\s+/u).includes("settings-primary-button")) action = attributes.onClick as () => Promise<void>;
    return React.createElement(type, attributes, ...children);
  } } });
  try { renderToStaticMarkup(React.createElement(AcpProviderPanel, props)); }
  finally { Object.assign(globalThis, { React: currentReact }); }
  assert.ok(action);
  return action;
}

test("preset connection probes once before saving; failures and duplicate invocations never write settings", { timeout: 3000 }, async () => {
  const catalog = providerCatalog.find((item) => item.id === "codex-acp")!;
  const saved: DesktopModelConfigurationInput[] = [];
  let release!: (value: { ok: boolean; message: string }) => void;
  let probes = 0;
  const connect = connectionAction({ catalog,
    onTest: async () => { probes++; return await new Promise((resolve) => { release = resolve; }); },
    onSave: async (input) => { saved.push(input); return true; }
  });
  const first = connect();
  const duplicate = connect();
  assert.equal(probes, 1);
  await duplicate;
  assert.deepEqual(saved, []);
  release({ ok: false, message: "not logged in" });
  await first;
  assert.deepEqual(saved, [], "failed probe cannot save a broken connection");
  const second = connect();
  release({ ok: true, message: "connected" });
  await second;
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.model, "default");
  assert.equal(saved[0]!.acp?.command, "codex-acp");
  assert.equal(saved[0]!.acp?.allowMemory, false);
  assert.deepEqual(saved[0]!.acp?.mcpServers, []);
  assert.equal(saved[0]!.acp?.authMethodId, undefined);
});

for (const id of ["claude-code-acp", "codex-acp"]) {
  test(`${id} preset needs no technical fields before connecting; previous ACP tests only covered the backend`, () => {
    const catalog = providerCatalog.find((item) => item.id === id)!;
    const dom = new JSDOM(renderToStaticMarkup(React.createElement(AcpProviderPanel, { catalog, onTest: unavailable, onSave: unavailable })));
    try {
      const document = dom.window.document;
      const advanced = document.querySelector("details.acp-advanced");
      assert.ok(advanced, "preset launch fields belong in advanced settings");
      assert.equal(advanced.hasAttribute("open"), false);
      assert.match(advanced.textContent!, /启动命令/u);
      advanced.remove();
      assert.doesNotMatch(document.body.textContent!, /JSON|认证方式 ID|连接名称|MCP 服务名/u);
      assert.match(document.body.textContent!, /连接并保存/u);
      assert.match(document.body.textContent!, /复制安装命令/u);
      assert.match(document.body.textContent!, /复制登录命令/u);
      assert.equal(document.querySelector('[role="switch"]')?.getAttribute("aria-checked"), "false");
    } finally { dom.window.close(); }
  });
}

test("custom ACP exposes its startup fields and cannot inherit another Agent's login commands", () => {
  const catalog = providerCatalog.find((item) => item.id === "custom-acp")!;
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(AcpProviderPanel, { catalog, onTest: unavailable, onSave: unavailable })));
  try {
    assert.ok(dom.window.document.querySelector("details.acp-advanced[open]"));
    assert.equal(dom.window.document.querySelector(".acp-setup"), null);
    assert.ok(dom.window.document.querySelector('button.settings-primary-button[disabled]'));
  } finally { dom.window.close(); }
});

test("a saved preset with a custom launch retains its configuration and hides misleading preset commands", () => {
  const catalog = providerCatalog.find((item) => item.id === "codex-acp")!;
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(AcpProviderPanel, {
    catalog, onTest: unavailable, onSave: unavailable, currentModel: "custom-model",
    connection: { providerAlias: "codex-acp", providerType: "acp", enabled: true, requiresApiKey: false, hasCredential: false,
      acp: acpConfigSchema.parse({ command: "/opt/custom agent/bin/acp", args: ["--private"], env: { HOME: "ACP_HOME" }, modeId: "ask" }) }
  })));
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector(".acp-setup"), null);
    const values = [...document.querySelectorAll("input")].map((input) => input.value);
    assert.ok(values.includes("/opt/custom agent/bin/acp"));
    assert.ok(values.includes('["--private"]'));
    assert.ok(values.includes('{"HOME":"ACP_HOME"}'));
    assert.equal(document.querySelector('option[value="custom-model"]')?.hasAttribute("selected"), true);
    assert.equal(document.querySelector('option[value="ask"]')?.hasAttribute("selected"), true);
  } finally { dom.window.close(); }
});

test.after(() => {
  if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
  else Reflect.deleteProperty(globalThis, "React");
});
