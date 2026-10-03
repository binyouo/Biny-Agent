import type { App } from "electron";

/** 无窗口 Host 的启动顺序；执行入口仍保留完整 Electron 凭据和网络能力。 */
export async function startRuntimeHostApp(app: App, start: () => Promise<void>): Promise<void> {
  app.disableHardwareAcceleration();
  if (process.platform === "darwin") {
    // ready 之后设置策略已经晚于 Dock 注册；必须在应用完成启动前禁止激活。
    app.setActivationPolicy("prohibited");
    app.dock?.hide();
  }
  await app.whenReady();
  await start();
}
