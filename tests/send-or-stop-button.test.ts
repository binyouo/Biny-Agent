/** 桌面聊天输入区发送/停止按钮的状态契约。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SendOrStopButton } from "../src/desktop/renderer/src/components/composer/SendOrStopButton.js";

const handlers = {
  onSend: () => undefined,
  onStop: () => undefined
};

test("运行中空输入显示暂停按钮", () => {
  const markup = renderToStaticMarkup(createElement(SendOrStopButton, {
    ...handlers,
    disabled: true,
    hasDraft: false,
    running: true,
    stopPending: false
  }));

  assert.match(markup, /aria-label="暂停生成"/u);
  assert.match(markup, /biny-send-button is-stop/u);
  assert.doesNotMatch(markup, /disabled=""/u);
});

test("运行中输入下一条消息后并列显示暂停和排队发送按钮", () => {
  const markup = renderToStaticMarkup(createElement(SendOrStopButton, {
    ...handlers,
    disabled: false,
    hasDraft: true,
    running: true,
    stopPending: false
  }));

  assert.match(markup, /aria-label="加入队列"/u);
  assert.match(markup, /点「插话」立即注入本轮/u);
  assert.match(markup, /aria-label="暂停生成"/u);
  assert.match(markup, /is-stop/u);
  assert.doesNotMatch(markup, /disabled=""/u);
});

test("非运行态没有可发送内容时禁用发送按钮", () => {
  const markup = renderToStaticMarkup(createElement(SendOrStopButton, {
    ...handlers,
    disabled: true,
    hasDraft: false,
    running: false,
    stopPending: false
  }));

  assert.match(markup, /aria-label="发送消息"/u);
  assert.match(markup, /aria-disabled="true"/u);
});
