/**
 * 运行中追加消息的可见队列。
 *
 * 排序和操作都回写 Runtime 权威状态；组件只保留编辑框、拖拽反馈和请求中状态。
 */
import React, { useLayoutEffect, useRef, useState } from "react";
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
  // Keep event-time ownership synchronous: Escape/blur and a second click may precede React commit.
  const editingRef = useRef<typeof editing>(undefined);
  const mounted = useRef(true);
  const composing = useRef(false);
  const messagesRef = useRef(messages);
  const [savingEdit, setSavingEdit] = useState(false);
  const editPending = useRef<typeof editing>(undefined);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    messagesRef.current = messages;
    if (editingRef.current && !messages.some(message => message.messageId === editingRef.current!.messageId)) {
      editingRef.current = undefined;
      composing.current = false;
      setEditing(undefined);
    }
    // Consumed/removed messages retire their save owner without letting its late reply unlock a new edit.
    if (editPending.current && !messages.some(message => message.messageId === editPending.current!.messageId)) {
      editPending.current = undefined;
      setSavingEdit(false);
    }
  }, [messages]);
  const changeEditing = (next: typeof editing): void => {
    if (editingRef.current?.messageId !== next?.messageId) composing.current = false;
    editingRef.current = next;
    setEditing(next);
  };
  const [draggingId, setDraggingId] = useState<string>();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyKeys = useRef(new Set<string>());
  const lastMoveRef = useRef<string | undefined>(undefined);

  if (!messages.length) return null;

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (editPending.current || !mounted.current || busyKeys.current.has(key)) return;
    busyKeys.current.add(key);
    setBusyIds((current) => new Set(current).add(key));
    try {
      await action();
    } catch (error) {
      if (mounted.current) onError(error instanceof Error ? error.message : String(error));
    } finally {
      busyKeys.current.delete(key);
      if (mounted.current) setBusyIds((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const commitEdit = async (): Promise<void> => {
    const current = editingRef.current;
    if (!current || editPending.current || composing.current || !mounted.current) return;
    const content = current.content.trim();
    // One visible editor: do not accept another draft while its save cannot yet settle.
    editPending.current = current;
    setSavingEdit(true);
    try {
      await onUpdate(current.messageId, content);
      if (mounted.current && editingRef.current === current) changeEditing(undefined);
    } catch (error) {
      if (mounted.current && editingRef.current === current && messagesRef.current.some(message => message.messageId === current.messageId)) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (editPending.current === current) {
        editPending.current = undefined;
        if (mounted.current) setSavingEdit(false);
      }
    }
  };

  return (
    <section aria-label={`${String(messages.length)} 条待发送消息`} className="biny-queued-messages">
      <header className="biny-queued-messages-header">
        <span><Icon name="timer" size={17} />{messages.length} 条待发送消息</span>
        <button
          aria-label="停止当前任务并发送队列"
          className="biny-queued-send-now"
          disabled={!running || busyIds.has("all") || savingEdit}
          onClick={() => { void run("all", onSendNow); }}
          title="停止当前任务并发送队列"
          type="button"
        >
          <Icon name="arrow-up" size={17} /><span>停止并发送</span>
        </button>
      </header>
      <div className="biny-queued-message-list">
        {messages.map((message, index) => {
          const isEditing = editing?.messageId === message.messageId;
          const pending = busyIds.has(message.messageId) || savingEdit;
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
                if (editPending.current || !draggingId || draggingId === message.messageId) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const moveKey = `${draggingId}:${message.messageId}:${placeAfter ? "after" : "before"}`;
                if (lastMoveRef.current === moveKey) return;
                lastMoveRef.current = moveKey;
                void onMove(draggingId, message.messageId, placeAfter).catch((error: unknown) => {
                  if (mounted.current) onError(error instanceof Error ? error.message : String(error));
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
              <span aria-hidden="true" className="biny-queued-message-grip" title="拖动或按 Alt+↑/↓ 重新排序">
                <Icon name="grip-vertical" size={14} />
              </span>
              {isEditing ? (
                <textarea
                  aria-label="编辑待发送消息"
                  autoFocus
                  onBlur={() => { if (!composing.current) void commitEdit(); }}
                  onCompositionStart={() => { if (editingRef.current?.messageId === message.messageId) composing.current = true; }}
                  onCompositionEnd={() => { if (editingRef.current?.messageId === message.messageId) composing.current = false; }}
                  readOnly={savingEdit}
                  aria-busy={savingEdit}
                  onChange={(event) => { if (!editPending.current) changeEditing({ messageId: message.messageId, content: event.target.value }); }}
                  onKeyDown={(event) => {
                    if (editPending.current || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      changeEditing(undefined);
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
                  onClick={() => {
                    if (editPending.current) return;
                    if (editingRef.current && editingRef.current.messageId !== message.messageId) { void commitEdit(); return; }
                    changeEditing({ messageId: message.messageId, content: message.content });
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                    const up = event.key === "ArrowUp";
                    const target = messages[up ? index - 1 : index + 1];
                    event.preventDefault();
                    if (target) void run(message.messageId, async () => await onMove(message.messageId, target.messageId, !up));
                  }}
                  title="点击编辑；Alt+↑/↓ 调整顺序"
                  type="button"
                >
                  {message.content || `[${String(message.attachmentCount)} 个文件]`}
                </button>
              )}
              {isEditing && savingEdit ? <span role="status">正在保存…</span> : null}
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
