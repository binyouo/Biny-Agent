import { useEffect, useRef, useState } from "react";

const openEyes = new URL("../assets/app-icon.png", import.meta.url).href;
const closedEyes = new URL("../assets/app-icon-blink.png", import.meta.url).href;

interface AppIconProps {
  size: number;
  className?: string;
  animated?: boolean;
  active?: boolean;
  hidden?: boolean;
  /** 只递增已确认保存的回执；挂载时的值不重播。 */
  memoryRevision?: number;
}

export function AppIcon({ size, className, animated = false, active = false, hidden = false, memoryRevision = 0 }: AppIconProps): React.JSX.Element {
  const [sleeping, setSleeping] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [background, setBackground] = useState(() => typeof document !== "undefined" && document.hidden);
  const [reducedMotion, setReducedMotion] = useState(false);
  const lastMemoryRevision = useRef(memoryRevision);
  const paused = hidden || background || reducedMotion;

  useEffect(() => {
    if (!animated) return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = (): void => { setBackground(document.hidden); setReducedMotion(media?.matches ?? false); };
    update();
    document.addEventListener("visibilitychange", update);
    media?.addEventListener("change", update);
    return () => { document.removeEventListener("visibilitychange", update); media?.removeEventListener("change", update); };
  }, [animated]);

  useEffect(() => {
    setSleeping(false);
    if (!animated || active || paused) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = (): void => {
      setSleeping(false);
      clearTimeout(timer);
      timer = setTimeout(() => setSleeping(true), 60_000);
    };
    wake();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("focus", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("focus", wake);
    };
  }, [active, animated, paused, memoryRevision]);

  useEffect(() => {
    const fresh = memoryRevision > lastMemoryRevision.current;
    lastMemoryRevision.current = memoryRevision;
    setRemembering(false);
    if (!fresh || !animated || active || paused) return;
    setRemembering(true);
    const timer = setTimeout(() => setRemembering(false), 2_100);
    return () => clearTimeout(timer);
  }, [active, animated, memoryRevision, paused]);

  const state = active ? "listen" : remembering ? "remember" : sleeping ? "sleep" : "idle";
  return <span aria-hidden="true" className={`app-icon${className ? ` ${className}` : ""}`}
    data-animated={animated} data-paused={paused} data-state={state} style={{ width:size, height:size }}>
    <span className="app-icon-art">
      <img src={openEyes} width={size} height={size} alt="" draggable={false} />
      <img className="app-icon-closed" src={closedEyes} width={size} height={size} alt="" draggable={false} />
    </span>
  </span>;
}
