/** 聊天滚动的贴底、用户接管与展开锚点；不持有会话数据。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { Icon } from "../Icon.js";

/** 距底小于该值视为「钉在底部」：新内容进来继续贴底，回底按钮也在这时收起。 */
const PIN_DISTANCE = 48;
/** 距底超过该值才显示回底按钮；与 PIN_DISTANCE 之间是滞回区，防阈值附近抖动。 */
const JUMP_BUTTON_DISTANCE = 160;

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function ChatScroll({ children, onScrolledChange, sessionId, streaming }: { children: React.ReactNode; onScrolledChange(scrolled: boolean): void; sessionId?: string; streaming: boolean }): React.JSX.Element {
  const [scrollActive, setScrollActive] = useState(false);
  const [jumpVisible, setJumpVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  // 「钉在底部」用 ref 不用 state：流式期间滚动事件极频繁，贴底状态翻转不该触发重渲染。
  const pinnedRef = useRef(true);
  const scrollAnchorRef = useRef<{ element: HTMLElement; top: number; until: number } | undefined>(undefined);
  const anchorFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const scrollToPinnedBottom = (): void => {
    const container = containerRef.current;
    if (!container || !pinnedRef.current || scrollAnchorRef.current) return;
    const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
    if (Math.abs(container.scrollTop - bottom) > 1) container.scrollTop = bottom;
  };

  // 切会话从头贴底；内容随后异步长高，由下面的观察器持续贴住。
  useLayoutEffect(() => {
    pinnedRef.current = true;
    scrollAnchorRef.current = undefined;
    setJumpVisible(false);
    scrollToPinnedBottom();
    return () => {
      if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
      scrollAnchorRef.current = undefined;
    };
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const schedulePinnedScroll = (): void => {
      if (scrollFrameRef.current !== undefined) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = undefined;
        scrollToPinnedBottom();
        setJumpVisible(!pinnedRef.current && distanceFromBottom(container) > JUMP_BUTTON_DISTANCE);
      });
    };
    // 内容高度变化（含字体、图片、公式加载）和视口变化共享一次帧调度。
    // 高度未变的 DOM 更新不需要贴底，也不再监听整棵正文的字符变化。
    const observer = new ResizeObserver(schedulePinnedScroll);
    observer.observe(content);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = undefined;
    };
  }, []);

  // 捕获点击时布局尚未变化。折叠动画期间锁住所点标题的位置，暂停自动贴底。
  const anchorActivity = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const toggle = target.closest("[data-activity-toggle]:not(:disabled)");
    const element = toggle?.closest<HTMLElement>("[data-activity-anchor]");
    if (!element) return;
    if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
    pinnedRef.current = false;
    scrollAnchorRef.current = { element, top: element.getBoundingClientRect().top, until: performance.now() + 600 };
    const holdAnchor = (): void => {
      const anchor = scrollAnchorRef.current;
      const container = containerRef.current;
      if (!anchor || !container || !anchor.element.isConnected) {
        scrollAnchorRef.current = undefined;
        return;
      }
      const delta = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 1) container.scrollTop += delta;
      if (performance.now() < anchor.until) anchorFrameRef.current = requestAnimationFrame(holdAnchor);
      else {
        scrollAnchorRef.current = undefined;
        anchorFrameRef.current = undefined;
        // 折叠动画结束后如果仍在底部，恢复自动跟随；展开导致离底则继续尊重用户位置。
        pinnedRef.current = distanceFromBottom(container) < PIN_DISTANCE;
      }
    };
    anchorFrameRef.current = requestAnimationFrame(holdAnchor);
  };

  // 用户主动滚动立即接管；不拦截滚轮、不改写原生 scrollTop/scrollTo。
  const releaseAnchor = (): void => {
    if (anchorFrameRef.current !== undefined) cancelAnimationFrame(anchorFrameRef.current);
    anchorFrameRef.current = undefined;
    scrollAnchorRef.current = undefined;
  };

  const revealScrollbar = (): void => {
    setScrollActive(true);
    if (fadeTimerRef.current !== undefined) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = undefined;
      setScrollActive(false);
    }, 1000);
  };

  const handleScroll = (): void => {
    revealScrollbar();
    const container = containerRef.current;
    if (!container) return;
    const distance = distanceFromBottom(container);
    // 标题栏底缘阴影跟随「是否离开顶部」（参考应用 showBottomShadow 语义）。
    onScrolledChange(container.scrollTop > 0);
    if (!scrollAnchorRef.current) pinnedRef.current = distance < PIN_DISTANCE;
    if (distance > JUMP_BUTTON_DISTANCE) setJumpVisible(true);
    else if (distance < PIN_DISTANCE) setJumpVisible(false);
  };

  // 直达用瞬时滚动而非平滑滚动：流式期间内容一直在长，平滑滚动追不上新底部。
  const jumpToBottom = (): void => {
    const container = containerRef.current;
    if (!container) return;
    releaseAnchor();
    pinnedRef.current = true;
    container.scrollTop = container.scrollHeight;
    setJumpVisible(false);
  };

  return (
    <>
      <div
        className={`biny-chat-scroll${scrollActive ? " is-scroll-active" : ""}`}
        onClickCapture={anchorActivity}
        onKeyDownCapture={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) releaseAnchor();
        }}
        onScroll={handleScroll}
        onTouchStart={releaseAnchor}
        onWheel={() => { releaseAnchor(); revealScrollbar(); }}
        ref={containerRef}
      >
        <div className="biny-chat-scroll-content" ref={contentRef}>{children}</div>
      </div>
      <button
        aria-hidden={!jumpVisible}
        aria-label={streaming ? "正在生成，回到底部" : "回到底部"}
        className={`biny-jump-bottom${jumpVisible ? " is-visible" : ""}`}
        onClick={jumpToBottom}
        tabIndex={jumpVisible ? 0 : -1}
        title={streaming ? "正在生成，回到底部" : "回到底部"}
        type="button"
      >
        {streaming
          ? <ThinkingOrb aria-hidden="true" className="biny-jump-bottom-orb" size={20} state="solving" theme="auto" />
          : <Icon name="arrow-down" size={16} />}
      </button>
    </>
  );
}
