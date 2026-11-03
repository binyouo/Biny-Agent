import { useLayoutEffect, useState } from "react";
import { useClosingPresence, type PresencePhase } from "./useClosingPresence.js";

export function useDropdownPresence(open: boolean): { present: boolean; phase: PresencePhase } {
  const [closeMs, setCloseMs] = useState(0);
  const presence = useClosingPresence(open, closeMs);
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const syncMotion = (): void => {
      const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur"));
      setCloseMs(media.matches ? 0 : Number.isFinite(duration) ? duration : 150);
    };
    syncMotion();
    media.addEventListener("change", syncMotion);
    return () => media.removeEventListener("change", syncMotion);
  }, []);
  return {
    present: open || (presence.present && closeMs > 0),
    phase: open ? closeMs === 0 ? "open" : presence.phase : presence.present ? "closing" : "closed"
  };
}
