/**
 * 运行中指示器：80ms 一帧循环盲文点阵字符的极简 spinner。
 * 所有实例共享同一个定时器（帧号存模块级变量），通过 useSyncExternalStore
 * 订阅帧变化，避免侧栏几十个会话行各自持有 interval。
 */
import { useSyncExternalStore } from "react";

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const FRAME_MS = 80;

let frame = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      listeners.forEach((listener) => listener());
    }, FRAME_MS);
  }
  return () => {
    listeners.delete(onChange);
    // 最后一个订阅者离开后停表归零，侧栏收起时不空转。
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
      frame = 0;
    }
  };
}

function getSnapshot(): string {
  // frame 始终对长度取模，索引必然在界内。
  return SPINNER_FRAMES[frame]!;
}

export function WorkingIndicator({ waiting = false }: { waiting?: boolean }): React.JSX.Element {
  const glyph = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <span
      aria-label={waiting ? "等待确认" : "运行中"}
      role="img"
      className={`biny-working-indicator${waiting ? " is-waiting" : ""}`}
    >
      {glyph}
    </span>
  );
}
