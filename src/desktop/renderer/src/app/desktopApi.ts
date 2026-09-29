/** Desktop preload 边界的共享错误文案与错误归一化。 */
import type { DesktopApi, DesktopSessionDocument, DesktopWorkspaceSnapshot } from "../../../protocol.js";

export const desktopApiVersionMismatchMessage = "桌面端资源版本不一致，请完全退出 Biny 后重新启动。";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readDesktopSession(
  api: Pick<DesktopApi, "openSession">,
  projectId: string,
  sessionId: string,
  workspace?: DesktopWorkspaceSnapshot | Promise<DesktopWorkspaceSnapshot>
): Promise<{ document: DesktopSessionDocument; workspace?: DesktopWorkspaceSnapshot }> {
  const [document, snapshot] = await Promise.all([api.openSession(projectId, sessionId), workspace]);
  return { document, workspace: snapshot };
}
