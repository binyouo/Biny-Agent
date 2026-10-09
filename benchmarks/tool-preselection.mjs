// pnpm exec electron benchmarks/tool-preselection.mjs /absolute/output/directory [repeats=3] [tool-model-alias]
// 凭据留在 Electron 的既有加密存储边界；评估只保存合成任务与模型用量。
import { app } from "electron";
import { register } from "tsx/esm/api";

app.setName("Biny");
app.whenReady().then(async () => {
  try {
    register();
    const { run } = await import("./tool-preselection.ts");
    await run(process.argv.slice(2));
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
});
