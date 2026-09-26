/** 引用检查器只展示主进程解析的内容；异步结果不能覆盖后选中的对象。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LocalReferenceResult } from "../../../../../session/localReferences.js";
import { Icon } from "../Icon.js";
import { CopyButton } from "../CopyButton.js";

export function WorkspaceReferencesPanel({ projectId, reference, onSelect }: {
  projectId: string;
  reference?: LocalReferenceResult;
  onSelect(reference: LocalReferenceResult): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocalReferenceResult[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<LocalReferenceResult>();
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  useLayoutEffect(() => {
    const id = ++request.current;
    setDetail(undefined); setError(undefined); setResults(undefined); setBusy(Boolean(reference));
    // @ 搜索结果可能只有文件路径或摘要，详情必须重新解析，不能把摘要冒充正文。
    if (reference) void window.biny.referenceResolve(projectId, reference.uri).then((resolved) => {
      if (id === request.current) setDetail(resolved);
    }).catch((reason: unknown) => { if (id === request.current) setError(String(reason)); })
      .finally(() => { if (id === request.current) setBusy(false); });
  }, [projectId, reference, retry]);
  useEffect(() => () => { request.current++; }, [projectId]);
  const search = async (): Promise<void> => {
    const id = ++request.current;
    setError(undefined);
    setResults(undefined);
    if (!query.trim()) { setBusy(false); return; }
    setBusy(true);
    try {
      const found = await window.biny.referenceSearch(projectId, query.trim());
      if (id === request.current) setResults(found);
    } catch (reason) { if (id === request.current) setError(String(reason)); }
    finally { if (id === request.current) setBusy(false); }
  };
  const select = async (uri: string): Promise<void> => {
    const id = ++request.current;
    setBusy(true); setError(undefined);
    try {
      const resolved = await window.biny.referenceResolve(projectId, uri);
      if (id === request.current) { onSelect(resolved); setResults(undefined); }
    } catch (reason) { if (id === request.current) setError(String(reason)); }
    finally { if (id === request.current) setBusy(false); }
  };
  return <section className="inspector-utility-panel" aria-label="引用详情">
    <form className="inspector-reference-search inspector-subtoolbar" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <Icon name="search" size={14} /><input aria-label="查找引用" placeholder="查找文件、记忆、技能等引用…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit" disabled={!query.trim()}>查找</button>
    </form>
    {busy ? <div className="inspector-subtoolbar" role="status">正在读取引用…</div> : null}
    {error ? <div className="inspector-error" role="alert">{error}{reference && results === undefined ? <button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button> : null}</div> : null}
    {results !== undefined ? <div className="inspector-result-scroll">
      {results.length === 0 ? <p className="inspector-muted">没有匹配的引用，试试其他名称。</p> : results.map((item) => <button className="inspector-reference-result" key={item.uri} onClick={() => void select(item.uri)} type="button"><strong>{item.label}</strong><small>{item.kind}</small></button>)}
    </div> : detail ? <>
      <header className="inspector-utility-heading inspector-reference-heading"><div><h2>{detail.label}</h2><p>{detail.kind}</p></div><CopyButton value={detail.uri} label="复制引用链接" /></header>
      <div className="inspector-result-scroll"><pre className="inspector-reference-content">{detail.content || "此引用没有可显示的内容。"}</pre></div>
    </> : <div className="inspector-empty"><Icon name="search" size={28} /><p>选择要查看的引用</p><small>查找本地对象，查看其内容或功能用法。</small></div>}
  </section>;
}
