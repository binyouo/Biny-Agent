export interface DesktopActivatableWindow {
  isDestroyed(): boolean;
  show(): void;
}

export function handleDesktopActivation(
  quitCommitted: boolean,
  window: DesktopActivatableWindow | undefined,
  createWindow: () => void
): void {
  if (quitCommitted) return;
  if (!window || window.isDestroyed()) createWindow();
  else window.show();
}

export async function waitForDesktopQuitCleanup(
  cleanup: () => Promise<void>,
  timeoutMs: number
): Promise<"completed" | "timed-out"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cleanup().then(() => "completed" as const),
      new Promise<"timed-out">((resolve) => { timeout = setTimeout(() => resolve("timed-out"), timeoutMs); })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
