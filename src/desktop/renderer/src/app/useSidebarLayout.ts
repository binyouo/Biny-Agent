/**
 * 桌面端侧栏状态控制器。
 *
 * Sidebar 只负责展示，rail 提交、收起/peek 定时器、原生 pointer 生命周期和展开宽度的
 * 拖拽都在这里协调。collapsed/peek 是临时表面状态；展开宽度可拖拽，拖拽中只更新本地
 * 状态，松手后才通过主进程落盘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SIDEBAR_LAYOUT, resolveSidebarLayout, type SidebarBaseMode, type SidebarLayoutSnapshot, type SidebarPeekPhase } from "../../../sidebarLayout.js";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_PEEK_CLOSE_MS, SIDEBAR_PEEK_LEAVE_GRACE_MS, SIDEBAR_PEEK_OPEN_DELAY_MS, SIDEBAR_PEEK_PINNING_MS } from "../../../sidebarSizing.js";

const SIDEBAR_RAIL_STORAGE_KEY = "biny.desktop.sidebar-rail";
const PEEK_TRIGGER_WIDTH = 12;

export interface SidebarPeekHandlers {
  onPointerEnter: React.PointerEventHandler<HTMLElement>;
  onPointerLeave: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onPointerUp?: React.PointerEventHandler<HTMLElement>;
}

export interface SidebarResizeHandlers {
  onResizeStart(): void;
  onWidthChange(width: number): void;
  onResizeEnd(width: number): void;
}

interface UseSidebarLayoutResult {
  layout: SidebarLayoutSnapshot;
  drawerHandlers: SidebarPeekHandlers;
  drawerRef: React.RefObject<HTMLElement | null>;
  resizeHandlers: SidebarResizeHandlers;
  triggerHandlers: SidebarPeekHandlers;
  /** bootstrap 回填持久化的展开宽度；只更新本地状态，不触发落盘。 */
  setExpandedWidth(width: number): void;
  toggle(): void;
}

function readRailPreference(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeRailPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_RAIL_STORAGE_KEY, String(enabled));
  } catch {
    // Renderer 本地存储不可用时仍保留本次会话的 rail 状态。
  }
}

export function useSidebarLayout(): UseSidebarLayoutResult {
  const [baseMode, setBaseMode] = useState<SidebarBaseMode>(() => readRailPreference() ? "rail" : DEFAULT_SIDEBAR_LAYOUT.baseMode);
  const [peekPhase, setPeekPhase] = useState<SidebarPeekPhase>("idle");
  const [expandedWidth, setExpandedWidthState] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);
  const baseModeRef = useRef(baseMode);
  const peekPhaseRef = useRef<SidebarPeekPhase>("idle");
  const expandedWidthRef = useRef(expandedWidth);
  const drawerRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverLockedRef = useRef(false);

  const setBaseModeValue = useCallback((next: SidebarBaseMode): void => {
    baseModeRef.current = next;
    setBaseMode(next);
    if (next === "rail") writeRailPreference(true);
    else if (next === "expanded") writeRailPreference(false);
  }, []);

  const setPeekPhaseValue = useCallback((next: SidebarPeekPhase): void => {
    peekPhaseRef.current = next;
    setPeekPhase(next);
  }, []);

  const setExpandedWidth = useCallback((width: number): void => {
    const next = clampSidebarWidth(width);
    expandedWidthRef.current = next;
    setExpandedWidthState(next);
  }, []);

  const resizeHandlers = useMemo<SidebarResizeHandlers>(() => ({
    onResizeStart: () => setResizing(true),
    onWidthChange: setExpandedWidth,
    onResizeEnd: (width) => {
      setExpandedWidth(width);
      setResizing(false);
      void window.biny.setSidebarWidth(expandedWidthRef.current);
    }
  }), [setExpandedWidth]);

  const clearTimer = useCallback((timerRef: { current: ReturnType<typeof setTimeout> | undefined }): void => {
    if (timerRef.current === undefined) return;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const clearTimers = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    clearTimer(closeAnimationTimerRef);
    clearTimer(pinTimerRef);
  }, [clearTimer]);

  const closePeek = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "idle" || peekPhaseRef.current === "pinning" || peekPhaseRef.current === "peekExited") return;
    if (peekPhaseRef.current === "peekClosing") return;
    setPeekPhaseValue("peekClosing");
    closeAnimationTimerRef.current = setTimeout(() => {
      closeAnimationTimerRef.current = undefined;
      if (peekPhaseRef.current !== "peekClosing") return;
      setPeekPhaseValue("peekExited");
      closeAnimationTimerRef.current = setTimeout(() => {
        closeAnimationTimerRef.current = undefined;
        if (peekPhaseRef.current === "peekExited") setPeekPhaseValue("idle");
      }, 0);
    }, SIDEBAR_PEEK_CLOSE_MS);
  }, [clearTimer, setPeekPhaseValue]);

  const scheduleClose = useCallback((): void => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "idle" || peekPhaseRef.current === "pinning") return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      if (!hoverLockedRef.current) closePeek();
    }, SIDEBAR_PEEK_LEAVE_GRACE_MS);
  }, [clearTimer, closePeek]);

  const keepPeekOpen = useCallback((): void => {
    hoverLockedRef.current = true;
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    // 注意不能取消 closeAnimationTimerRef，也不能把 peekClosing/peekExited 拉回
    // peeking：关闭动画会可见地滑出，滑出过程扫过停在原地的指针时，Chromium
    // 会合成 enter/leave，若在这里复活抽屉，就会形成开↔关乒乓（持续闪烁）。
    // 关闭一旦启动必须完成；重开只能等回到 idle 后重新触发悬停意图。
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "pinning") return;
  }, [clearTimer]);

  const scheduleOpen = useCallback((): void => {
    if (baseModeRef.current !== "collapsed" || peekPhaseRef.current === "pinning" || peekPhaseRef.current === "peeking") return;
    clearTimer(closeTimerRef);
    // 不取消 closeAnimationTimerRef：关闭进行中时只预排打开意图，最终在 idle 才生效。
    if (openTimerRef.current !== undefined) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = undefined;
      if (baseModeRef.current === "collapsed" && hoverLockedRef.current && peekPhaseRef.current === "idle") setPeekPhaseValue("peeking");
    }, SIDEBAR_PEEK_OPEN_DELAY_MS);
  }, [clearTimer, setPeekPhaseValue]);

  const pinPeek = useCallback((): void => {
    clearTimers();
    // 只有已打开的预览需要从覆盖层固定到布局；普通展开直接交给共享宽度过渡，
    // 避免末尾从 fixed 切回流内时更换阴影、层级和底色。
    if (peekPhaseRef.current !== "peeking") {
      hoverLockedRef.current = false;
      setPeekPhaseValue("idle");
      setBaseModeValue("expanded");
      return;
    }
    hoverLockedRef.current = true;
    setPeekPhaseValue("pinning");
    pinTimerRef.current = setTimeout(() => {
      pinTimerRef.current = undefined;
      if (peekPhaseRef.current !== "pinning") return;
      setBaseModeValue("expanded");
      setPeekPhaseValue("idle");
    }, SIDEBAR_PEEK_PINNING_MS);
  }, [clearTimers, setBaseModeValue, setPeekPhaseValue]);

  const collapse = useCallback((): void => {
    clearTimers();
    hoverLockedRef.current = false;
    setPeekPhaseValue("idle");
    setBaseModeValue("collapsed");
  }, [clearTimers, setBaseModeValue, setPeekPhaseValue]);

  const toggle = useCallback((): void => {
    if (baseModeRef.current === "collapsed" && peekPhaseRef.current !== "pinning") pinPeek();
    else collapse();
  }, [collapse, pinPeek]);

  const onPointerEnter = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
    scheduleOpen();
  }, [keepPeekOpen, scheduleOpen]);

  const onPointerLeave = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    // 滑入/滑出动画期间指针没动也会合成 leave（keyframe 平移会让抽屉暂时盖不住
    // 指针坐标）；指针仍落在抽屉终态宽度内就不算真正离开，否则会开↔关乒乓。
    // 真正的离开（右移出抽屉、或移入上方 chrome 后再移出）由坐标与 window
    // pointermove 处理器共同兜底。
    if (event.clientX <= expandedWidthRef.current) return;
    hoverLockedRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    hoverLockedRef.current = true;
    clearTimer(closeTimerRef);
  }, [clearTimer]);

  const onPointerUp = useCallback<React.PointerEventHandler<HTMLElement>>(() => {
    keepPeekOpen();
  }, [keepPeekOpen]);

  useEffect(() => {
    if (baseMode !== "collapsed") {
      clearTimers();
      hoverLockedRef.current = false;
      if (peekPhaseRef.current !== "idle") setPeekPhaseValue("idle");
      return;
    }
    const handlePointerMove = (event: PointerEvent): void => {
      const target = event.target;
      const element = target instanceof Element ? target : undefined;
      const drawer = drawerRef.current;
      const inDrawer = Boolean(drawer && target instanceof Node && drawer.contains(target));
      const inTrigger = Boolean(element?.closest(".biny-sidebar-peek-trigger"));
      const inChrome = Boolean(element?.closest(".biny-sidebar-topbar-floating"));
      if (inDrawer || inTrigger || inChrome || event.clientX <= PEEK_TRIGGER_WIDTH) {
        keepPeekOpen();
        if ((inTrigger || event.clientX <= PEEK_TRIGGER_WIDTH) && peekPhaseRef.current === "idle") scheduleOpen();
        return;
      }
      hoverLockedRef.current = false;
      scheduleClose();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [baseMode, clearTimers, keepPeekOpen, scheduleClose, scheduleOpen, setPeekPhaseValue]);

  useEffect(() => {
    const handleWindowBlur = (): void => {
      hoverLockedRef.current = false;
      clearTimers();
      closePeek();
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [clearTimers, closePeek]);

  useEffect(() => () => {
    clearTimers();
  }, [clearTimers]);

  const layout = useMemo(() => resolveSidebarLayout({ baseMode, peekPhase, expandedWidth, resizing }), [baseMode, expandedWidth, peekPhase, resizing]);

  // 流式消息会更新父组件，稳定回调集合以保留侧栏的 memo 边界。
  const drawerHandlers = useMemo(() => ({ onPointerEnter, onPointerLeave, onPointerMove, onPointerDown, onPointerUp }),
    [onPointerEnter, onPointerLeave, onPointerMove, onPointerDown, onPointerUp]);
  const triggerHandlers = useMemo(() => ({ onPointerEnter, onPointerLeave, onPointerMove }),
    [onPointerEnter, onPointerLeave, onPointerMove]);

  return {
    layout,
    drawerHandlers,
    drawerRef,
    resizeHandlers,
    triggerHandlers,
    setExpandedWidth,
    toggle
  };
}
