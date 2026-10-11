import type { App } from "electron";

/** 无窗口 Host 的启动顺序；执行入口仍保留完整 Electron 凭据和网络能力。 */
export async function startRuntimeHostApp(app: App, start: () => Promise<void>): Promise<void> {
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") {
    // Bundle 已声明后台身份；Host 进一步禁止激活，正常桌面入口才恢复 regular。
    app.setActivationPolicy("prohibited");
  }
  await app.whenReady();
  await start();
}
