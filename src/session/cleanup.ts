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
import { deleteSessionFile } from "./store.js";
import { SessionSearchIndex } from "./searchIndex.js";

export async function deleteSessionArtifacts(persistenceRoot: string, sessionId: string): Promise<void> {
  // 每步独立容错：一个产物删除失败（比如 JSONL 已被并发删掉）不能阻止其余产物的清理，
  // 否则会话会留在半删除状态。全部尝试完后抛出首个错误，让调用方知道有残留。
  let firstError: unknown;
  let sourcePath: string | undefined;
  for (const step of [
    () => deleteSessionFile(persistenceRoot, sessionId, {
      beforeTombstoneMove: async ({ filePath }) => { sourcePath = filePath; }
    }),
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
