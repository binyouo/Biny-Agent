// 权限引导浮层的几何与识别结果解析。
//
// 单独成模块且不 import electron：这些是纯计算，而它们算错的后果很具体——
// 浮层会指到屏幕外或指错控件，那正是这个控件唯一要做的事。

export interface OverlayRect { x: number; y: number; width: number; height: number }
export interface OverlayPoint { x: number; y: number }
export interface OcrLine { text: string; rect: OverlayRect }

/** macOS 辅助功能授权页；打开后系统会把申请过权限的应用列出来。 */
export const ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** Alma 的引导窗尺寸：520×76（alma-reverse notes/01-main-process.md）。 */
export const PERMISSION_OVERLAY_WIDTH = 520;
export const PERMISSION_OVERLAY_HEIGHT = 76;
const MARGIN = 8;

/**
 * 浮层该摆哪：目标控件下方居中，并收敛进工作区。
 */
export function overlayBounds(rect: OverlayRect, workArea: OverlayRect): OverlayRect {
  const x = Math.round(rect.x + rect.width / 2 - PERMISSION_OVERLAY_WIDTH / 2);
  const below = Math.round(rect.y + rect.height + MARGIN);
  return {
    x: Math.max(workArea.x + MARGIN, Math.min(x, workArea.x + workArea.width - PERMISSION_OVERLAY_WIDTH - MARGIN)),
    y: Math.max(workArea.y + MARGIN, Math.min(below, workArea.y + workArea.height - PERMISSION_OVERLAY_HEIGHT - MARGIN)),
    width: PERMISSION_OVERLAY_WIDTH,
    height: PERMISSION_OVERLAY_HEIGHT
  };
}

/** `activity-ocr --coords` 的输出：每行 `x,y,w,h<TAB>文字`。 */
export function parseOcrLines(output: string): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const raw of output.split("\n")) {
    const tab = raw.indexOf("\t");
    if (tab < 0) continue;
    const parts = raw.slice(0, tab).split(",").map(Number);
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) continue;
    const text = raw.slice(tab + 1).trim();
    if (!text) continue;
    lines.push({ text, rect: { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! } });
  }
  return lines;
}

/**
 * 找目标行：优先命中带应用名的行（macOS 在授权页里列的是申请过权限的应用），
 * 找不到就退到整页标题。两处都没有 = 不认识这一页，调用方应收起浮层。
 */
export function findTargetRow(lines: OcrLine[], appName: string): OverlayRect | undefined {
  const wanted = appName.trim();
  const byApp = wanted ? lines.find(line => line.text.toLowerCase().includes(wanted.toLowerCase())) : undefined;
  const byTitle = lines.find(line => /辅助功能|accessibility/i.test(line.text));
  const hit = byApp ?? byTitle;
  if (!hit) return undefined;
  // Vision 只框文字本身，不含控件留白和右侧开关；按识别框高度放大到「整行」。
  const height = Math.max(hit.rect.height, 22) * 2.2;
  return { x: hit.rect.x, y: hit.rect.y - height / 3, width: hit.rect.width, height };
}
