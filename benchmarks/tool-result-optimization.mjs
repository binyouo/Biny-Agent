// pnpm exec electron benchmarks/tool-result-optimization.mjs /absolute/new-output-dir
import { app } from "electron";
import { register } from "tsx/esm/api";
app.setName("Biny");
app.whenReady().then(async () => {
  try { register(); const { run } = await import("./tool-result-optimization.ts"); await run(process.argv.slice(2)); app.exit(0); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); app.exit(1); }
});
