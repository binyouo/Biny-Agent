import React, { useEffect, useMemo, useRef, useState } from "react";
import { useInlineImage } from "../inlineImage.js";
import { useMediaVisibility } from "./workspace/useMediaVisibility.js";

interface MediaSource { src?: string; type?: string }
interface MarkdownMediaProps {
  kind: "video" | "audio";
  projectId: string;
  src?: string;
  sources?: MediaSource[];
  poster?: string;
  width?: number | string;
  height?: number | string;
  loop?: boolean;
  muted?: boolean;
  children?: React.ReactNode;
}
type MediaReference = { remote: string } | { path: string };
type ResolvedSource = { url: string; type?: string; primary: boolean };

function mediaReference(value?: string): MediaReference | undefined {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("#") || value.startsWith("//")) return undefined;
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return undefined;
      return { remote: url.href };
    } catch { return undefined; }
  }
  let path = value;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/u, "$1");
    } catch { return undefined; }
  } else {
    if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return undefined;
    try { path = decodeURIComponent(value); } catch { return undefined; }
  }
  return path && !/[\u0000-\u001f\u007f]/u.test(path) ? { path } : undefined;
}

export function MarkdownMedia(props: MarkdownMediaProps): React.JSX.Element {
  const container = useRef<HTMLSpanElement>(null);
  const visible = useMediaVisibility(container);
  const identity = JSON.stringify([props.projectId, props.kind, props.src, props.sources, props.poster]);
  return <span ref={container} className="markdown-media">
    {visible ? <ResolvedMarkdownMedia key={identity} {...props} /> : null}
  </span>;
}

function ResolvedMarkdownMedia({ kind, projectId, src, sources = [], poster, ...props }: MarkdownMediaProps): React.JSX.Element {
  const inputsKey = JSON.stringify([{ src, primary: true }, ...sources.map(source => ({ ...source, primary: false }))]);
  // 流式解析会重建 HAST 节点；相同地址不能让正在播放的媒体重新请求或重置。
  const candidates = useMemo(() => (JSON.parse(inputsKey) as (MediaSource & { primary: boolean })[])
    .flatMap(source => { const reference = mediaReference(source.src); return reference ? [{ reference, type: source.type, primary: source.primary }] : []; }), [inputsKey]);
  const hasLocal = candidates.some(source => "path" in source.reference);
  const initial = candidates.flatMap(source => "remote" in source.reference ? [{ url: source.reference.remote, type: source.type, primary: source.primary }] : []);
  const [resolved, setResolved] = useState<ResolvedSource[]>(hasLocal ? [] : initial);
  const [loading, setLoading] = useState(hasLocal);
  const [error, setError] = useState(candidates.length ? "" : "没有可播放的媒体地址。");
  const [attempt, setAttempt] = useState(0);
  const posterReference = kind === "video" ? mediaReference(poster) : undefined;
  const localPoster = useInlineImage(projectId, posterReference && "path" in posterReference ? posterReference.path : "");
  const posterUrl = posterReference && "remote" in posterReference ? posterReference.remote : localPoster;
  useEffect(() => {
    let active = true;
    setError(candidates.length ? "" : "没有可播放的媒体地址。");
    if (!candidates.some(source => "path" in source.reference)) {
      setResolved(candidates.flatMap(source => "remote" in source.reference ? [{ url: source.reference.remote, type: source.type, primary: source.primary }] : []));
      setLoading(false);
      return;
    }
    setResolved([]);
    setLoading(true);
    void Promise.allSettled(candidates.map(async source => {
      if ("remote" in source.reference) return { url: source.reference.remote, type: source.type, primary: source.primary };
      const result = await window.biny.getWorkspaceMediaUrl(projectId, source.reference.path);
      const address = mediaReference(result.url);
      if (!address || !("remote" in address) || !result.mimeType.startsWith(`${kind}/`)) throw new Error("媒体文件类型或播放地址不可用。");
      return { url: address.remote, type: result.mimeType, primary: source.primary };
    })).then(results => {
      if (!active) return;
      const ready = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      setResolved(ready);
      setLoading(false);
      if (!ready.length) {
        const failed = results.find(result => result.status === "rejected");
        setError(failed?.status === "rejected" && failed.reason instanceof Error ? `媒体加载失败：${failed.reason.message}` : "媒体加载失败。");
      }
    });
    return () => { active = false; };
  }, [candidates, projectId, kind, attempt]);
  if (loading) return <span role="status" className="markdown-image-fallback">正在加载媒体…</span>;
  if (error) return <span role="alert" className="markdown-resource-error">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></span>;
  return <NativeMedia key={`${attempt}:${JSON.stringify(resolved)}`} kind={kind} sources={resolved} poster={posterUrl}
    {...props} onError={() => setError("媒体播放失败，请检查文件格式后重试。")} />;
}

function NativeMedia({ kind, sources, poster, onError, ...props }: Omit<MarkdownMediaProps, "projectId" | "sources" | "src"> & {
  sources: ResolvedSource[];
  onError(): void;
}): React.JSX.Element {
  const media = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const element = media.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      for (const source of element.querySelectorAll("source")) source.removeAttribute("src");
      element.load();
    };
  }, []);
  const failedSources = useRef(new Set<number>());
  const alternatives = sources.filter(source => !source.primary);
  const sourceElements = alternatives.map((source, index) => <source key={`${index}:${source.url}`} src={source.url} type={source.type}
    onError={() => { failedSources.current.add(index); if (!sources.some(candidate => candidate.primary) && failedSources.current.size === alternatives.length) onError(); }} />);
  const onMediaError = (event: React.SyntheticEvent<HTMLMediaElement>) => { if (event.target === event.currentTarget) onError(); };
  const onPlay = () => {
    if (media.current?.ownerDocument.hidden || media.current?.closest('[hidden], [inert], [aria-hidden="true"]')) media.current.pause();
  };
  const primary = sources.find(source => source.primary)?.url;
  if (kind === "video") return <video controls src={primary} preload="metadata" ref={media as React.RefObject<HTMLVideoElement | null>}
    poster={poster} width={props.width} height={props.height} loop={props.loop} muted={props.muted} onError={onMediaError} onPlay={onPlay}>{sourceElements}{props.children}</video>;
  return <audio controls src={primary} preload="metadata" ref={media as React.RefObject<HTMLAudioElement | null>}
    loop={props.loop} muted={props.muted} onError={onMediaError} onPlay={onPlay}>{sourceElements}{props.children}</audio>;
}
