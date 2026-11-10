import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDir, isHeartbeatSessionId, listSessionFilePaths, sessionFilePath, sessionIdFromFile } from "../session/store.js";

/** 调用方持有项目的心跳租约；绑定只在首次接入或原会话已删除时变化。 */
export async function resolveHeartbeatSessionId(persistenceRoot: string): Promise<string> {
  const bindingPath = path.join(agentDir(persistenceRoot), "heartbeat-session");
  let bound: string | undefined;
  try {
    bound = (await fs.readFile(bindingPath, "utf8")).trim();
    if (!isHeartbeatSessionId(bound)) throw new Error("Invalid heartbeat session binding.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (bound) {
    try {
      await fs.stat(sessionFilePath(persistenceRoot, bound));
      return bound;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // 没有绑定的旧版本只接续最新的一条；明确删除过的绑定不能复活更早的历史。
  const legacy = bound ? [] : await Promise.all((await listSessionFilePaths(persistenceRoot))
    .filter(file => isHeartbeatSessionId(sessionIdFromFile(file)))
    .map(async file => ({ id: sessionIdFromFile(file), modified: (await fs.stat(file)).mtimeMs })));
  legacy.sort((a, b) => b.modified - a.modified || b.id.localeCompare(a.id));
  const id = legacy[0]?.id ?? `heartbeat-${randomUUID()}`;
  const temporary = `${bindingPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${id}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, bindingPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return id;
}
