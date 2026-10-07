/** 项目与任务共享的重命名对话框。 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { TextInput } from "@astryxdesign/core/TextInput";

export function RenameOverlay({
  open,
  initialValue,
  title = "重命名会话",
  onClose,
  onSave
}: {
  open: boolean;
  initialValue: string;
  title?: string;
  onClose(): void;
  onSave(value: string): Promise<void>;
}): React.JSX.Element | null {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(undefined);
    window.requestAnimationFrame(() => inputRef.current?.select());
  }, [initialValue, open]);
  const save = async (): Promise<void> => {
    if (!value.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(value.trim());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const close = (): void => {
    if (!savingRef.current) onClose();
  };
  return (
    <Dialog isOpen={open} onOpenChange={(isOpen) => { if (!isOpen) close(); }} padding={0} purpose="form" width={440}>
      <form className="desktop-dialog-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <DialogHeader hasDivider onOpenChange={(isOpen) => { if (!isOpen) close(); }} title={title} />
        <div className="desktop-dialog-content">
          <TextInput
            hasAutoFocus
            isLabelHidden
            isDisabled={saving}
            label={title}
            onChange={(nextValue) => setValue(nextValue.slice(0, 120))}
            placeholder="输入新名称…"
            ref={inputRef}
            value={value}
            width="100%"
          />
          {error ? <p role="alert">{error}</p> : null}
          <div className="desktop-dialog-actions">
            <Button isDisabled={saving} label="取消" onClick={close} type="button" variant="ghost" />
            <Button isDisabled={saving || !value.trim()} isLoading={saving} label="保存" type="submit" variant="primary" />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
