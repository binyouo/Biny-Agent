import type { DesktopMaskRecord } from "../../../../protocol.js";

type Group = DesktopMaskRecord["preview"][number];

/** 长段落先定位第一个命中；两栏裁切同一段原文，保持替换前后可对应。 */
export function privacyExcerpt(group: Group): Group {
  if (Math.max(group.original.length, group.masked.length) <= 900) return group;
  const first = group.segments[0];
  const start = Math.max(0, (first?.start ?? 0) - 160);
  let end = Math.min(group.original.length, Math.max(start + 700, first?.end ?? 0));
  for (const segment of group.segments) if (segment.start < end && segment.end > end) end = segment.end;
  const before = group.segments.filter(segment => segment.end <= start).reduce((sum, segment) => sum + segment.masked.length - (segment.end - segment.start), 0);
  const through = group.segments.filter(segment => segment.end <= end).reduce((sum, segment) => sum + segment.masked.length - (segment.end - segment.start), 0);
  const prefix = start ? "…\n" : "", suffix = end < group.original.length ? "\n…" : "";
  return { ...group, original: prefix + group.original.slice(start, end) + suffix,
    masked: prefix + group.masked.slice(start + before, end + through) + suffix,
    segments: group.segments.filter(segment => segment.start >= start && segment.end <= end).map(segment => ({ ...segment, start: segment.start - start + prefix.length, end: segment.end - start + prefix.length })) };
}

export function privacySize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
