/** 删除会话不能被仍在读取旧 JSONL 的历史检索重新收录。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHistoryTools } from "../src/extensions/history.js";
import { deleteSessionArtifacts } from "../src/session/cleanup.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";
import { ensureAgentDirs } from "../src/session/store.js";

for (const checkpoint of ["initial", "zero-offset", "incremental"] as const) {
  test(`会话删除完成后，已读取但尚未提交的历史扫描不能复活旧消息（${checkpoint}）`, { timeout: 10_000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-search-lifecycle-"));
    const workspace = path.join(root, "workspace");
    const agentRoot = path.join(root, "agent");
    const previousAgentRoot = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = agentRoot;
    await fs.mkdir(workspace);
    await ensureAgentDirs(workspace);
    const recorder = new SessionRecorder(workspace, "deleted-history-session");
    recorder.record({ type: "user_message", messageId: "deleted-message", content: "deleted history marker" });
    await recorder.close();
    const index = new SessionSearchIndex(agentRoot);
    if (checkpoint === "zero-offset") {
      const complete = await fs.readFile(recorder.filePath);
      await fs.writeFile(recorder.filePath, complete.subarray(0, 10));
      await index.indexSessionFile(recorder.sessionId, recorder.filePath);
      assert.equal(index.status().indexedSessions, 1, "a partial first line can leave a zero-offset checkpoint");
      assert.equal(index.status().indexedMessages, 0);
      await fs.writeFile(recorder.filePath, complete);
    } else if (checkpoint === "incremental") {
      await index.indexSessionFile(recorder.sessionId, recorder.filePath);
      await fs.appendFile(recorder.filePath, `${JSON.stringify({
        type: "assistant_message", content: "deleted history marker followup", messageId: "deleted-followup"
      })}\n`);
    }
    const retained = new SessionRecorder(workspace, "retained-history-session");
    retained.record({ type: "user_message", content: "retained history marker", messageId: "retained-message" });
    await retained.close();
    await index.indexSessionFile(retained.sessionId, retained.filePath);
    const [tool] = createHistoryTools({ getIndex: () => index });
    assert.ok(tool);
    const execution = await tool.resolveExecution({ query: "deleted history marker" });
    assert.ok(!("isError" in execution));

    const buffered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalOpen = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await Reflect.apply(originalOpen, fs, args);
      if (String(args[0]) === recorder.filePath && args[1] === "r") {
        const originalRead = handle.read;
        t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await Reflect.apply(originalRead, handle, readArgs);
          buffered.resolve();
          await resume.promise;
          return result;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const search = execution.execute({ toolCallId: "delete-race", operationId: "delete-race" });
    try {
      await buffered.promise;
      await deleteSessionArtifacts(workspace, recorder.sessionId);
      assert.equal(index.status().indexedMessages, 1, "cleanup removes only the deleted session’s derived search rows");
      resume.resolve();
      const result = await search as { hits: unknown[] };
      assert.deepEqual(result.hits, [], "the public history tool must not return a successfully deleted session");
      await index.refreshAll();
      assert.equal(index.search("deleted history marker").length, 0, "later refreshes must not retain resurrected messages");
      assert.equal(index.status().indexedMessages, 1);
      assert.equal(index.search("retained history marker")[0]?.sessionId, retained.sessionId);
    } finally {
      resume.resolve();
      await search.catch(() => undefined);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      index.close();
      if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const existing of [false, true]) {
  for (const mutation of ["replace", "truncate", "append"] as const) {
    test(`已读取的批次提交前文件发生 ${mutation}（已有偏移：${existing}），最终索引仍对应有效原文`, { timeout: 10_000 }, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-search-mutation-"));
      const file = path.join(root, "sessions", "changing.jsonl");
      const row = (content: string): string => `${JSON.stringify({ type: "user_message", content })}\n`;
      const before = row("original marker") + (mutation === "truncate" ? row("discarded marker") : "");
      const after = row("updatedx marker") + (existing && mutation === "replace" ? row("newextra marker") : "");
      assert.equal(row("original marker").length, row("updatedx marker").length, "replacement rows retain the original byte length");
      await fs.mkdir(path.dirname(file));
      const index = new SessionSearchIndex(root);
      if (existing) {
        await fs.writeFile(file, row("previous marker"));
        await index.indexSessionFile("changing", file);
        await fs.appendFile(file, before);
      } else {
        await fs.writeFile(file, before);
      }
      const buffered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalOpen = fs.open;
      let paused = false;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await Reflect.apply(originalOpen, fs, args);
        if (String(args[0]) === file && args[1] === "r" && !paused) {
          paused = true;
          const originalRead = handle.read;
          t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
            const result = await Reflect.apply(originalRead, handle, readArgs);
            buffered.resolve();
            await resume.promise;
            return result;
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      const refresh = index.refreshAll();
      try {
        await buffered.promise;
        if (mutation === "replace") {
          const replacement = path.join(root, "replacement.jsonl");
          await fs.writeFile(replacement, after);
          await fs.rename(replacement, file);
        } else if (mutation === "truncate") {
          await fs.writeFile(file, after);
        } else {
          await fs.appendFile(file, after);
        }
        resume.resolve();
        await refresh;
        if (mutation === "append") {
          assert.equal(index.search("original marker").length, 1, "ordinary growth keeps the already-read batch valid");
        } else {
          assert.equal(index.search("original marker").length, 0, "superseded bytes cannot be published");
          assert.equal(index.search("updatedx marker").length, 1, "the reader retries against the live source");
        }
        await index.refreshAll();
        assert.equal(index.search("updatedx marker").length, 1);
        assert.equal(index.search("discarded marker").length, 0);
        assert.equal(index.search("previous marker").length, existing && mutation === "append" ? 1 : 0);
        assert.equal(index.status().indexedMessages, mutation === "append" ? (existing ? 3 : 2) : (existing && mutation === "replace" ? 2 : 1));
      } finally {
        resume.resolve();
        await refresh.catch(() => undefined);
        t.mock.restoreAll();
        syncBuiltinESMExports();
        index.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}
