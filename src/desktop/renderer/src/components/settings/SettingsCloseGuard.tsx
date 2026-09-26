/** 设置取消、关窗和退出共用系统原生确认；只有确认后才交由调用方丢弃草稿。 */
import { useEffect, useRef } from "react";

export function SettingsCloseGuard({ busy, onCancel, onDiscard }: {
  busy: boolean;
  onCancel(): void;
  onDiscard(): void;
}): null {
  const prompted = useRef(false);
  useEffect(() => {
    // StrictMode 重放 effect 或父组件重渲染不能重复弹出系统确认框。
    if (busy || prompted.current) return;
    prompted.current = true;
    if (window.confirm("有未保存的更改，确定要关闭吗？未保存的更改将丢失。")) onDiscard();
    else onCancel();
  }, [busy, onCancel, onDiscard]);
  return null;
}
