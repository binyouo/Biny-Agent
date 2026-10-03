import React from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { CompactionCommandState } from "../../app/useCompactionCommand.js";
import { Icon } from "../Icon.js";

export function CompactionStatus({ state, onDismiss, onRetry }: {
  state: CompactionCommandState;
  onDismiss?(): void;
  onRetry?(): void;
}): React.JSX.Element {
  const pending = state.status === "pending";
  return (
    <div aria-busy={pending || undefined} className={`chat-compaction-status is-${state.status}`} role={state.status === "failed" ? "alert" : "status"}>
      {pending
        ? <ThinkingOrb aria-hidden="true" className="chat-run-status-orb" size={20} state="weaving" style={{ width: 16, height: 16 }} />
        : <Icon name="fold" size={14} />}
      <span className={`chat-compaction-status-label${pending ? " chat-shimmer-text" : ""}`}>{state.message}</span>
      {(state.status === "failed" || state.status === "cancelled") && state.retryable !== false && onRetry ? <button aria-label="重试压缩" className="chat-compaction-retry" onClick={onRetry} type="button">重试</button> : null}
      {!pending && onDismiss ? <button aria-label="关闭压缩提示" onClick={onDismiss} type="button"><Icon name="close" size={12} /></button> : null}
    </div>
  );
}
