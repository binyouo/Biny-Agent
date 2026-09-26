/** 随发行包提供浏览器扩展，复制到稳定目录供浏览器加载；配对凭据不写入扩展资源。 */
import { cp, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalAgentDir } from "../config/paths.js";

export async function prepareBrowserExtension(target = path.join(globalAgentDir(), "browser-extension")): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(moduleDirectory, "browser-extension"), path.join(moduleDirectory, "..", "browser-extension"), path.resolve(process.cwd(), "src", "browser-extension")];
  for (const source of candidates) {
    try { await access(path.join(source, "manifest.json")); } catch { continue; }
    await mkdir(target, { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true });
    return target;
  }
  throw new Error("未找到随包发布的浏览器扩展，请重新构建 Biny。");
}
