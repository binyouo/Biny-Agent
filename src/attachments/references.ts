/** 会话文本中可读的附件清单，以及 Desktop/TUI 共用的展示解析。 */
import type { AttachmentReference } from "./store.js";

export type { AttachmentReference } from "./store.js";

const referenceHeading = "Attached files (read them with Read using these @attachments/ paths):";
const referenceLine = /^- (\S+) \(([^()]*), (\d+) bytes\)$/;
const storedNamePrefix = /^\d+-[\da-f]{6}-/;

export function withAttachmentReferences(
  input: string,
  attachments: ReadonlyArray<Pick<AttachmentReference, "name" | "mimeType" | "size"> & { path?: string }>
): string {
  const references = attachments.filter((attachment): attachment is AttachmentReference => Boolean(attachment.path));
  if (!references.length) return input;
  return [
    input,
    "",
    referenceHeading,
    ...references.map((attachment) => `- ${attachment.path} (${attachment.mimeType || "unknown type"}, ${String(attachment.size ?? 0)} bytes)`)
  ].join("\n");
}

/** 格式不完整时原样返回，避免为了美观吞掉用户输入。 */
export function splitAttachmentReferences(content: string): { text: string; attachments: AttachmentReference[] } {
  const headingStart = content.lastIndexOf(`\n${referenceHeading}\n`);
  if (headingStart === -1) return { text: content, attachments: [] };

  const attachments: AttachmentReference[] = [];
  for (const line of content.slice(headingStart + referenceHeading.length + 2).split("\n")) {
    const match = referenceLine.exec(line);
    if (!match) return { text: content, attachments: [] };
    const virtualPath = match[1] ?? "";
    const mimeType = match[2] ?? "";
    attachments.push({
      path: virtualPath,
      name: virtualPath.split("/").at(-1)?.replace(storedNamePrefix, "") ?? virtualPath,
      mimeType: mimeType === "unknown type" ? "" : mimeType,
      size: Number(match[3])
    });
  }
  return { text: content.slice(0, headingStart).trimEnd(), attachments };
}

/** Only rewrite the complete generated list, preserving ordinary user text verbatim. */
export function rewriteAttachmentReferences(content: string, pathBySource: ReadonlyMap<string, string>): string {
  if (!splitAttachmentReferences(content).attachments.length) return content;
  const start = content.lastIndexOf(`\n${referenceHeading}\n`);
  return content.slice(0, start) + content.slice(start).replace(/^- (\S+) (?=\()/gm,
    (line, source: string) => pathBySource.has(source) ? `- ${pathBySource.get(source)} ` : line);
}
