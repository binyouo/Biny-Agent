/**
 * Desktop 最外层产品框架。
 *
 * 这里保留 Astryx Theme，供设置与文件检查器等复用组件继续获取主题上下文；产品外壳本身
 * 只负责组合侧栏、首页、对话区和全局浮层，避免 UI 框架的默认导航结构改变真实业务状态流。
 */
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useEffect, useState } from "react";
import type { SidebarLayoutSnapshot } from "../../../sidebarLayout.js";
import type { DesktopThemePreference } from "../../../protocol.js";

interface DesktopShellProps {
  children: React.ReactNode;
  overlays?: React.ReactNode;
  rightPanel?: React.ReactNode;
  rightSidebar?: {
    open: boolean;
    resizing: boolean;
    width: number;
  };
  sideNav: React.ReactNode;
  sidebarLayout: SidebarLayoutSnapshot;
  starting?: boolean;
  theme: DesktopThemePreference;
}

/**
 * Peek 固定展开时的流内占位。
 *
 * 始终留在 flex 流中，只有 pinning 状态把它切到共享的流宽度；这样 spacer 和
 * 侧栏主体使用同一个动画时钟，固定抽屉切回普通布局时也不会重复推拉主区。
 */
function SidebarPinSpacer({ active }: { active: boolean }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="biny-sidebar-pin-spacer"
      data-active={active ? "true" : undefined}
    />
  );
}

export function DesktopShell({ children, overlays, rightPanel, rightSidebar, sideNav, sidebarLayout, starting = false, theme }: DesktopShellProps): React.JSX.Element {
  const [revealed, setRevealed] = useState(!starting);
  useEffect(() => {
    if (revealed) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const skipMotion = (): void => {
      if (!starting && motion.matches) setRevealed(true);
    };
    skipMotion();
    motion.addEventListener("change", skipMotion);
    return () => motion.removeEventListener("change", skipMotion);
  }, [revealed, starting]);
  const rootStyle = {
    "--biny-sidebar-visual-width": `${sidebarLayout.visualWidth}px`,
    "--biny-sidebar-flow-width": `${sidebarLayout.flowWidth}px`,
    "--biny-sidebar-content-width": `${sidebarLayout.contentWidth}px`,
    // 右栏使用已按聊天可用空间收敛的宽度，两栏始终并排，禁止覆盖正文和输入框。
    "--biny-inspector-flow-width": `${rightSidebar?.open ? rightSidebar.width : 0}px`
  } as React.CSSProperties;
  return (
    <Theme mode={theme} theme={neutralTheme}>
      <div
        className="desktop-root biny-root"
        data-startup={revealed ? undefined : starting ? "loading" : "revealing"}
        data-sidebar-mode={sidebarLayout.mode}
        data-sidebar-resizing={sidebarLayout.resizing ? "true" : undefined}
        data-inspector-resizing={rightSidebar?.resizing ? "true" : undefined}
        data-sidebar-transition={sidebarLayout.transition === "idle" ? undefined : sidebarLayout.transition}
        style={rootStyle}
        onAnimationEnd={(event) => {
          // 聊天页最后出现的是输入区，其他页面则以主区收尾；局部动画不能提前结束启动。
          if (event.animationName !== "biny-startup-reveal" || !(event.target instanceof HTMLElement)) return;
          if (event.target.matches(".biny-chat-composer, .biny-content-shell")) setRevealed(true);
        }}
      >
        <div className="biny-app-shell" inert={starting}>
          <main className="biny-content-shell" aria-busy={starting}>{children}</main>
          <div className="biny-sidebar-block">
            <SidebarPinSpacer active={sidebarLayout.transition === "pinning"} />
            {sideNav}
          </div>
          {rightPanel}
        </div>
        {overlays}
      </div>
    </Theme>
  );
}
