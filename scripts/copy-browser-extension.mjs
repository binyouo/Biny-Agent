/** 浏览器扩展需要真实目录，CLI 与 Desktop 发行包都携带同一份资源。 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, process.argv[2] ?? "dist/browser-extension");
await mkdir(path.dirname(target), { recursive: true });
await cp(path.join(root, "src/browser-extension"), target, { recursive: true });
