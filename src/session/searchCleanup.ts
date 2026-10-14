import { Worker } from "node:worker_threads";
import path from "node:path";

export type SessionSearchCleanupScope = { sourcePath: string } | { sourceRoot: string };

// 固定源码兼容 CLI 与 Desktop 打包；路径和会话 ID 只通过 workerData 传入。
const workerSource = `
const { workerData } = require("node:worker_threads");
const { statSync } = require("node:fs");
const { sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
if (statSync(workerData.databasePath, { throwIfNoEntry: false })) {
  const databaseUrl = pathToFileURL(workerData.databasePath);
  databaseUrl.searchParams.set("mode", "rw");
  let database;
  try {
    database = new DatabaseSync(databaseUrl, { timeout: 5000 });
  } catch (error) {
    if (statSync(workerData.databasePath, { throwIfNoEntry: false })) throw error;
  }
  if (database) {
    try {
      const tables = new Set(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_transcripts', 'transcript_rows', 'session_index_state')"
      ).all().map(row => row.name));
      if (tables.size) {
        if (tables.size !== 3) throw new Error("Session search index schema is incomplete.");
        database.exec("BEGIN IMMEDIATE");
        try {
          const scope = workerData.scope;
          const prefix = "sourceRoot" in scope ? scope.sourceRoot.replace(/[\\\\/]+$/, "") + sep : undefined;
          const sources = prefix === undefined
            ? database.prepare("SELECT source_path FROM session_index_state WHERE session_id = ? AND source_path = ?").all(workerData.sessionId, scope.sourcePath)
            : database.prepare("SELECT source_path FROM session_index_state WHERE session_id = ? AND substr(source_path, 1, length(?)) = ?").all(workerData.sessionId, prefix, prefix);
          const deleteTranscripts = database.prepare("DELETE FROM session_transcripts WHERE rowid IN (SELECT rowid FROM transcript_rows WHERE source_path = ?)");
          const deleteRows = database.prepare("DELETE FROM transcript_rows WHERE source_path = ?");
          const deleteState = database.prepare("DELETE FROM session_index_state WHERE source_path = ?");
          for (const source of sources) {
            deleteTranscripts.run(source.source_path);
            deleteRows.run(source.source_path);
            deleteState.run(source.source_path);
          }
          database.exec("COMMIT");
        } catch (error) {
          try { database.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
    } finally {
      database.close();
    }
  }
}
`;

let pendingDeletions = 0;
let deletionTail = Promise.resolve();

/** 行删除与 SQLite 等锁留在工作线程；同一进程只运行一个清理线程。 */
export async function deleteSessionSearchRows(databasePath: string, sessionId: string, scope: SessionSearchCleanupScope): Promise<void> {
  const source = "sourcePath" in scope ? scope.sourcePath : scope.sourceRoot;
  if (!path.isAbsolute(source)) throw new Error("Session index deletion requires an absolute source path.");
  if (pendingDeletions >= 500) throw new Error("Too many pending session index deletions.");
  pendingDeletions += 1;
  const task = deletionTail.then(async () => await new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      env: {},
      workerData: { databasePath, sessionId, scope },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }
    });
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure ??= new Error("Session index deletion timed out.");
      void worker.terminate();
    }, 30_000);
    worker.once("error", error => { failure ??= error; });
    // 等实际退出才释放队列，成功和失败都不遗留连接或后台写入。
    worker.once("exit", code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Session index deletion worker exited (${String(code)}).`));
      else resolve();
    });
  })).finally(() => { pendingDeletions -= 1; });
  deletionTail = task.catch(() => undefined);
  await task;
}
