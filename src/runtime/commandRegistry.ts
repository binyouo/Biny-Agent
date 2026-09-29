/** Desktop 与 TUI 共用的 slash command 声明。 */
export type CommandSurface = "tui" | "desktop";

export interface SlashCommandDefinition {
  name: string;
  description: string;
  category: string;
  requiresArgs?: boolean;
  acceptsArgs?: boolean;
  surfaces: readonly CommandSurface[];
}

const terminalOnly = ["tui"] as const;
const allInteractive = ["tui", "desktop"] as const;

// 纯展示类命令（/usage /status /mcp /skills /plugins 的信息面板）在 Desktop 有专属 UI：
// 用量浮层、模型/权限 pill、设置页与能力菜单。桌面端不再通过命令重复展示，只保留给 TUI。
export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: "/clear", description: "Clear visible messages", category: "system", surfaces: terminalOnly },
  { name: "/usage", description: "Show model token usage and cost", category: "system", surfaces: terminalOnly },
  { name: "/compact", description: "Compact older conversation history", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/model", description: "Choose a model and its supported thinking effort", category: "system", surfaces: terminalOnly },
  { name: "/theme", description: "Choose terminal colors (dark or light)", category: "system", acceptsArgs: true, surfaces: terminalOnly },
  { name: "/status", description: "Show model, context, permissions and extensions", category: "system", surfaces: terminalOnly },
  { name: "/mcp", description: "List MCP servers and tools, or reconnect a server", category: "extension", acceptsArgs: true, surfaces: terminalOnly },
  { name: "/skills", description: "List available project and global skills", category: "extension", surfaces: terminalOnly },
  { name: "/plugins", description: "List loaded plugins", category: "extension", surfaces: terminalOnly },
  { name: "/subagent", description: "Run or manage a subagent (start/status/cancel/agents)", category: "extension", requiresArgs: true, acceptsArgs: true, surfaces: allInteractive },
  { name: "/tasks", description: "Inspect durable background TaskRuns", category: "runtime", acceptsArgs: true, surfaces: allInteractive },
  { name: "/automation", description: "List or control local automations", category: "runtime", acceptsArgs: true, surfaces: allInteractive },
  { name: "/goal", description: "Inspect or control a durable goal", category: "runtime", requiresArgs: true, acceptsArgs: true, surfaces: allInteractive },
  { name: "/graph", description: "Inspect or control an Agent Graph", category: "runtime", requiresArgs: true, acceptsArgs: true, surfaces: allInteractive },
  { name: "/capabilities", description: "Inspect Host and client capabilities", category: "runtime", acceptsArgs: true, surfaces: allInteractive },
  { name: "/review", description: "Review current changes with a read-only subagent", category: "extension", acceptsArgs: true, surfaces: allInteractive },
  { name: "/memories", description: "Control whether this chat uses or contributes memories", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/memory", description: "Manage durable workspace and universal memory (list/show/add/forget/search/compact)", category: "extension", acceptsArgs: true, surfaces: allInteractive },
  { name: "/soul", description: "Show or edit the persistent Soul (show/edit/set/append-trait/reset)", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/resume", description: "Choose a session and resume its history", category: "session", surfaces: terminalOnly },
  { name: "/sessions", description: "List active Runtime Host sessions and switch focus", category: "session", surfaces: terminalOnly },
  { name: "/worktree", description: "Inspect and safely manage isolated worktrees", category: "session", acceptsArgs: true, surfaces: terminalOnly },
  { name: "/new", description: "Start a new chat", category: "session", surfaces: terminalOnly },
  { name: "/app", description: "Open the current chat in Biny Desktop", category: "session", surfaces: terminalOnly },
  { name: "/permissions", description: "View or change permission mode", category: "system", surfaces: terminalOnly },
  { name: "/undo", description: "Restore the workspace from a Biny checkpoint", category: "system", acceptsArgs: true, surfaces: allInteractive },
  { name: "/fork", description: "Fork a session into a new one", category: "session", surfaces: terminalOnly },
  { name: "/exit", description: "Exit Biny", category: "system", surfaces: terminalOnly }
];

export function slashCommandsForSurface(surface: CommandSurface): SlashCommandDefinition[] {
  return SLASH_COMMANDS.filter((command) => command.surfaces.includes(surface));
}
