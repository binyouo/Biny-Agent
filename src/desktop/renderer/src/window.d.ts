import type { WindowCaptureApi } from "../../windowCapture.js";
/**
 * 渲染进程的全局类型声明。
 *
 * preload 把 IPC 接口挂在 `window.biny` 上，这里给它补上类型，让渲染层调用主进程能力时
 * 仍受 `DesktopApi` 协议约束。
 */
import type { DesktopApi } from "../../protocol.js";

declare global {
  interface Window {
    biny: DesktopApi;
    binyCapture?: WindowCaptureApi;
  }
}

export {};
