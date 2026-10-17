import type { McpServerStatus } from "../../extensions/mcp.js";

export interface McpStartupIndicator {
  message: string;
  loading: boolean;
  tone: "accent" | "warning";
}

export class McpStatusTracker {
  private failures = new Map<string, string>();
  private completedSignature: string | undefined;

  update(servers: readonly McpServerStatus[]): { indicator?: McpStartupIndicator; notifications: string[] } {
    const enabled = servers.filter(server => server.enabled);
    const connected = enabled.filter(server => server.connected);
    const pending = enabled.filter(server => !server.connected && (server.connecting || !server.lastError && !server.authRequired));
    const failed = enabled.filter(server => !server.connected && !server.connecting && (server.lastError || server.authRequired));
    const warnings = connected.filter(server => server.lastError);
    const notifications: string[] = [];
    const failures = new Map<string, string>();
    for (const server of [...failed, ...warnings]) {
      const reason = server.lastError ?? (server.authRequired ? "authorization required" : "disconnected");
      const message = `MCP ${server.name} ${server.connected ? "warning" : "failed"}: ${reason}${server.authRequired ? " · 请在 MCP 设置中完成授权" : ""} · /mcp reconnect ${server.name}`;
      failures.set(server.name, message);
      if (this.failures.get(server.name) !== message) notifications.push(message);
    }
    this.failures = failures;
    const toolCount = connected.reduce((total, server) => total + server.toolNames.length, 0);
    const summary = `MCP: ${connected.length}/${enabled.length} connected · ${toolCount} tools`;
    const issues = [failed.length ? `${failed.length} failed` : "", warnings.length ? `${warnings.length} warnings` : ""].filter(Boolean).join(" · ");
    if (pending.length) {
      this.completedSignature = undefined;
      return {
        indicator: { message: `${summary} · loading ${pending.map(server => server.name).join(", ")}${issues ? ` · ${issues}` : ""}`, loading: true, tone: issues ? "warning" : "accent" },
        notifications
      };
    }
    const signature = JSON.stringify(enabled.map(server => [server.name, server.connected, server.toolNames, failures.get(server.name)]));
    if (enabled.length && this.completedSignature !== signature) {
      notifications.push(`${summary}${issues ? ` · ${issues}` : ""}`);
    }
    this.completedSignature = signature;
    return {
      indicator: issues ? { message: `MCP: ${issues} · /mcp`, loading: false, tone: "warning" } : undefined,
      notifications
    };
  }
}
