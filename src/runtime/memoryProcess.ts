import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileConfigStore, type AgentConfigStore } from "../config/store.js";
import { globalAgentDir, globalConfigDir } from "../config/paths.js";
import { AgentMemoryOwner } from "./memory/owner.js";
import { canonicalMemoryRoot, serveMemoryOwner } from "./memory/transport.js";

export async function runMemoryOwnerProcess(argv = process.argv.slice(2), createStore?: (root: string, configRoot: string) => AgentConfigStore): Promise<void> {
  const configArgument = argv.indexOf("--config-dir");
  const root = await canonicalMemoryRoot(globalAgentDir());
  const configRoot = path.resolve(configArgument >= 0 ? argv[configArgument + 1]! : globalConfigDir());
  const owner = new AgentMemoryOwner(root, createStore?.(root, configRoot) ?? createFileConfigStore(root, { globalDir: configRoot }));
  const server = await serveMemoryOwner(root, configRoot, owner, { idleGraceMs: 30_000, onIdle: () => close() });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    void server.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  const supervisor = Number(process.env.BINY_TEST_SUPERVISOR_PID);
  if (process.env.BINY_TEST_PROCESS === "1" && Number.isSafeInteger(supervisor) && supervisor > 1 && supervisor !== process.pid) {
    const timer = setInterval(() => {
      try { process.kill(supervisor, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { clearInterval(timer); close(); }
      }
    }, 1_000);
    timer.unref();
  }
  owner.start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMemoryOwnerProcess();
}
