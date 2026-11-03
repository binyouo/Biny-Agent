import type { Dock, NativeImage } from "electron";

/** 两帧仅在启动期间切换；调用方在 bootstrap 终态、窗口销毁或退出时结束。 */
export function animateDockStartup(dock: Pick<Dock, "setIcon">, frames: { open: NativeImage; closed: NativeImage }, reducedMotion: () => boolean): () => void {
  dock.setIcon(frames.open);
  let finished = reducedMotion();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (closed) dock.setIcon(frames.open);
  };
  const blink = (): void => {
    if (finished) return;
    if (reducedMotion()) { finish(); return; }
    closed = !closed;
    dock.setIcon(closed ? frames.closed : frames.open);
    timer = setTimeout(blink, closed ? 130 : 1_600);
    timer.unref();
  };
  if (!finished) {
    timer = setTimeout(blink, 450);
    timer.unref();
  }
  return finish;
}
