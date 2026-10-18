import { useEffect, useId, useRef, useState } from "react";
import { useAppearance } from "../appearanceContext.js";
import { PocketSpiritArtwork } from "./PocketSpiritArtwork.js";

interface AppIconProps {
  size: number;
  className?: string;
  animated?: boolean;
  active?: boolean;
  hidden?: boolean;
  tile?: boolean;
  /** 只递增已确认保存的回执；挂载时的值不重播。 */
  memoryRevision?: number;
}

export function AppIcon({ size, className, animated = false, active = false, hidden = false, tile = false, memoryRevision = 0 }: AppIconProps): React.JSX.Element {
  const id = useId();
  const appearance = useAppearance();
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
  return <span aria-hidden="true" className={`app-icon pocket-spirit${className ? ` ${className}` : ""}`}
    data-animated={animated} data-paused={paused} data-state={state} style={{ width:size, height:size }}>
    <PocketSpiritArtwork dark={appearance.mode === "dark"} id={id} tile={tile} />
  </span>;
}
