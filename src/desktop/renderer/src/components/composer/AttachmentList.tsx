/** Composer 中待发送附件的展示和删除交互。 */
import type { DesktopAttachment } from "../../../../protocol.js";
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";
import { AttachmentCard } from "../AttachmentCard.js";
import { attachmentSize } from "../../attachmentPresentation.js";
import { FileTypeMarker } from "../workspace/FileTypeMarker.js";

export interface PendingAttachment {
  error?: string;
  id: string;
  mimeType: string;
  name: string;
  size: number;
  status: "error" | "uploading";
}

export function AttachmentList({ attachments, projectId, onRemove, onRemovePending, pending }: {
  projectId: string;
  attachments: DesktopAttachment[];
  onRemove(index: number): void;
  onRemovePending(id: string): void;
  pending: PendingAttachment[];
}): React.JSX.Element {
  return (
    <div className="biny-composer-attachments" aria-label="待发送附件">
      {attachments.map((attachment, index) => (
        <AttachmentCard attachment={attachment} key={attachment.path} projectId={projectId} onRemove={() => onRemove(index)} />
      ))}
      {pending.map((attachment) => (
        <div className={`biny-attachment-chip is-${attachment.status}`} key={attachment.id}>
          <FileTypeMarker name={attachment.name} />
          <span className="biny-attachment-copy">
            <span>{attachment.name}</span>
            <small role="status" title={attachment.error}>{attachment.status === "error" ? attachment.error ?? "添加失败，请移除后重试" : `${attachmentSize(attachment.size)} · 正在添加…`}</small>
          </span>
          {attachment.status === "uploading" ? <span aria-label="正在添加" className="biny-attachment-spinner" /> : null}
          <ComposerActionButton
            className="biny-attachment-remove"
            label={`移除 ${attachment.name}`}
            onClick={() => onRemovePending(attachment.id)}
            tooltip={attachment.status === "error" ? `移除失败附件 ${attachment.name}` : `取消附件 ${attachment.name}`}
          >
            <Icon name="close" size={11} />
          </ComposerActionButton>
        </div>
      ))}
    </div>
  );
}
