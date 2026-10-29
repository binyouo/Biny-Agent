import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DesktopMaskRecord, DesktopMaskSegment } from "../../../../protocol.js";

import { privacyKinds } from "./privacyLabels.js";
import { privacyExcerpt, privacySize } from "./privacyExcerpt.js";

type Mode = "masked" | "original" | "compare";
function SensitiveValue({ value, segment }: { value: string; segment: DesktopMaskSegment }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const anchor = useRef<HTMLButtonElement>(null), tooltip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // 原生设置对话框在 top layer；提示必须在其中，不能挂到被遮挡的 body。
    setPortalTarget(anchor.current?.closest<HTMLElement>(".settings-detail-layer, .settings-modal, dialog") ?? document.body);
  }, []);
  useEffect(() => {
    if (!open || !anchor.current || !tooltip.current) return;
    const button = anchor.current, panel = tooltip.current;
    let active = true;
    const cleanup = autoUpdate(button, panel, () => {
      void computePosition(button, panel, { strategy: "fixed", placement: "top", middleware: [offset(8), flip(), shift({ padding: 12 })] }).then(({ x, y }) => {
        if (active) Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    });
    return () => { active = false; cleanup(); };
  }, [open, portalTarget]);
  return <span className="privacy-hit" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button ref={anchor} type="button" aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onClick={() => setOpen(true)} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}><mark>{value}</mark></button>
    {open && portalTarget ? createPortal(<span ref={tooltip} style={{ visibility: "hidden" }} className="privacy-hit-tooltip" role="tooltip" id={id}><span>{privacyKinds[segment.kind] ?? segment.kind}</span><strong>{segment.original}</strong><code>{segment.masked}</code></span>, portalTarget) : null}
  </span>;
}

function highlighted(text: string, segments: DesktopMaskSegment[], original: boolean): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  if (original) {
    for (const [i, segment] of segments.entries()) {
      parts.push(text.slice(cursor, segment.start));
      parts.push(<SensitiveValue key={i} value={text.slice(segment.start, segment.end)} segment={segment} />);
      cursor = segment.end;
    }
  } else {
    const byTag = new Map(segments.map((s) => [s.masked, s]));
    for (const match of text.matchAll(/\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/gu)) {
      const segment = byTag.get(match[0]);
      if (!segment) continue;
      parts.push(text.slice(cursor, match.index));
      parts.push(<SensitiveValue key={match.index} value={match[0]} segment={segment} />);
      cursor = match.index + match[0].length;
    }
  }
  parts.push(text.slice(cursor));
  return parts;
}

function ChangedGroup({ group, mode }: { group: DesktopMaskRecord["preview"][number]; mode: Mode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const excerpt = privacyExcerpt(group);
  const long = excerpt !== group;
  const shown = expanded ? group : excerpt;
  return <article className="privacy-group">
    <header><span className="privacy-field-name">{group.role ? <b>{group.role}</b> : null}<code>{group.path || "文本"}</code></span><span>{new Set(group.segments.map(segment => segment.masked)).size} 个值</span></header>
    <div className={`privacy-comparison ${mode === "compare" ? "is-compare" : ""}`}>
      {mode !== "masked" ? <div><pre>{highlighted(shown.original, shown.segments, true)}</pre></div> : null}
      {mode !== "original" ? <div><pre>{highlighted(shown.masked, shown.segments, false)}</pre></div> : null}
    </div>
    {long ? <button type="button" className="settings-text-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "显示全部"}</button> : null}
    {group.truncated ? <p className="privacy-note">此字段超出保留预算，内容不完整。</p> : null}
  </article>;
}

export function PrivacyComparison({ groups, truncated = false }: { groups: DesktopMaskRecord["preview"]; truncated?: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("compare");
  const chunks: Array<{ changed: true; group: DesktopMaskRecord["preview"][number] } | { changed: false; groups: DesktopMaskRecord["preview"] }> = [];
  for (const group of groups) {
    if (group.original !== group.masked) chunks.push({ changed: true, group });
    else {
      const last = chunks.at(-1);
      if (last && !last.changed) last.groups.push(group);
      else chunks.push({ changed: false, groups: [group] });
    }
  }
  // 整条请求没有替换时，默认展开正文，直接可读；有替换时保持折叠，只突出改动。
  const anyChanged = groups.some((group) => group.original !== group.masked);
  return <div className="privacy-detail">
    <div className="privacy-toolbar"><div className="privacy-content-title"><strong>请求内容</strong><span className="privacy-content-chip">{anyChanged ? "只显示有改动的部分" : "本次未替换，原样发送"}</span></div><div className="privacy-modes" role="group" aria-label="内容视图">
      {([["original", "原文"], ["masked", "厂商看到的样子"], ["compare", "对照"]] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
    </div></div>
    {mode === "compare" ? <div className="privacy-comparison-labels"><span>这台电脑上的</span><span>厂商看到的样子</span></div> : null}
    {chunks.map((chunk, index) => chunk.changed ? <ChangedGroup key={index} group={chunk.group} mode={mode} /> : <details className="privacy-unchanged" key={index} open={!anyChanged}>
      <summary>{chunk.groups.length} 段未改动 <span>{privacySize(new TextEncoder().encode(chunk.groups.map(group => group.original).join("")).length)}</span></summary>
      <dl>{chunk.groups.map((group, i) => <div className="privacy-unchanged-field" key={i}><dt><code>{group.path}</code></dt><dd><pre>{group.original}</pre>{group.truncated ? <small>内容不完整</small> : null}</dd></div>)}</dl>
    </details>)}
    {truncated ? <p className="privacy-note">请求超出保留预算，当前仅保留部分内容；计数包含完整请求。</p> : null}
  </div>;
}
