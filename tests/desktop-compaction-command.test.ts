/** 压缩命令的异步请求契约；真实窗口交互与视觉由用户验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { useCompactionCommand } from "../src/desktop/renderer/src/app/useCompactionCommand.js";
import { CompactionStatus } from "../src/desktop/renderer/src/components/chat/CompactionStatus.js";
import { CompactionDivider } from "../src/desktop/renderer/src/components/chat/CompactionDivider.js";
import type { DesktopSlashResult } from "../src/desktop/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(execute: Parameters<typeof useCompactionCommand>[0]["execute"]) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  let current!: ReturnType<typeof useCompactionCommand>;
  function Feedback({ projectId, sessionId }: { projectId: string; sessionId?: string }): null {
    current = useCompactionCommand({ projectId, sessionId, execute });
    return null;
  }
  const select = async (sessionId?: string, projectId = "project") => {
    await act(() => root.render(createElement(Feedback, { projectId, sessionId })));
  };
  await select("first");
  return { get current() { return current; }, select, async close() {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

function result(outcome: "compacted" | "unchanged"): DesktopSlashResult {
  return { command: "compact", title: "压缩上下文", content: "result", compaction: { outcome } } as DesktopSlashResult;
}

test("手动压缩在 IPC 完成前显示进行中，同会话重复请求只执行一次", async () => {
  const operation = deferred<DesktopSlashResult>();
  let calls = 0;
  const h = await harness(async () => { calls++; return await operation.promise; });
  let first!: Promise<void>;
  let second!: Promise<void>;
  try {
    await act(() => { first = h.current.run("project", "first", "/compact 记录目标"); });
    assert.equal(h.current.state?.status, "pending");
    assert.equal(h.current.state?.message, "正在压缩上下文");
    await act(() => { second = h.current.run("project", "first", "/compact"); });
    assert.equal(calls, 1);
    await act(async () => { operation.resolve(result("compacted")); await Promise.all([first, second]); });
    assert.equal(h.current.state, undefined, "成功交由持久化聊天分隔条展示");
  } finally {
    operation.resolve(result("compacted"));
    await Promise.allSettled([first, second]);
    await h.close();
  }
});

test("切换会话后旧压缩请求的结果和错误只属于原会话", async () => {
  const operation = deferred<DesktopSlashResult>();
  const h = await harness(async () => await operation.promise);
  let pending!: Promise<void>;
  try {
    await act(() => { pending = h.current.run("project", "first", "/compact"); });
    await h.select("second");
    assert.equal(h.current.state, undefined);
    await act(async () => { operation.reject(new Error("Compaction summary rejected: invalid_evidence")); await pending; });
    assert.equal(h.current.state, undefined);
    await h.select("first");
    assert.equal(h.current.state?.status, "failed");
    assert.match(h.current.state?.message ?? "", /摘要来源校验失败/u);
    await h.select("first", "another-project");
    assert.equal(h.current.state, undefined);
  } finally {
    operation.resolve(result("compacted"));
    await Promise.allSettled([pending]);
    await h.close();
  }
});

test("无需压缩与失败均有可关闭反馈，失败后能够重试", async () => {
  const outcomes = [result("unchanged"), new Error("invalid_structure"), result("compacted")];
  const h = await harness(async () => {
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    assert.ok(next);
    return next;
  });
  try {
    await act(async () => await h.current.run("project", "first", "/compact"));
    assert.deepEqual(h.current.state, { status: "unchanged", message: "本次未压缩，上下文保持原样。" });
    await act(() => h.current.dismiss());
    assert.equal(h.current.state, undefined);
    await act(async () => await h.current.run("project", "first", "/compact"));
    assert.equal(h.current.state?.status, "failed");
    assert.match(h.current.state?.message ?? "", /invalid_structure/u);
    await act(async () => await h.current.run("project", "first", "/compact"));
    assert.equal(h.current.state, undefined);
  } finally { await h.close(); }
});

test("取消事件与 IPC rejection 任意顺序到达均保留取消提示", async () => {
  for (const eventFirst of [true, false]) {
    const operation = deferred<DesktopSlashResult>();
    const h = await harness(async () => await operation.promise);
    let pending!: Promise<void>;
    try {
      await act(() => { pending = h.current.run("project", "first", "/compact"); });
      if (eventFirst) await act(() => h.current.fail("project", "first", "aborted", true));
      await act(async () => { operation.reject(new Error("aborted")); await pending; });
      if (!eventFirst) await act(() => h.current.fail("project", "first", "aborted", true));
      await act(() => h.current.fail("project", "first", "aborted", false));
      assert.deepEqual(h.current.state, { status: "cancelled", message: "上下文压缩已取消" });
    } finally {
      operation.resolve(result("compacted"));
      await Promise.allSettled([pending]);
      await h.close();
    }
  }
});

test("失败反馈可直接重试原压缩指令，外部失败默认重试 /compact", async () => {
  const commands: string[] = [];
  const h = await harness(async (_projectId, _sessionId, command) => {
    commands.push(command);
    if (commands.length === 1) throw new Error("invalid_structure");
    return result("compacted");
  });
  try {
    await act(async () => await h.current.run("project", "first", "/compact 保留测试约束"));
    assert.equal(typeof h.current.retry, "function", "失败提示提供直接重试动作");
    await act(async () => await h.current.retry());
    assert.deepEqual(commands, ["/compact 保留测试约束", "/compact 保留测试约束"]);
    await h.select("second");
    await act(() => h.current.fail("project", "second", "invalid_evidence", false));
    await act(async () => await h.current.retry());
    assert.deepEqual(commands, ["/compact 保留测试约束", "/compact 保留测试约束", "/compact"]);
  } finally { await h.close(); }
});

test("重试开始后旧 attempt 的失败事件不能覆盖新的进行状态", async () => {
  const next = deferred<DesktopSlashResult>();
  let calls = 0;
  const h = await harness(async () => {
    if (++calls === 1) throw new Error("Compaction summary rejected: invalid_structure");
    return await next.promise;
  });
  let retry!: Promise<void>;
  try {
    await act(async () => await h.current.run("project", "first", "/compact"));
    await act(() => { retry = h.current.retry(); });
    await act(() => h.current.fail("project", "first", "old failure", false, "old-run"));
    assert.equal(h.current.state?.status, "pending", "新 attempt 关联 started 前不消费带旧 runId 的失败");
    await act(() => h.current.start("project", "first", "new-run"));
    await act(() => h.current.fail("project", "first", "old failure", false, "old-run"));
    assert.equal(h.current.state?.status, "pending");
    await act(async () => { next.resolve(result("compacted")); await retry; });
    assert.equal(h.current.state, undefined);
  } finally {
    next.resolve(result("compacted"));
    await Promise.allSettled([retry]);
    await h.close();
  }
});

test("外部新压缩开始时清除上一轮取消反馈，新失败仍然可见", async () => {
  const h = await harness(async () => result("compacted"));
  try {
    await act(() => h.current.start("project", "first", "old-run"));
    await act(() => h.current.fail("project", "first", "aborted", true, "old-run"));
    assert.equal(h.current.state?.status, "cancelled");
    await act(() => h.current.start("project", "first", "new-run"));
    assert.equal(h.current.state, undefined, "外部运行的进度由 Runtime snapshot 驱动，不挂本地 pending");
    await act(() => h.current.fail("project", "first", "Compaction summary rejected: invalid_structure", false, "new-run"));
    assert.equal(h.current.state?.message, "摘要结构不完整，原上下文已保留。");
  } finally { await h.close(); }
});

test("重试在旧 IPC 失败后开始，延迟批次中的旧取消不能覆盖新 run 的失败", async () => {
  const next = deferred<DesktopSlashResult>();
  let calls = 0;
  const h = await harness(async () => {
    if (++calls === 1) throw new Error("aborted");
    return await next.promise;
  });
  let retry!: Promise<void>;
  try {
    await act(async () => await h.current.run("project", "first", "/compact"));
    await act(() => { retry = h.current.retry(); });
    await act(() => {
      h.current.start("project", "first", "old-run");
      h.current.fail("project", "first", "aborted", true, "old-run");
      h.current.start("project", "first", "new-run");
      h.current.fail("project", "first", "Compaction summary rejected: invalid_structure", false, "new-run");
    });
    await act(async () => {
      next.reject(new Error("Compaction summary rejected: invalid_structure"));
      await retry;
    });
    assert.equal(h.current.state?.status, "failed");
    assert.equal(h.current.state?.message, "摘要结构不完整，原上下文已保留。");
  } finally {
    next.resolve(result("compacted"));
    await Promise.allSettled([retry]);
    await h.close();
  }
});

test("已知压缩错误显示中文原因，持久化错误要求重新打开会话", async () => {
  const h = await harness(async () => result("compacted"));
  try {
    for (const [kind, message] of [
      ["invalid_structure", "摘要结构不完整，原上下文已保留。"],
      ["invalid_evidence", "摘要来源校验失败，原上下文已保留。"],
      ["output_truncated", "摘要超出输出长度，原上下文已保留。"],
      ["input_budget", "摘要模型的输入容量不足，请检查模型容量或减少待压缩内容。"]
    ]) {
      await act(() => h.current.fail("project", "first", `Compaction summary rejected: ${kind}`, false));
      assert.equal(h.current.state?.message, message);
    }
    await act(() => h.current.fail("project", "first", "Checkpoint persistence failed; close and reopen this session before continuing.", false));
    assert.equal(h.current.state?.message, "压缩结果保存失败，请关闭并重新打开会话后重试。");
    assert.equal(h.current.state?.retryable, false);
    await act(() => h.current.fail("project", "first", "Provider service unavailable", false));
    assert.equal(h.current.state?.message, "上下文压缩失败：Provider service unavailable");
  } finally { await h.close(); }
});

test("压缩过程和失败反馈具有可访问状态，成功分隔条展示数量与展开入口", () => {
  const pending = renderToStaticMarkup(createElement(CompactionStatus, { state: { status: "pending", message: "正在压缩上下文" } }));
  assert.match(pending, /role="status"/u);
  assert.match(pending, /aria-busy="true"/u);
  assert.match(pending, /正在压缩上下文/u);
  assert.doesNotMatch(pending, /关闭压缩提示/u);
  const failed = renderToStaticMarkup(createElement(CompactionStatus, { state: { status: "failed", message: "上下文压缩失败：invalid_evidence" }, onDismiss() {}, onRetry() {} }));
  assert.match(failed, /role="alert"/u);
  assert.match(failed, /invalid_evidence/u);
  assert.match(failed, /aria-label="关闭压缩提示"/u);
  assert.match(failed, /aria-label="重试压缩"/u);
  const completed = renderToStaticMarkup(createElement(CompactionDivider, { count: 12, savedTokens: 2400, summary: "## 当前目标\n继续修复。" }));
  assert.match(completed, /上下文已压缩/u);
  assert.match(completed, /12 条消息已摘要/u);
  assert.match(completed, /2,400 tokens/u);
  assert.match(completed, /aria-expanded="false"/u);
  assert.match(completed, /aria-controls="[^"]+"/u);
  assert.doesNotMatch(completed, /disabled/u);
  const empty = renderToStaticMarkup(createElement(CompactionDivider, {}));
  assert.match(empty, /disabled=""/u);
  assert.doesNotMatch(empty, /aria-expanded|条消息已摘要|tokens/u);
});
