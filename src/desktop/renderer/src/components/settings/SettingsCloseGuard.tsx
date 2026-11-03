/** 关闭等待提交结束后，只对仍未保存的草稿或恢复状态询问确认。 */
import { useEffect, useRef } from "react";

export function SettingsCloseGuard({ busy, hasUnsavedChanges, onCancel, onDiscard }: {
  busy: boolean;
  hasUnsavedChanges: boolean;
  onCancel(): void;
  onDiscard(): void;
}): null {
  const prompted = useRef(false);
  useEffect(() => {
    // StrictMode 重放 effect 或父组件重渲染不能重复弹出系统确认框。
    if (busy || prompted.current) return;
    prompted.current = true;
    if (!hasUnsavedChanges || window.confirm("有未保存的更改，确定要关闭吗？未保存的更改将丢失。")) onDiscard();
    else onCancel();
  }, [busy, hasUnsavedChanges, onCancel, onDiscard]);
  return null;
}
