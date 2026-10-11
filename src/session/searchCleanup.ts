import { Worker } from "node:worker_threads";

// 固定源码兼容 CLI 与 Desktop 打包；路径和会话 ID 只通过 workerData 传入。
const workerSource = `
const { workerData } = require("node:worker_threads");
const { statSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
if (statSync(workerData.databasePath, { throwIfNoEntry: false })) {
  const database = new DatabaseSync(workerData.databasePath, { timeout: 5000 });
  try {
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_transcripts', 'session_index_state')"
    ).all().map(row => row.name));
    if (tables.size) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (tables.has("session_transcripts")) database.prepare("DELETE FROM session_transcripts WHERE session_id = ?").run(workerData.sessionId);
        if (tables.has("session_index_state")) database.prepare("DELETE FROM session_index_state WHERE session_id = ?").run(workerData.sessionId);
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
`;

let pendingDeletions = 0;
let deletionTail = Promise.resolve();

/** 全文表扫描与 SQLite 等锁留在工作线程；同一进程只运行一个清理线程。 */
export async function deleteSessionSearchRows(databasePath: string, sessionId: string): Promise<void> {
  if (pendingDeletions >= 500) throw new Error("Too many pending session index deletions.");
  pendingDeletions += 1;
  const task = deletionTail.then(async () => await new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      env: {},
      workerData: { databasePath, sessionId },
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
