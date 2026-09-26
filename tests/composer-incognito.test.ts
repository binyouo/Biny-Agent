/** 无痕开关的只读渲染契约；真实 Desktop 视觉和交互仍由用户人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IncognitoToggle } from "../src/desktop/renderer/src/components/composer/IncognitoToggle.js";

const noOp = async (): Promise<void> => undefined;
const baseProps: React.ComponentProps<typeof IncognitoToggle> = {
  enabled: false, busy: false, disabled: false, onToggle: noOp
};

test("Composer projects incognito state and busy reason in its toggle", () => {
  const available = renderToStaticMarkup(React.createElement(IncognitoToggle, baseProps));
  assert.match(available, /aria-label="开启当前聊天无痕模式"/u);
  assert.match(available, /aria-pressed="false"/u);

  const active = renderToStaticMarkup(React.createElement(IncognitoToggle, {
    ...baseProps, enabled: true, busy: true,
    disabled: true, disabledReason: "当前运行尚未结束"
  }));
  assert.match(active, /aria-label="关闭当前聊天无痕模式"/u);
  assert.match(active, /aria-pressed="true"/u);
  assert.match(active, /当前运行尚未结束/u);
});
