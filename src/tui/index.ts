/**
 * TUI 启动模块。
 *
 * 创建终端渲染循环，交给 `BinyTui` 组装界面；界面退出后再打印 session
 * 摘要，避免和 TUI 输出混在一起。
 */
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { BinyTui } from "./app.js";
import type { TuiLaunchMode } from "./types.js";
import { setTheme } from "./theme/index.js";

export async function startTui(
  workspaceRoot: string,
  version?: string,
  initialSession?: string,
  launchMode: TuiLaunchMode = "new",
  themeName = "dark"
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Biny TUI requires an interactive terminal for stdin and stdout. Use biny run "task" --headless for scripts, or biny --help for commands.');
  }
  setTheme(themeName);
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  const app = new BinyTui(ui, workspaceRoot, version, initialSession, launchMode);

  const onSignal = (): void => {
    void app.exit();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let summary: { sessionId: string; sessionFile: string } | undefined;
  try {
    summary = await app.run();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (summary) {
    process.stdout.write([
      `Session: ${summary.sessionId}`,
      `File: ${summary.sessionFile}`,
      "",
      "Continue explicitly:",
      `  biny resume ${summary.sessionId}`,
      ""
    ].join("\n"));
  }
}
