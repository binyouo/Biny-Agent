import { loadConfig } from "../../config/loader.js";
import { AcpClient, acpMcpServers } from "../../acp/client.js";

export async function acpCheckCommand(workspaceRoot: string, providerAlias: string, options: { json?: boolean }): Promise<void> {
  const config = await loadConfig(workspaceRoot);
  const provider = config.providers[providerAlias];
  if (provider?.type !== "acp" || !provider.acp || provider.enabled === false) throw new Error(`ACP 连接不可用：${providerAlias}`);
  const client = new AcpClient({ cwd: workspaceRoot, launch: provider.acp,
    mcpServers: acpMcpServers(config, provider.acp), timeoutMs: provider.timeoutMs });
  try {
    const info = await client.connect();
    console.log(options.json ? JSON.stringify(info) : [
      `ACP 已连接：${providerAlias}`, `会话：${info.sessionId}`,
      `模型：${info.models.map((model) => `${model.id} (${model.name})`).join(", ") || "Agent 默认"}`,
      `模式：${info.modes.map((mode) => `${mode.id} (${mode.name})`).join(", ") || "Agent 默认"}`
    ].join("\n"));
  } finally { await client.close(); }
}
