/** Desktop 只读 IPC 的在途请求协调；完成即释放，不缓存快照，不接管写操作。 */
export function createDesktopReadRequest<T>(invoke: (channel: string, ...args: unknown[]) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (channel: string, ...args: unknown[]): Promise<T> => {
    const key = JSON.stringify([channel, ...args]);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = invoke(channel, ...args).finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  };
}
