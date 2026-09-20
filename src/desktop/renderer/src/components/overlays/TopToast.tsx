/** 顶部悬浮通知：全圆角药丸 toast，可叉掉，超时自动消失（带滑出动画）。 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../Icon.js";

const AUTO_DISMISS_MS = 6_000;
const EXIT_MS = 180;

interface TopToastProps {
  message: string;
  /** warning 显示琥珀色警告图标；不填则无图标（成功/信息类提示）。 */
  icon?: "warning";
  onDismiss(): void;
}

export function TopToast({ message, icon, onDismiss }: TopToastProps): React.JSX.Element {
  const [exiting, setExiting] = useState(false);
  const beginDismiss = useCallback((): void => setExiting(true), []);

  useEffect(() => {
    const timer = window.setTimeout(beginDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [beginDismiss]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(onDismiss, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting, onDismiss]);

  return (
    <div className={exiting ? "desktop-top-toast is-exiting" : "desktop-top-toast"} role={icon === "warning" ? "alert" : "status"}>
      {icon === "warning" ? <Icon name="warning" size={15} /> : null}
      <span className="desktop-top-toast-message" title={message}>{message}</span>
      <button aria-label="关闭提示" className="desktop-top-toast-close" onClick={beginDismiss} type="button">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
