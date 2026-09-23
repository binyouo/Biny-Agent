/** 草稿和历史消息共用附件卡片；图片内联预览，文档交给系统应用打开。 */
import React, { useRef, useState } from "react";
import type { AttachmentReference } from "../../../attachmentReferences.js";
import { useInlineImage } from "../inlineImage.js";
import { attachmentSize } from "../attachmentPresentation.js";
import { FileTypeMarker } from "./workspace/FileTypeMarker.js";
import { Icon } from "./Icon.js";

export function AttachmentCard({ attachment, projectId, onRemove }: {
  attachment: AttachmentReference;
  projectId: string;
  onRemove?(): void;
}): React.JSX.Element {
  const isImage = attachment.mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp)$/iu.test(attachment.name);
  const source = useInlineImage(projectId, isImage ? attachment.path : "");
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const openFile = async (): Promise<void> => {
    setError(undefined);
    setOpening(true);
    try { await window.biny.openWorkspaceFile(projectId, attachment.path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOpening(false); }
  };
  return <div className="attachment-card-wrap">
    <div className="attachment-card">
      <button className="attachment-card-main" type="button" disabled={opening} title={attachment.name}
        aria-label={`${source ? "预览" : "打开"} ${attachment.name}`}
        onClick={() => { if (source) dialog.current?.showModal(); else void openFile(); }}>
        <span className="attachment-card-thumbnail">{source ? <img src={source} alt="" /> : <FileTypeMarker name={attachment.name} />}</span>
        <span className="attachment-card-copy"><span>{attachment.name}</span><small>{attachmentSize(attachment.size)} · {opening ? "正在打开…" : source ? "点击预览" : "系统应用打开"}</small></span>
      </button>
      {onRemove ? <button className="attachment-card-remove" type="button" aria-label={`移除 ${attachment.name}`} title="移除附件" onClick={onRemove}><Icon name="close" size={13} /></button> : null}
    </div>
    {error ? <small className="attachment-card-error" role="alert">{error}</small> : null}
    {source ? <dialog ref={dialog} className="attachment-image-dialog" aria-label={`预览 ${attachment.name}`} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <header><span>{attachment.name}</span><button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><Icon name="close" size={18} /></button></header>
      <img src={source} alt={attachment.name} />
    </dialog> : null}
  </div>;
}
