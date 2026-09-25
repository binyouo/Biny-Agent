/** 消息的反向引用弹层；关系和来源内容都由主进程在当前项目内重新验证。 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import type { LocalReferenceResult } from "../../../../../session/localReferences.js";

export function MessageReferencesDialog({ projectId, uri, onClose, onOpen }: {
  projectId: string;
  uri: string;
  onClose(): void;
  onOpen(uri: string): void;
}): React.JSX.Element {
  const [sources, setSources] = useState<LocalReferenceResult[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void window.biny.referenceBacklinks(projectId, uri).then(async (links) => {
      const results = await Promise.allSettled(links.map((link) => window.biny.referenceResolve(projectId, link.sourceUri)));
      if (active) setSources(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, uri]);
  return <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="info" width="min(520px, calc(100vw - 48px))">
    <DialogHeader onOpenChange={(open) => { if (!open) onClose(); }} title="引用来源" />
    {loading ? <p>正在读取…</p> : error ? <p role="alert">{error}</p> : sources.length === 0 ? <p>尚无引用来源。</p>
      : <div className="message-references-list">{sources.map((source) => <button key={source.uri} onClick={() => { onOpen(source.uri); onClose(); }} type="button">
        <strong>{source.label}</strong><span>{source.kind}</span>
      </button>)}</div>}
  </Dialog>;
}
