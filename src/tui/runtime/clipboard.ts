/**
 * 终端剪贴板读取。
 *
 * 优先使用可选原生模块，在 Linux 再退回 Wayland/X11 工具，
 * 因为 Ctrl+V 只会把控制字符交给终端，图片二进制必须从系统剪贴板单独读取。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAttachment } from "../../agent/AgentSession.js";
import { saveAttachment } from "../../attachments/store.js";

export type TuiClipboardPaste =
  | { kind: "image"; attachment: AgentAttachment }
  | { kind: "text"; text: string }
  | { kind: "empty" };

interface NativeClipboard {
  getText(): Promise<string>;
  hasImage(): boolean;
  getImageBinary(): Promise<Array<number> | Uint8Array>;
}

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

const supportedImageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const moduleRequire = createRequire(import.meta.url);

function nativeClipboard(): NativeClipboard | undefined {
  if (process.env.TERMUX_VERSION || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return undefined;
  try {
    return moduleRequire("@mariozechner/clipboard") as NativeClipboard;
  } catch {
    // 这是可选依赖。没有预构建二进制时仍可走 wl-paste/xclip，文本则保持终端默认行为。
    return undefined;
  }
}

function baseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? value.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | undefined {
  switch (baseMimeType(mimeType)) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return undefined;
  }
}

function preferredImageMimeType(mimeTypes: string[]): string | undefined {
  const normalized = mimeTypes.map(baseMimeType);
  return supportedImageMimeTypes.find((mimeType) => normalized.includes(mimeType));
}

function command(command: string, args: string[], timeoutMs = 3_000): Buffer | undefined {
  const result = spawnSync(command, args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
  if (result.error || result.status !== 0) return undefined;
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return output.length ? output : undefined;
}

function isWaylandSession(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
  try {
    return /microsoft|wsl/iu.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function readWlPasteImage(): ClipboardImage | undefined {
  const types = command("wl-paste", ["--list-types"], 1_000)?.toString("utf8").split(/\r?\n/u).filter(Boolean) ?? [];
  const mimeType = preferredImageMimeType(types);
  const bytes = mimeType ? command("wl-paste", ["--type", mimeType, "--no-newline"]) : undefined;
  return bytes && mimeType ? { bytes, mimeType } : undefined;
}

function readXclipImage(): ClipboardImage | undefined {
  const types = command("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], 1_000)?.toString("utf8").split(/\r?\n/u).filter(Boolean) ?? [];
  const candidates = [preferredImageMimeType(types), ...supportedImageMimeTypes].filter((value): value is string => Boolean(value));
  for (const mimeType of [...new Set(candidates)]) {
    const bytes = command("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
    if (bytes) return { bytes, mimeType };
  }
  return undefined;
}

function readWslImage(): ClipboardImage | undefined {
  const temporary = path.join(tmpdir(), `biny-clipboard-${randomUUID()}.png`);
  try {
    const windowsPath = command("wslpath", ["-w", temporary], 1_000)?.toString("utf8").trim();
    if (!windowsPath) return undefined;
    const quotedPath = windowsPath.replaceAll("'", "''");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$image = [System.Windows.Forms.Clipboard]::GetImage()`,
      `if ($image) { $image.Save('${quotedPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`
    ].join("; ");
    if (command("powershell.exe", ["-NoProfile", "-Command", script], 5_000)?.toString("utf8").trim() !== "ok") return undefined;
    const bytes = readFileSync(temporary);
    return bytes.length ? { bytes, mimeType: "image/png" } : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件清理失败不影响输入；系统会回收 tmp 目录。
    }
  }
}

async function readNativeImage(): Promise<ClipboardImage | undefined> {
  const clipboard = nativeClipboard();
  try {
    if (!clipboard?.hasImage()) return undefined;
    const value = await clipboard.getImageBinary();
    const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
    return bytes.length ? { bytes, mimeType: "image/png" } : undefined;
  } catch {
    return undefined;
  }
}

export async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  if (process.env.TERMUX_VERSION) return undefined;
  if (process.platform === "linux") {
    const wsl = isWsl();
    let image = isWaylandSession() || wsl ? readWlPasteImage() ?? readXclipImage() : undefined;
    image ??= wsl ? readWslImage() : undefined;
    image ??= await readNativeImage();
    image ??= readXclipImage();
    return image;
  }
  return await readNativeImage();
}

export async function readClipboardText(): Promise<string | undefined> {
  const clipboard = nativeClipboard();
  if (clipboard) {
    try {
      return (await clipboard.getText()) || undefined;
    } catch {
      // Fall through to platform commands below.
    }
  }
  const text = process.env.TERMUX_VERSION
    ? command("termux-clipboard-get", [])
    : process.platform === "darwin"
      ? command("pbpaste", [])
      : process.platform === "linux"
        ? isWaylandSession()
          ? command("wl-paste", ["--no-newline"])
          : command("xclip", ["-selection", "clipboard", "-o"]) ?? command("xsel", ["--clipboard", "--output"])
        : process.platform === "win32"
          ? command("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"])
          : undefined;
  return text?.toString("utf8") || undefined;
}

export async function pasteTuiClipboard(workspaceRoot: string): Promise<TuiClipboardPaste> {
  const image = await readClipboardImage();
  if (image) {
    const extension = extensionForImageMimeType(image.mimeType);
    if (!extension) return { kind: "empty" };
    const reference = await saveAttachment(
      workspaceRoot,
      `biny-clipboard-${Date.now()}.${extension}`,
      image.mimeType,
      image.bytes
    );
    return {
      kind: "image",
      attachment: { ...reference, data: Buffer.from(image.bytes).toString("base64") }
    };
  }
  const text = await readClipboardText();
  return text ? { kind: "text", text } : { kind: "empty" };
}
