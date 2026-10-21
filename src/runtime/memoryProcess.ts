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
  const server = await serveMemoryOwner(root, configRoot, owner);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    void server.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  owner.start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMemoryOwnerProcess();
}
