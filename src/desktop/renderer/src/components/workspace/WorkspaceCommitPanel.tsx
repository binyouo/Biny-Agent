/** 提交页以项目 Git 快照为准；用户选择整文件提交，不使用聊天产物冒充工作区状态。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopGitBranch, DesktopGitStatus } from "../../../../protocol.js";
import { Icon } from "../Icon.js";

export function WorkspaceCommitPanel({ projectId, active, onCount, onSwitchBranch, onPreviewFile }: {
  projectId: string;
  active: boolean;
  onCount(count: number): void;
  onSwitchBranch(projectId: string, branch: string): Promise<void>;
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopGitStatus>();
  const [branches, setBranches] = useState<DesktopGitBranch[]>([]);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [notRepository, setNotRepository] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const adopt = useCallback((next: DesktopGitStatus): void => {
    setSnapshot(next); onCount(next.files.length);
    setSelected((previous) => new Set([...previous].filter((file) => next.files.some((entry) => entry.path === file))));
  }, [onCount]);
  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const next = await window.biny.projectGitStatus(projectId);
      const refs = await window.biny.listProjectBranches(projectId);
      if (alive.current) { adopt(next); setBranches(refs); setNotRepository(false); }
    } catch (reason) {
      if (alive.current) {
        if (/当前项目不是 Git 仓库/u.test(String(reason))) { setSnapshot(undefined); setBranches([]); onCount(0); setNotRepository(true); }
        else setError(String(reason));
      }
    }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }, [adopt, onCount, projectId]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const focus = (): void => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [active, refresh]);
  const run = async (action: "commit" | "pull" | "push" | "branch", branch?: string): Promise<void> => {
    if (inFlight.current || !snapshot) return;
    inFlight.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (action === "branch" && branch) await onSwitchBranch(projectId, branch);
      const next = action === "commit" ? await window.biny.commitProjectFiles(projectId, { paths: [...selected], message, revision: snapshot.revision })
        : action === "branch" ? await window.biny.projectGitStatus(projectId) : await window.biny.projectGitRemote(projectId, action);
      if (!alive.current) return;
      adopt(next);
      if (action === "commit") { setSelected(new Set()); setMessage(""); }
      setNotice(action === "commit" ? "所选文件已提交" : action === "pull" ? "已完成快进拉取" : action === "push" ? "已推送" : "分支已刷新");
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const initialize = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try {
      const next = await window.biny.initializeProjectGit(projectId);
      if (!alive.current) return;
      adopt(next); setNotRepository(false);
      setBranches(await window.biny.listProjectBranches(projectId));
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const selectable = snapshot?.files.filter((file) => !/U|AA|DD/u.test(file.status)) ?? [];
  if (notRepository) return <section className="inspector-utility-panel" aria-label="Git 提交">
    <div className="inspector-empty inspector-git-setup">
      <Icon name="branch" size={44} />
      <p>不是 Git 仓库</p>
      <button type="button" disabled={busy} onClick={() => void initialize()}>{busy ? "初始化中…" : "初始化仓库"}</button>
      {error ? <div className="inspector-error" role="alert">{error}</div> : null}
    </div>
  </section>;
  return <section className="inspector-utility-panel" aria-label="Git 提交">
    <div className="inspector-subtoolbar">
      <Icon name="branch" size={15} />
      <select aria-label="当前分支" value={snapshot?.branch ?? ""} disabled={busy || !snapshot} onChange={(event) => void run("branch", event.target.value)}>
        {!branches.some((entry) => entry.name === snapshot?.branch) ? <option value={snapshot?.branch ?? ""}>{snapshot?.branch ?? "读取分支…"}</option> : null}
        {branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
      </select><span />
      <button type="button" aria-label="刷新 Git 状态" title="刷新" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button>
      <button type="button" aria-label="拉取（仅快进）" title="拉取（仅快进）" disabled={busy || !snapshot} onClick={() => void run("pull")}><Icon name="arrow-down" size={15} /></button>
      <button type="button" aria-label="推送" title="推送" disabled={busy || !snapshot} onClick={() => void run("push")}><Icon name="arrow-up" size={15} /></button>
    </div>
    <form className="inspector-commit-form" onSubmit={(event) => { event.preventDefault(); void run("commit"); }}>
      <textarea aria-label="提交说明" placeholder="提交说明…" value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && message.trim() && selected.size) { event.preventDefault(); void run("commit"); } }} />
      <button type="submit" disabled={busy || !message.trim() || selected.size === 0}>{busy ? "处理中…" : `提交${selected.size ? ` ${selected.size} 个文件` : ""}`}</button>
      <small>提交勾选文件的当前完整内容，其他暂存文件保留。</small>
    </form>
    {error ? <div className="inspector-error" role="alert">{error}</div> : null}
    {notice ? <div className="inspector-subtoolbar" role="status">{notice}</div> : null}
    <div className="inspector-subtoolbar"><span>变更（{snapshot?.files.length ?? 0}）</span><label><input type="checkbox" aria-label="选择所有变更" disabled={busy || !selectable.length} checked={!!selectable.length && selectable.every((file) => selected.has(file.path))} onChange={(event) => setSelected(new Set(event.target.checked ? selectable.map((file) => file.path) : []))} />全选</label></div>
    <div className="inspector-result-scroll">
      {snapshot?.files.length === 0 ? <div className="inspector-empty"><Icon name="check" size={28} /><p>工作区没有未提交变更</p></div> : null}
      {snapshot?.files.map((file) => <div className="inspector-commit-file" key={file.path}><input type="checkbox" aria-label={`选择 ${file.path}`} checked={selected.has(file.path)} disabled={busy || /U|AA|DD/u.test(file.status)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })} /><code>{file.status}</code><button type="button" onClick={() => onPreviewFile(file.path)} title={file.path}>{file.path}</button></div>)}
    </div>
  </section>;
}
