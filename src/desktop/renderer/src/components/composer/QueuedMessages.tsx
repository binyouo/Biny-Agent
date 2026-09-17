/**
 * 运行中追加消息的可见队列。
 *
 * 排序和操作都回写 Runtime 权威状态；组件只保留编辑框、拖拽反馈和请求中状态。
 */
import React, { useRef, useState } from "react";
import type { QueuedRunMessageSnapshot } from "../../../../../runtime/agentEvents.js";
import { Icon } from "../Icon.js";

interface QueuedMessagesProps {
  messages: readonly QueuedRunMessageSnapshot[];
  running: boolean;
  onRemove(messageId: string): Promise<void>;
  onMove(messageId: string, targetMessageId: string, placeAfter: boolean): Promise<void>;
  onSteer(messageId: string): Promise<void>;
  onSendNow(): Promise<void>;
  onUpdate(messageId: string, input: string): Promise<void>;
  onError(message: string): void;
}

export function QueuedMessages({ messages, running, onRemove, onMove, onSteer, onSendNow, onUpdate, onError }: QueuedMessagesProps): React.JSX.Element | null {
  const [editing, setEditing] = useState<{ messageId: string; content: string }>();
  const [draggingId, setDraggingId] = useState<string>();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const lastMoveRef = useRef<string | undefined>(undefined);

  if (!messages.length) return null;

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusyIds((current) => new Set(current).add(key));
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const commitEdit = async (): Promise<void> => {
    const current = editing;
    if (!current) return;
    const content = current.content.trim();
    setEditing(undefined);
    await run(current.messageId, async () => await onUpdate(current.messageId, content));
  };

  return (
    <section aria-label={`${String(messages.length)} 条待发送消息`} className="biny-queued-messages">
      <header className="biny-queued-messages-header">
        <span><Icon name="timer" size={17} />{messages.length} 条待发送消息</span>
        <button
          aria-label="立即发送待发送消息"
          disabled={busyIds.has("all")}
          onClick={() => { void run("all", onSendNow); }}
          title="立即发送待发送消息"
          type="button"
        >
          <Icon name="arrow-up" size={17} />
        </button>
      </header>
      <div className="biny-queued-message-list">
        {messages.map((message) => {
          const isEditing = editing?.messageId === message.messageId;
          const pending = busyIds.has(message.messageId);
          return (
            <div
              className={`biny-queued-message-row${draggingId === message.messageId ? " is-dragging" : ""}`}
              draggable={!isEditing && !pending}
              key={message.messageId}
              onDragEnd={() => {
                setDraggingId(undefined);
                lastMoveRef.current = undefined;
              }}
              onDragOver={(event) => {
                if (!draggingId || draggingId === message.messageId) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const moveKey = `${draggingId}:${message.messageId}:${placeAfter ? "after" : "before"}`;
                if (lastMoveRef.current === moveKey) return;
                lastMoveRef.current = moveKey;
                void onMove(draggingId, message.messageId, placeAfter).catch((error: unknown) => {
                  onError(error instanceof Error ? error.message : String(error));
                });
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", message.messageId);
                const row = event.currentTarget;
                row.classList.add("is-drag-preview");
                window.requestAnimationFrame(() => {
                  row.classList.remove("is-drag-preview");
                  setDraggingId(message.messageId);
                });
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingId(undefined);
                lastMoveRef.current = undefined;
              }}
            >
              <span aria-hidden="true" className="biny-queued-message-grip" title="拖动以重新排序">
                <Icon name="grip-vertical" size={14} />
              </span>
              {isEditing ? (
                <textarea
                  aria-label="编辑待发送消息"
                  autoFocus
                  onBlur={() => { void commitEdit(); }}
                  onChange={(event) => setEditing({ messageId: message.messageId, content: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(undefined);
                    } else if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void commitEdit();
                    }
                  }}
                  rows={1}
                  value={editing.content}
                />
              ) : (
                <button
                  className="biny-queued-message-content"
                  disabled={pending}
                  onClick={() => setEditing({ messageId: message.messageId, content: message.content })}
                  title="点击编辑"
                  type="button"
                >
                  {message.content || `[${String(message.attachmentCount)} 个文件]`}
                </button>
              )}
              {running && !isEditing ? (
                <button className="biny-queued-message-steer" disabled={pending} onClick={() => { void run(message.messageId, async () => await onSteer(message.messageId)); }} title="立即把这条消息注入正在生成的回答" type="button">
                  <Icon name="corner-down-right" size={14} />
                  <span>插话</span>
                </button>
              ) : null}
              <button aria-label="删除" className="biny-queued-message-delete" disabled={pending} onClick={() => { void run(message.messageId, async () => await onRemove(message.messageId)); }} title="删除" type="button"><Icon name="trash" size={14} /></button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
