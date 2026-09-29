/** `biny chat` 是默认新交互会话的显式别名，不再维护第二套终端交互循环。 */
import { tuiCommand } from "./tui.js";

export async function chatCommand(workspaceRoot: string, version?: string, themeName?: string): Promise<void> {
  await tuiCommand(workspaceRoot, version, undefined, "new", themeName);
}
