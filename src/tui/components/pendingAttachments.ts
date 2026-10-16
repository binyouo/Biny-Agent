/**
 * 输入框上方的待发送附件标记。
 *
 * 终端不能可靠地嵌入位图，因此用类似聊天界面的 `[Image #1]` 标记替代文件路径；
 * 真正的二进制仍只由 runtime 传给 Agent，不让展示组件参与附件读写。
 */
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentAttachment } from "../../agent/AgentSession.js";
import { theme } from "../theme/index.js";

export class PendingAttachmentsComponent implements Component {
  private attachments: AgentAttachment[] = [];

  setAttachments(attachments: readonly AgentAttachment[]): void {
    this.attachments = [...attachments];
  }

  invalidate(): void {
    // 每次 render 都按当前终端宽度截断，无缓存需要失效。
  }

  render(width: number): string[] {
    if (!this.attachments.length) return [];
    return [
      ...this.attachments.map((attachment, index) => renderPendingAttachment(attachment, index, width)),
      theme.fg("muted", truncateToWidth("  空输入时按 Backspace 移除末个附件", width, "…"))
    ];
  }
}

export function pendingAttachmentLabel(attachment: Pick<AgentAttachment, "mimeType" | "size">, index: number): string {
  const ordinal = index + 1;
  if (attachment.mimeType.startsWith("image/")) return `[Image #${String(ordinal)}]`;
  return `[Attachment #${String(ordinal)}]`;
}

function renderPendingAttachment(attachment: AgentAttachment, index: number, width: number): string {
  const label = pendingAttachmentLabel(attachment, index);
  const detail = attachment.size === undefined ? "" : ` · ${formatAttachmentSize(attachment.size)}`;
  const plain = `  ${label} ${attachment.name}${detail}`;
  if (visibleWidth(plain) > width) return theme.fg("accent", truncateToWidth(plain, width, "…"));
  return theme.fg("accent", `  ${label}`) + theme.fg("text", ` ${attachment.name}`) + theme.fg("muted", detail);
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
