import type { TuiLaunchMode } from "../../tui/types.js";

/**
 * TUI 命令模块。
 *
 * `tui` 会按需动态加载终端界面入口，避免 `run` 等一次性命令初始化 TUI 依赖。
 * 真正的界面状态和事件桥接都在 `src/tui` 下实现。
 */
export async function tuiCommand(
  workspaceRoot: string,
  version?: string,
  initialSession?: string,
  launchMode: TuiLaunchMode = "new",
  themeName?: string
): Promise<void> {
  // 界面框架只在真正启动 TUI 时加载；`biny chat` 也只是转到这个入口。
  const { startTui } = await import("../../tui/index.js");
  await startTui(workspaceRoot, version, initialSession, launchMode, themeName);
}
