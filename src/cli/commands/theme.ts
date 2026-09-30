import { readFile, stat, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { exportAppearanceTheme, getAppearancePalette, importAppearanceTheme } from "../../appearance/editing.js";
import { DEFAULT_APPEARANCE, listAppearanceThemes } from "../../appearance/preferences.js";
import { resolveAppearance } from "../../appearance/resolve.js";

export function registerThemeCommands(program: Command): void {
  const theme = program.command("theme").description("Inspect, validate and import desktop color themes");
  theme.command("list").option("--json", "print JSON").action((options: { json?: boolean }) => {
    const themes = listAppearanceThemes();
    console.log(options.json ? JSON.stringify({ themes }) : themes.map(info => `${info.id}\t${info.type}\t${info.skin}\t${info.displayName}`).join("\n"));
  });
  theme.command("show").argument("<id>", "built-in theme ID").option("--json", "print JSON").action((id: string, options: { json?: boolean }) => execute(async () => {
    const palette = getAppearancePalette(id);
    if (!palette) throw new Error(`Unknown theme: ${id}`);
    const resolved = resolveAppearance({ ...DEFAULT_APPEARANCE, [palette.type === "dark" ? "darkTheme" : "lightTheme"]: id }, palette.type, false);
    console.log(options.json ? JSON.stringify({ ...resolved, palette }) : `${id} (${palette.type}, ${resolved.skin})\n${Object.entries(resolved.variables).map(([key, value]) => `${key}: ${value}`).join("\n")}`);
  }));
  for (const action of ["validate", "import"] as const) {
    theme.command(action).argument("<file>", "JSON or literal Base46 Lua theme").option("--json", "print JSON").option("--out <file>", "write imported JSON to a new file")
      .action((file: string, options: { json?: boolean; out?: string }) => execute(async () => {
        if ((await stat(file)).size > 256 * 1024) throw new Error("Theme files must not exceed 256 KiB.");
        const imported = importAppearanceTheme(await readFile(file, "utf8"));
        if (options.out) await writeFile(options.out, exportAppearanceTheme(imported, imported.displayName), { encoding: "utf8", flag: "wx" });
        console.log(options.json || action === "import" ? exportAppearanceTheme(imported, imported.displayName) : `Valid ${imported.type} theme: ${imported.displayName}`);
      }));
  }
}

async function execute(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
