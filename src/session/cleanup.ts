/**
 * 会话生命周期清理。
 *
 * 一个会话的事实、目录索引和运行旁路状态分散在不同文件中；删除只能从这里走，避免只删掉
 * JSONL 后留下 catalog、断点或历史 run 继续出现在列表和恢复流程里。
 */
import { realpath } from "node:fs/promises";
import { projectSessionsDir } from "../config/paths.js";
import { deleteSessionCatalogRecord } from "./catalog.js";
import { deleteInterruptedTurn } from "./turnStore.js";
import { RecipeStateStore } from "./recipes.js";
import { deleteSessionFile, SessionNotFoundError } from "./store.js";
import { SessionSearchIndex } from "./searchIndex.js";
import { openSessionSummaryProjection } from "./summaryProjection.js";

export async function deleteSessionArtifacts(persistenceRoot: string, sessionId: string): Promise<void> {
  // A failed canonical deletion must not strip a retained conversation's privacy
  // policy or recovery checkpoint. Only confirmed absence permits orphan cleanup.
  let firstError: unknown;
  let sourcePath: string | undefined;
  try {
    await deleteSessionFile(persistenceRoot, sessionId, {
      beforeTombstoneMove: async ({ filePath }) => { sourcePath = filePath; }
    });
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) throw error;
    firstError = error;
  }
  // Once the transcript is removed (or known absent), attempt every sidecar cleanup
  // and preserve the first error so a failed step cannot conceal remaining state.
  for (const step of [
    () => deleteSessionCatalogRecord(persistenceRoot, sessionId),
    async () => {
      const projection = await openSessionSummaryProjection(persistenceRoot, false);
      try { projection?.forget(`${sessionId}.jsonl`); }
      finally { projection?.close(); }
    },
    () => deleteInterruptedTurn(persistenceRoot, sessionId),
    async () => await new RecipeStateStore(persistenceRoot).clear(sessionId),
    async () => await new SessionSearchIndex().forgetSession(sessionId, sourcePath
      ? { sourcePath }
      : { sourceRoot: projectSessionsDir(await realpath(persistenceRoot)) })
  ]) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
