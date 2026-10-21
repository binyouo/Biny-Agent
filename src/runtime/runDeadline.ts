const maxTimeoutMs = 2_147_483_647;

export function createRunDeadlineSignal(deadlineAtMs: number, safetyMarginMs = 1_000): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const stopAtMs = Math.max(Date.now(), deadlineAtMs - safetyMarginMs);
  const initialDelayMs = Math.max(0, stopAtMs - Date.now());
  let disposed = false;
  let timer = schedule(initialDelayMs);

  function schedule(delayMs: number): ReturnType<typeof setTimeout> {
    // Node turns delays above its signed 32-bit limit into a 1 ms timeout.
    const next = setTimeout(() => {
      if (disposed) return;
      const remainingMs = stopAtMs - Date.now();
      // An initially due timer must still abort on its first asynchronous callback.
      if (initialDelayMs > 0 && remainingMs > 0) {
        timer = schedule(remainingMs);
        return;
      }
      controller.abort(new DOMException("Run stopped at the external deadline boundary.", "TimeoutError"));
    }, Math.min(maxTimeoutMs, delayMs));
    next.unref?.();
    return next;
  }

  return {
    signal: controller.signal,
    dispose: () => { disposed = true; clearTimeout(timer); }
  };
}
