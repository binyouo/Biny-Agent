import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createWidgetDocument } from "../../widgets/document.js";
import { widgetSchema } from "../../widgets/widget.js";

export async function widgetRenderCommand(options: { html: string; title: string; description?: string; out?: string; json?: boolean }): Promise<void> {
  const html = await readFile(options.html, "utf8");
  const widget = widgetSchema.parse({ title: options.title, description: options.description, html });
  const require = createRequire(import.meta.url);
  const morphdomSource = await readFile(path.join(path.dirname(require.resolve("morphdom")), "morphdom-umd.min.js"), "utf8");
  const document = createWidgetDocument({ token: randomUUID(), morphdomSource, widget });
  if (options.out) await writeFile(options.out, document, "utf8");
  if (options.json) console.log(JSON.stringify({ kind: "widget", ...widget, document, path: options.out }));
  else console.log(options.out ? `可视化页面已保存：${options.out}` : document);
}
