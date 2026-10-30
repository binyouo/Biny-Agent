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
import { deleteSessionFile, SessionFileNotFoundError } from "./store.js";
import { SessionSearchIndex } from "./searchIndex.js";

export async function deleteSessionArtifacts(persistenceRoot: string, sessionId: string): Promise<void> {
  // Only a successful transcript removal or validated absence permits destructive
  // sidecar cleanup. Other failures may leave a recoverable transcript/tombstone.
  let firstError: unknown;
  let sourcePath: string | undefined;
  try {
    await deleteSessionFile(persistenceRoot, sessionId, {
      beforeTombstoneMove: async ({ filePath }) => { sourcePath = filePath; }
    });
  } catch (error) {
    if (!(error instanceof SessionFileNotFoundError)) throw error;
    firstError = error;
  }
  // Once deletion is established, attempt every sidecar and preserve the first error.
  for (const step of [
    () => deleteSessionCatalogRecord(persistenceRoot, sessionId),
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
