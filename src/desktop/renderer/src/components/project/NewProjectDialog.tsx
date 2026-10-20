import { Dialog } from "@astryxdesign/core/Dialog";
import { useEffect, useState } from "react";
import { Icon } from "../Icon.js";

export function NewProjectDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose(): void;
  onCreate(siteUrl?: string): Promise<void>;
}): React.JSX.Element {
  const [siteUrl, setSiteUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) {
      setSiteUrl("");
      setCreating(false);
      setError(undefined);
    }
  }, [open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      await onCreate(siteUrl.trim() || undefined);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setCreating(false);
    }
  };

  return <Dialog aria-label="新建项目" className="biny-project-create-dialog-shell" isOpen={open}
    onOpenChange={(next) => { if (!next && !creating) onClose(); }} padding={0} purpose="form" width="min(440px, calc(100vw - 40px))">
    <form className="biny-project-create-dialog" onSubmit={(event) => void submit(event)}>
      <header><span className="biny-project-create-dialog-icon"><Icon name="folder" size={18} /></span><div><h2>新建项目</h2><p>选择一个文件夹作为 Biny 的工作区</p></div></header>
      <label>项目网址（可选）<input autoFocus disabled={creating} inputMode="url" onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://example.com" type="text" value={siteUrl} /></label>
      <p className="biny-project-create-hint">填写网址后会尝试使用网站图标；读取失败时项目仍会正常创建。</p>
      {error ? <p className="biny-project-create-error" role="alert">{error}</p> : null}
      <footer><button disabled={creating} onClick={onClose} type="button">取消</button><button className="is-primary" disabled={creating} type="submit">{creating ? "正在创建…" : "选择文件夹并创建"}</button></footer>
    </form>
  </Dialog>;
}
