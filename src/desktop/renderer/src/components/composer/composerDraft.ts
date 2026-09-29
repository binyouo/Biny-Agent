/** 当前窗口内按会话保留草稿；异步附件写回所属草稿，不受界面切换影响。 */
import type { DesktopAttachment } from "../../../../protocol.js";
import type { PendingAttachment } from "./AttachmentList.js";
import type { ReferenceDraft, ReferenceDraftTransition } from "./referenceCompletion.js";

export interface ComposerDraftSnapshot {
  draft: ReferenceDraft;
  history: ReferenceDraftTransition[];
  attachments: DesktopAttachment[];
  pendingAttachments: PendingAttachment[];
  submitting: boolean;
}

export class ComposerDraftState {
  private snapshot: ComposerDraftSnapshot = { draft: { value: "", tokens: [] }, history: [], attachments: [], pendingAttachments: [], submitting: false };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = (): ComposerDraftSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  update(change: Partial<ComposerDraftSnapshot> | ((current: ComposerDraftSnapshot) => Partial<ComposerDraftSnapshot>)): void {
    this.snapshot = { ...this.snapshot, ...(typeof change === "function" ? change(this.snapshot) : change) };
    for (const listener of this.listeners) listener();
  }
}
