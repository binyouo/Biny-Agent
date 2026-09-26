/**
 * 桌面端左侧栏宽度常量与约束。
 *
 * 展开态可以拖拽调宽，但主进程（持久化）和渲染进程（拖拽实时收敛）共用同一组上下限，
 * 避免两边算出不同宽度导致重启后侧栏跳动；收起态固定 rail 宽度。
 */
export const DEFAULT_SIDEBAR_WIDTH = 260;
/** 下限保证项目名和会话标题还能读，上限避免侧栏挤掉对话区。 */
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 400;
/** Biny rail 需要容纳 macOS 红绿灯和顶部按钮簇，视觉宽度固定为 78px。 */
export const SIDEBAR_RAIL_WIDTH = 78;
/** 与左侧栏几何/卡片显隐共用的过渡时长一致，预览固定不得提前结束。 */
export const SIDEBAR_TRANSITION_MS = 500;
export const SIDEBAR_CONTENT_FADE_MS = SIDEBAR_TRANSITION_MS;
export const SIDEBAR_PEEK_OPEN_DELAY_MS = 120;
export const SIDEBAR_PEEK_LEAVE_GRACE_MS = 160;
export const SIDEBAR_PEEK_CLOSE_MS = 200;
export const SIDEBAR_PEEK_PINNING_MS = SIDEBAR_TRANSITION_MS;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}
