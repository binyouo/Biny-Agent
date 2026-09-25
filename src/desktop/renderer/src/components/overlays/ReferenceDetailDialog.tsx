/** 无独立页面的本地对象引用只显示经过主进程确认的当前内容。 */
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { LocalReferenceResult } from "../../../../../session/localReferences.js";

export function ReferenceDetailDialog({ reference, onClose }: { reference: LocalReferenceResult; onClose(): void }): React.JSX.Element {
  return <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="info" width="min(520px, calc(100vw - 48px))">
    <DialogHeader onOpenChange={(open) => { if (!open) onClose(); }} title={reference.label} subtitle={reference.kind} />
    <p className="reference-detail-content">{reference.content}</p>
  </Dialog>;
}
