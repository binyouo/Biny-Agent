import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";

export function SessionDeleteButton({ title, onDelete }: { title: string; onDelete(): void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    setConfirming(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button
    className={`biny-session-delete${confirming ? " is-confirming" : ""}`}
    aria-label={`${confirming ? "确认删除" : "删除"} ${title}`}
    title={confirming ? "确认删除，此操作无法撤销" : "删除会话（Shift 点击直接删除）"}
    onClick={event => {
      event.stopPropagation();
      if (confirming || event.shiftKey) {
        cancel();
        onDelete();
      } else {
        setConfirming(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(cancel, 3000);
      }
    }}
    onMouseLeave={cancel}
    onBlur={cancel}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}
    type="button"
  >
    <Icon name={confirming ? "trash" : "circle-close"} size={confirming ? 11 : 13} />
    {confirming ? <span>删除</span> : null}
  </button>;
}
