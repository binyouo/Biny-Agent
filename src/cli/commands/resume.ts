/** `biny resume` 是显式的交互恢复入口；不传 session 时进入选择器。 */
import { tuiCommand } from "./tui.js";

export async function resumeCommand(workspaceRoot: string, version?: string, session?: string, themeName?: string): Promise<void> {
  await tuiCommand(
    workspaceRoot,
    version,
    session,
    session === undefined ? "resume-picker" : "resume-session",
    themeName
  );
}
