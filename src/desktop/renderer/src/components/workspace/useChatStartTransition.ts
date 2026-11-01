import { useLayoutEffect, useRef, useState } from "react";
import type { PendingPrompt } from "../Workspace.js";

/** 只衔接欢迎页首发的几何变化；发送与消息接管仍由 App 和时间线负责。 */
export function useChatStartTransition({ hero, projectId, sessionId, pendingPrompt }: {
  hero: boolean;
  projectId?: string;
  sessionId?: string;
  pendingPrompt?: PendingPrompt;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const source = useRef<{ projectId?: string; composer: DOMRect; hero: DOMRect } | undefined>(undefined);
  const active = useRef<{ projectId?: string; sessionId?: string; cancel(): void } | undefined>(undefined);
  const [keepHero, setKeepHero] = useState(hero);

  useLayoutEffect(() => {
    const running = active.current;
    if (running && (hero || running.projectId !== projectId
      || (sessionId !== running.sessionId && sessionId !== pendingPrompt?.sessionId))) {
      running.cancel();
      setKeepHero(false);
    } else if (running) {
      running.sessionId = sessionId;
    }

    const composer = composerRef.current;
    const heroNode = heroRef.current;
    const body = bodyRef.current;
    if (hero && composer && heroNode && body) {
      setKeepHero(true);
      const measure = (): void => {
        source.current = { projectId, composer: composer.getBoundingClientRect(), hero: heroNode.getBoundingClientRect() };
      };
      measure();
      // 输入高度、建议短语与窗口宽度都会改变居中位置，只在欢迎页观察这些尺寸。
      const observer = new ResizeObserver(measure);
      observer.observe(composer);
      observer.observe(heroNode);
      if (body.parentElement) observer.observe(body.parentElement);
      return () => observer.disconnect();
    }

    const previous = source.current;
    source.current = undefined;
    if (!previous) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!composer || !heroNode || !body || !pendingPrompt || previous.projectId !== projectId
      || pendingPrompt.projectId !== projectId || reducedMotion.matches || previous.composer.width === 0
      || typeof composer.animate !== "function") {
      setKeepHero(false);
      return;
    }

    const target = composer.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    // 欢迎内容留在原位置淡出，聊天区立即取得最终布局与真实消息节点。
    heroNode.style.top = `${previous.hero.top - bodyBounds.top}px`;
    heroNode.style.left = `${previous.hero.left - bodyBounds.left}px`;
    heroNode.style.width = `${previous.hero.width}px`;
    heroNode.style.height = `${previous.hero.height}px`;
    composer.style.willChange = "transform, width";
    const x = previous.composer.left + previous.composer.width / 2 - target.left - target.width / 2;
    const y = previous.composer.top - target.top;
    const slide = { duration: 500, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
    const move = composer.animate([
      { transform: `translate(${x}px, ${y}px)`, width: `${previous.composer.width}px` },
      { transform: "translate(0px, 0px)", width: `${target.width}px` }
    ], slide);
    const fade = heroNode.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-out", fill: "forwards" });
    const animations = [move, fade];
    const bubble = body.querySelector<HTMLElement>(".user-bubble");
    if (bubble) animations.push(bubble.animate([
      { opacity: 0, transform: `translateY(${previous.composer.top - bubble.getBoundingClientRect().top}px)` },
      { opacity: 1, transform: "translateY(0px)" }
    ], slide));

    const cancel = (): void => {
      for (const animation of animations) { animation.onfinish = null; animation.cancel(); }
      composer.style.willChange = "";
      for (const property of ["top", "left", "width", "height"]) heroNode.style.removeProperty(property);
      reducedMotion.removeEventListener("change", finish);
      active.current = undefined;
    };
    const finish = (): void => { cancel(); setKeepHero(false); };
    fade.onfinish = () => setKeepHero(false);
    move.onfinish = finish;
    reducedMotion.addEventListener("change", finish);
    active.current = { projectId, sessionId, cancel };
  }, [hero, projectId, sessionId, pendingPrompt]);

  useLayoutEffect(() => () => active.current?.cancel(), []);
  return { bodyRef, composerRef, heroRef, keepHero };
}
