import type { WebContents } from "electron";
import { setTimeout as delay } from "node:timers/promises";

/** DOM 可读后即可检查正文，不等待图片等子资源完成加载。 */
export async function loadUntilDomReady(page: WebContents, url: string, signal: AbortSignal | undefined, readReadyState: () => Promise<unknown>): Promise<void> {
  signal?.throwIfAborted();
  const polling = new AbortController();
  let didCommit = false;
  let ready: () => void;
  let abort: () => void;
  let committed: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      ready = () => { if (didCommit) resolve(); };
      abort = () => reject(signal?.reason);
      // 新文档提交后再检查，避免把旧页面的 complete 当成本次导航就绪。
      // interactive 已完成 HTML 解析，无需等待可能阻塞 DOMContentLoaded 的脚本。
      committed = () => {
        didCommit = true;
        void (async () => {
          while (!polling.signal.aborted) {
            const state = await readReadyState();
            if (state === "interactive" || state === "complete") { resolve(); return; }
            await delay(200, undefined, { signal: polling.signal });
          }
        })().catch(error => { if (!polling.signal.aborted) reject(error); });
      };
      page.once("dom-ready", ready);
      page.once("did-navigate", committed);
      signal?.addEventListener("abort", abort, { once: true });
      // DOM 先就绪时仍观察 loadURL 的拒绝，关闭任务页不会产生未处理的 rejection。
      page.loadURL(url).then(resolve, reject);
    });
  } finally {
    polling.abort();
    page.removeListener("dom-ready", ready!);
    page.removeListener("did-navigate", committed!);
    signal?.removeEventListener("abort", abort!);
  }
}
