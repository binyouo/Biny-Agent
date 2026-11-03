import { app } from "electron";
import { globalConfigDir } from "../../../config/paths.js";
import { startRuntimeHostApp } from "./runtimeHostStartup.js";

app.setName("Biny");

const runtimeHostLaunchIndex = process.argv.indexOf("--biny-runtime-host");
const memoryOwnerLaunchIndex = process.argv.indexOf("--biny-memory-owner");
if (memoryOwnerLaunchIndex >= 0) {
  void startRuntimeHostApp(app, async () => {
    const { DesktopConfigStore } = await import("./DesktopConfigStore.js");
    const { runMemoryOwnerProcess } = await import("../../../runtime/memoryProcess.js");
    await runMemoryOwnerProcess(process.argv.slice(memoryOwnerLaunchIndex + 1),
      (_root, configRoot) => new DesktopConfigStore(configRoot));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    app.exit(1);
  });
} else if (runtimeHostLaunchIndex >= 0) {
  // Host 是独立 Electron 主进程，不创建窗口或启动桌面服务；safeStorage 可直接读取同一凭据文件。
  void startRuntimeHostApp(app, async () => {
    const { runRuntimeHostProcess } = await import("../../../runtime/hostProcess.js");
    await runRuntimeHostProcess(process.argv.slice(runtimeHostLaunchIndex + 1), {
      createConfigStore: async (_workspaceRoot, configDir) => {
        const { DesktopConfigStore } = await import("./DesktopConfigStore.js");
        return new DesktopConfigStore(configDir ?? globalConfigDir());
      }
    });
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    app.exit(1);
  });
} else {
  await import("./desktopMain.js");
}
