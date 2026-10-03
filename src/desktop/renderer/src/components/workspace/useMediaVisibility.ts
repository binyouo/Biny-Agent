/** 隐藏的媒体不保留活动播放实例；只监听容器的祖先属性。 */
import { useEffect, useState, type RefObject } from "react";

export function useMediaVisibility(container: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const ancestors: Element[] = [];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
    const update = () => setVisible(!element.ownerDocument.hidden && !ancestors.some(ancestor => ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true"));
    const observer = new MutationObserver(update);
    for (const ancestor of ancestors) observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden"] });
    element.ownerDocument.addEventListener("visibilitychange", update);
    update();
    return () => { observer.disconnect(); element.ownerDocument.removeEventListener("visibilitychange", update); };
  }, [container]);
  return visible;
}
