/** Desktop 持有的本机 Activity REST 入口：发布地址发现文件。 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { globalAgentDir } from "../config/paths.js";
import { startActivityHttpServer, type ActivityHttpApiDependencies, type ActivityHttpServer } from "./httpServer.js";

export interface ActivityHttpEndpoint extends ActivityHttpServer {
  discoveryPath: string;
}

export async function startActivityHttpEndpoint(deps: ActivityHttpApiDependencies): Promise<ActivityHttpEndpoint> {
  const agentDir = deps.agentDir ?? globalAgentDir();
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await chmod(agentDir, 0o700);
  const discoveryPath = path.join(agentDir, "activity-api.json");
  const tempPath = path.join(agentDir, `.activity-api-${randomUUID()}.tmp`);
  const instanceId = randomUUID();
  const server = await startActivityHttpServer(deps);
  try {
    await writeFile(tempPath, JSON.stringify({ host: server.host, port: server.port, token: server.token, instanceId, pid: process.pid }), {
      mode: 0o600,
      flag: "wx"
    });
    await rename(tempPath, discoveryPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    await server.close();
    throw error;
  }
  return {
    ...server,
    discoveryPath,
    close: async () => {
      try {
        await server.close();
      } finally {
        // 旧实例的关闭回调不能删除新实例发布的发现文件。
        const descriptor = await readFile(discoveryPath, "utf8").then((value) => JSON.parse(value) as { instanceId?: string }).catch(() => undefined);
        if (descriptor?.instanceId === instanceId) await unlink(discoveryPath).catch(() => undefined);
      }
    }
  };
}
