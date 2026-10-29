import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DesktopMaskRecordSummary } from "../../../../protocol.js";
import { AppIcon } from "../AppIcon.js";
import { Icon } from "../Icon.js";
import { ProviderBrandGlyph } from "../ProviderBrandGlyph.js";
import { privacyFlowNodes, type PrivacyFlowNode } from "./privacyFlowData.js";
import { providerBrandType } from "./providerBrand.js";

interface Props {
  records: readonly DesktopMaskRecordSummary[];
  enabled: boolean;
  session: string;
  provider: string;
  onSessionChange(value: string): void;
  onProviderChange(value: string): void;
}

const formatCount = (count: number): string => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(count);

export function PrivacyFlow({ records, enabled, session, provider, onSessionChange, onProviderChange }: Props): React.JSX.Element {
  const middle = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = middle.current;
    if (!element) return;
    const size = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.round(entry.contentRect.width)); });
    const visibility = new IntersectionObserver(([entry]) => { setVisible(entry?.isIntersecting ?? false); });
    size.observe(element); visibility.observe(element);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setMotionAllowed(!media.matches && !document.hidden);
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      size.disconnect(); visibility.disconnect();
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const nodes = privacyFlowNodes(records);
  const hasRecords = records.length > 0;
  const sources = nodes.sessions.length ? nodes.sessions : [{ id: "", label: "会话", count: 0 }];
  const targets = nodes.providers.length ? nodes.providers : [{ id: "", label: "供应商", count: 0 }];
  const height = Math.max(3, sources.length, targets.length) * 38;
  const moving = enabled && hasRecords && motionAllowed && visible;
  const maxCount = Math.max(1, ...sources.map((node) => node.count), ...targets.map((node) => node.count));
  const lines: Array<{ path: string; outgoing: boolean; opacity: number; particle: boolean; duration: number; delay: number }> = [];
  for (const [outgoing, rows] of [[false, sources], [true, targets]] as const) {
    const strands = rows.map((node) => hasRecords ? Math.max(1, Math.round(16 * node.count / maxCount)) : 8);
    const total = strands.reduce((sum, n) => sum + n, 0);
    let ordinal = 0;
    rows.forEach((_node, row) => {
      const count = strands[row]!;
      const rowY = (height - rows.length * 38) / 2 + (row + 0.5) * 38;
      for (let strand = 0; strand < count; strand++, ordinal++) {
        const atCenter = total === 1 ? height / 2 : height * (0.23 + 0.54 * ordinal / (total - 1));
        const atEdge = rowY + (strand - (count - 1) / 2) * 1.5 + (outgoing ? 0 : Math.sin(ordinal * 2.1) * 2);
        const startX = outgoing ? width / 2 : 0, endX = outgoing ? width : width / 2;
        const startY = outgoing ? atCenter : atEdge, endY = outgoing ? atEdge : atCenter;
        const controlX = (startX + endX) / 2;
        lines.push({
          path: `M${startX} ${startY} C${controlX} ${startY} ${controlX} ${endY} ${endX} ${endY}`,
          outgoing, opacity: outgoing ? 0.5 : 0.12 + (ordinal % 5) * 0.05,
          particle: strand === Math.floor(count / 2), duration: 2.2 + row * 0.45, delay: outgoing ? 2.2 + row * 0.45 : row * 0.35
        });
      }
    });
  }
  const column = (rows: PrivacyFlowNode[], outgoing: boolean): React.JSX.Element => <div className={`privacy-flow-nodes ${outgoing ? "is-outgoing" : ""}`}>
    {rows.map((node, i) => <button key={`${node.id}:${i}`} type="button" className="privacy-flow-node" disabled={!node.id}
      title={node.id || undefined} aria-pressed={node.id ? node.id === (outgoing ? provider : session) : undefined}
      onClick={() => (outgoing ? onProviderChange : onSessionChange)(node.id === (outgoing ? provider : session) ? "" : node.id)}>
      <span className="privacy-flow-node-icon">{outgoing ? <ProviderBrandGlyph type={providerBrandType(node.label)} /> : <Icon name="message" size={14} />}</span>
      <span className="privacy-flow-node-text"><span>{node.label}</span><small>{hasRecords ? formatCount(node.count) : "—"}</small></span>
    </button>)}
  </div>;

  return <figure className="privacy-flow" aria-label="会话经本机脱敏后发送至供应商">
    <div className="privacy-flow-layout" style={{ height }}>
      {column(sources, false)}
      <div className="privacy-flow-middle" ref={middle}>
        {width > 0 ? <svg key={`${width}:${records[0]?.id ?? "empty"}:${moving}`} viewBox={`0 0 ${width} ${height}`} className={moving ? "is-animated" : undefined} aria-hidden="true">
          {lines.map((line, i) => <g key={i} className={line.outgoing ? "is-outgoing" : undefined}>
            <path className="privacy-flow-thread" d={line.path} pathLength={1} strokeOpacity={line.opacity} style={{ "--flow-delay": line.outgoing ? "650ms" : "0ms" } as CSSProperties} />
            {moving && line.particle ? <rect className="privacy-flow-particle" x={-1.6} y={-1.6} width={3.2} height={3.2} rx={line.outgoing ? 0.4 : 1.6}>
              <animateMotion path={line.path} dur={`${line.duration}s`} begin={`${line.delay}s`} repeatCount={2} />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.12;.85;1" dur={`${line.duration}s`} begin={`${line.delay}s`} repeatCount={2} />
            </rect> : null}
          </g>)}
          <line className="privacy-flow-divider" x1={width / 2} x2={width / 2} y1={0} y2={height} />
          {Array.from({ length: Math.floor(height / 19) + 1 }, (_, i) => <line key={i} className="privacy-flow-tick" x1={width / 2 - 3} x2={width / 2 + 3} y1={i * 19} y2={i * 19} />)}
          {moving ? <rect className="privacy-flow-scan" x={width / 2 - 1} width={2} height={16} rx={1} style={{ "--flow-height": `${height - 16}px` } as CSSProperties} /> : null}
        </svg> : null}
        <span className="privacy-flow-hub"><AppIcon size={23} /></span>
      </div>
      {column(targets, true)}
    </div>
    <figcaption>在本机脱敏</figcaption>
  </figure>;
}
