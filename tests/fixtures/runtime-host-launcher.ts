/** 独立启动者夹具：测试父进程消失，不把测试进程本身当作 Host 的父进程。 */
import { spawnRuntimeHost } from "../../src/runtime/RuntimeHost.js";

const [root, configDir] = process.argv.slice(2);
if (!root || !configDir) throw new Error("Missing fixture paths");
const host = await spawnRuntimeHost(root, {
  workspaceRoot: root, configDir, idleGraceMs: 100,
  clientId: "launch-owner", surface: "desktop"
});
process.send?.({ pid: host.process.pid });
process.on("message", (message) => {
  if (message === "exit") void host.client.close().then(() => process.exit(0));
});
