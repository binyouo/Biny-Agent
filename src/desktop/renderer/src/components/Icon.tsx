/**
 * 内置图标集。
 *
 * 全部内联 SVG，不引外部图标库：图标数量有限，内联能省一个依赖，也避免网络字体/雪碧图。
 * 新增图标要同时补 `IconName` 联合类型和下面的绘制分支，漏一处会有类型错误。
 */
import React from "react";
import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "add"
  | "archive"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-up-right"
  | "bell"
  | "branch"
  | "brain"
  | "brain-off"
  | "brain-spark"
  | "calendar"
  | "chart"
  | "check"
  | "circle-add"
  | "circle-check"
  | "circle-close"
  | "chevron"
  | "close"
  | "loader"
  | "code"
  | "compose"
  | "commit"
  | "corner-down-right"
  | "globe"
  | "grip-vertical"
  | "copy"
  | "cube"
  | "cpu"
  | "database"
  | "diff"
  | "display"
  | "download"
  | "edit"
  | "external"
  | "eye"
  | "eye-off"
  | "file"
  | "file-diff"
  | "file-pen"
  | "file-text"
  | "flask"
  | "fold"
  | "folder"
  | "folder-open"
  | "folder-panel"
  | "help"
  | "home"
  | "info"
  | "list-tree"
  | "lock"
  | "layout-grid"
  | "layout-list"
  | "menu"
  | "message"
  | "mic"
  | "minus"
  | "moon"
  | "more"
  | "network"
  | "paperclip"
  | "panel-right"
  | "pin"
  | "person"
  | "plug"
  | "power"
  | "puzzle"
  | "pull-request"
  | "refresh"
  | "remote"
  | "search"
  | "server"
  | "shield"
  | "sidebar"
  | "settings"
  | "site"
  | "spark"
  | "stop"
  | "sun"
  | "terminal"
  | "timer"
  | "trash"
  | "volume"
  | "volume-off"
  | "warning"
  | "sliders"
  | "wand"
  | "wrench";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {pathFor(name)}
    </svg>
  );
}

export function BinyMark({ size = 30 }: { size?: number }): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="biny-mark" height={size} viewBox="0 0 32 32" width={size}>
      <rect fill="currentColor" height="30" rx="9" width="30" x="1" y="1" />
      <path d="M10 8.5h6.7c4 0 6.4 1.8 6.4 4.8 0 1.8-.9 3.2-2.6 4 2.2.7 3.4 2.2 3.4 4.4 0 3.4-2.8 5.8-7.2 5.8H10a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Zm3.2 3v4.3h3.3c1.8 0 2.8-.8 2.8-2.2 0-1.4-1-2.1-3-2.1h-3.1Zm0 7.2v5.8h3.7c2.1 0 3.2-1 3.2-2.9 0-1.9-1.2-2.9-3.6-2.9h-3.3Z" fill="var(--mark-ink)" />
    </svg>
  );
}

function pathFor(name: IconName): React.JSX.Element {
  const common = { stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.5 };
  switch (name) {
    case "activity": return <path {...common} d="M22 12h-4l-3 9L9 3l-3 9H2" />;
    case "add": return <><path {...common} d="M5 12h14" /><path {...common} d="M12 5v14" /></>;
    case "archive": return <><rect {...common} height="14" rx="1.5" width="17" x="3.5" y="6.5" /><path {...common} d="M3.5 9h17M9 13h6" /></>;
    case "arrow-down": return <path {...common} d="m6 13 6 6 6-6M12 19V5" />;
    case "arrow-left": return <path {...common} d="M19 12H5m7-7-7 7 7 7" />;
    case "arrow-right": return <path {...common} d="M5 12h14m-7-7 7 7-7 7" />;
    case "arrow-up": return <path {...common} d="m6 11 6-6 6 6M12 5v14" />;
    case "arrow-up-right": return <path {...common} d="M7 17 17 7M9 7h8v8" />;
    case "bell": return <><path {...common} d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path {...common} d="M10 21h4" /></>;
    case "branch": return <><circle {...common} cx="7" cy="5" r="2" /><circle {...common} cx="17" cy="19" r="2" /><path {...common} d="M7 7v5c0 3.9 3.1 7 7 7h1M17 5v4c0 2.2-1.8 4-4 4H7" /></>;
    case "brain": return <><path {...common} d="M9.5 5.2A3 3 0 0 0 6 7.8a3.2 3.2 0 0 0 .2 5.9A3 3 0 0 0 9 18.5c.8 1.2 2.2 2 3 2V5.1a3.5 3.5 0 0 0-2.5.1Z" /><path {...common} d="M14.5 5.2A3 3 0 0 1 18 7.8a3.2 3.2 0 0 1-.2 5.9 3 3 0 0 1-2.8 4.8c-.8 1.2-2.2 2-3 2V5.1a3.5 3.5 0 0 1 2.5.1ZM7 9.5h2M15 9.5h2M7.5 14h2M14.5 14h2" /></>;
    // 记忆开关专用：斜杠脑=关闭（对应规范「斜杠表示关闭/隐私保护」），缩小的脑+右上星星=开启（星星代表已启用）。
    case "brain-off": return <><path {...common} d="M9.5 5.2A3 3 0 0 0 6 7.8a3.2 3.2 0 0 0 .2 5.9A3 3 0 0 0 9 18.5c.8 1.2 2.2 2 3 2V5.1a3.5 3.5 0 0 0-2.5.1Z" /><path {...common} d="M14.5 5.2A3 3 0 0 1 18 7.8a3.2 3.2 0 0 1-.2 5.9 3 3 0 0 1-2.8 4.8c-.8 1.2-2.2 2-3 2V5.1a3.5 3.5 0 0 1 2.5.1ZM7 9.5h2M15 9.5h2M7.5 14h2M14.5 14h2" /><path {...common} d="m4.5 4.5 15 15" /></>;
    case "brain-spark": return <><g {...common} strokeWidth={1.8} transform="translate(-1.6 2.2) scale(0.82)"><path d="M9.5 5.2A3 3 0 0 0 6 7.8a3.2 3.2 0 0 0 .2 5.9A3 3 0 0 0 9 18.5c.8 1.2 2.2 2 3 2V5.1a3.5 3.5 0 0 0-2.5.1Z" /><path d="M14.5 5.2A3 3 0 0 1 18 7.8a3.2 3.2 0 0 1-.2 5.9 3 3 0 0 1-2.8 4.8c-.8 1.2-2.2 2-3 2V5.1a3.5 3.5 0 0 1 2.5.1ZM7 9.5h2M15 9.5h2M7.5 14h2M14.5 14h2" /></g><path {...common} d="M18.4 2c.32 1.86 1.22 2.76 3.08 3.08-1.86.32-2.76 1.22-3.08 3.08-.32-1.86-1.22-2.76-3.08-3.08 1.86-.32 2.76-1.22 3.08-3.08Z" /><path {...common} d="M20.9 8.8v3.6M19.1 10.6h3.6" /></>;
    case "calendar": return <><rect {...common} height="16" rx="2" width="16" x="4" y="5" /><path {...common} d="M8 3v4M16 3v4M4 10h16M8 14h3" /></>;
    case "chart": return <><path {...common} d="M4 20V5M4 20h17" /><path {...common} d="M8 17v-5M12 17V7M16 17v-8" /></>;
    case "check": return <path {...common} d="m5 12 4.2 4.2L19 6.5" />;
    case "circle-add": return <><circle {...common} cx="12" cy="12" r="10" /><path {...common} d="M8 12h8" /><path {...common} d="M12 8v8" /></>;
    // 圆圈对勾 / 圆圈叉：测试连接按钮的结果态（成功/失败）。
    case "circle-check": return <><circle {...common} cx="12" cy="12" r="10" /><path {...common} d="m8.5 12.4 2.3 2.3 4.7-5.4" /></>;
    case "circle-close": return <><circle {...common} cx="12" cy="12" r="10" /><path {...common} d="m15 9-6 6" /><path {...common} d="m9 9 6 6" /></>;
    case "chevron": return <path {...common} d="m6 9 6 6 6-6" />;
    case "close": return <path {...common} d="m6 6 12 12M18 6 6 18" />;
    // 缺口圆环：配合旋转动画充当进行中指示（单路径，旋转中心即图标中心）。
    case "loader": return <path {...common} d="M21 12a9 9 0 1 1-9-9" />;
    case "code": return <path {...common} d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M14 5l-4 14" />;
    case "compose": return <><path {...common} d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path {...common} d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></>;
    case "commit": return <><circle {...common} cx="12" cy="12" r="4" /><path {...common} d="M3 12h5m8 0h5" /></>;
    case "corner-down-right": return <path {...common} d="M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12" />;
    case "globe": return <><circle {...common} cx="12" cy="12" r="9" /><ellipse {...common} cx="12" cy="12" rx="4" ry="9" /><path {...common} d="M3 12h18" /></>;
    case "grip-vertical": return <><circle cx="9" cy="5" fill="currentColor" r="1" /><circle cx="15" cy="5" fill="currentColor" r="1" /><circle cx="9" cy="12" fill="currentColor" r="1" /><circle cx="15" cy="12" fill="currentColor" r="1" /><circle cx="9" cy="19" fill="currentColor" r="1" /><circle cx="15" cy="19" fill="currentColor" r="1" /></>;
    case "copy": return <><rect {...common} height="12" rx="2" width="12" x="8" y="8" /><path {...common} d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>;
    case "cube": return <><path {...common} d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path {...common} d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>;
    case "cpu": return <><rect {...common} height="12" rx="2" width="12" x="6" y="6" /><path {...common} d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M10 10h4v4h-4z" /></>;
    case "database": return <><ellipse {...common} cx="12" cy="5.5" rx="7.5" ry="2.8" /><path {...common} d="M4.5 5.5v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.5M4.5 12v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12" /></>;
    case "diff": return <><path {...common} d="M7 4v16M17 4v16M4 8h6M14 16h6" /><path {...common} d="m17 6 2 2-2 2M17 14l-2 2 2 2" /></>;
    case "display": return <><rect {...common} height="13" rx="2" width="18" x="3" y="4" /><path {...common} d="M9 21h6M12 17v4" /></>;
    case "download": return <><path {...common} d="M12 3v11" /><path {...common} d="m7 10 5 5 5-5" /><path {...common} d="M5 20h14" /></>;
    case "edit": return <><path {...common} d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path {...common} d="m15 5 4 4" /></>;
    case "external": return <><path {...common} d="M14 5h5v5M19 5l-8 8" /><path {...common} d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>;
    case "eye": return <><path {...common} d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" /><circle {...common} cx="12" cy="12" r="3" /></>;
    case "eye-off": return <><path {...common} d="m4 4 16 16M9.9 9.9A3 3 0 0 0 12 15a3 3 0 0 0 2.1-.9M7 7.4C4.4 8.8 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.3 4.3-.9M14.1 9A3 3 0 0 0 12 9c-.4 0-.7.1-1 .2M10.6 5.2C11.1 5.1 11.5 5 12 5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.1 2.8" /></>;
    case "file": return <path {...common} d="M7 3.5h6l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm6 0v4h4" />;
    case "file-diff": return <><path {...common} d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M9 13h6M12 10v6M9 19h6" /></>;
    case "file-pen": return <><path {...common} d="M12 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v4M14 2v6h6M15 18l5-5 3 3-5 5-4 1 1-4ZM19 14l3 3" /></>;
    case "file-text": return <><path {...common} d="M7 3.5h6l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm6 0v4h4" /><path {...common} d="M9 12h6M9 15.5h6M9 8.5h1.5" /></>;
    case "flask": return <><path {...common} d="M9 3h6M10 3v6l-5.3 9.1A1.3 1.3 0 0 0 5.8 20h12.4a1.3 1.3 0 0 0 1.1-1.9L14 9V3" /><path {...common} d="M7.2 15h9.6" /></>;
    case "fold": return <><path {...common} d="M2 12h20" /><path {...common} d="M12 2v6.5" /><path {...common} d="m16 7-4-4-4 4" /><path {...common} d="M12 22v-6.5" /><path {...common} d="m8 17 4 4 4-4" /></>;
    case "folder": return <path {...common} d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />;
    case "folder-open": return <path {...common} d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H16a2 2 0 0 1 2 2v2" />;
    case "folder-panel": return <><path {...common} d="M7.5 5h4l2 2H19a1.5 1.5 0 0 1 1.5 1.5V16" /><path {...common} d="M3.5 9h6l2-2h7v11.5A1.5 1.5 0 0 1 17 20H5a1.5 1.5 0 0 1-1.5-1.5V9Z" /></>;
    case "help": return <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M9.8 9a2.3 2.3 0 0 1 4.5.7c0 1.8-2.3 2-2.3 3.8M12 17.4h.01" /></>;
    case "home": return <path {...common} d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-9Z" />;
    case "info": return <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M12 11v5" /><path {...common} d="M12 8h.01" /></>;
    case "list-tree": return <><path {...common} d="M21 12h-8" /><path {...common} d="M21 6H8" /><path {...common} d="M21 18h-8" /><path {...common} d="M3 6v4c0 1.1.9 2 2 2h3" /><path {...common} d="M3 10v6c0 1.1.9 2 2 2h3" /></>;
    case "lock": return <><rect {...common} height="9" rx="1.5" width="14" x="5" y="10" /><path {...common} d="M8 10V7a4 4 0 0 1 8 0v3" /></>;
    // 能力菜单布局切换：网格 = 四宫格；列表 = 两块 + 右侧行（对应 lucide LayoutGrid / LayoutList）。
    case "layout-grid": return <><rect {...common} height="7" rx="1.5" width="7" x="3.5" y="3.5" /><rect {...common} height="7" rx="1.5" width="7" x="13.5" y="3.5" /><rect {...common} height="7" rx="1.5" width="7" x="3.5" y="13.5" /><rect {...common} height="7" rx="1.5" width="7" x="13.5" y="13.5" /></>;
    case "layout-list": return <><rect {...common} height="7" rx="1.5" width="7" x="3.5" y="3.5" /><rect {...common} height="7" rx="1.5" width="7" x="3.5" y="13.5" /><path {...common} d="M14 5h6.5M14 10h6.5M14 16h6.5M14 21h6.5" /></>;
    case "menu": return <path {...common} d="M5 7h14M5 12h14M5 17h14" />;
    case "minus": return <path {...common} d="M5 12h14" />;
    case "message": return <path {...common} d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />;
    case "mic": return <><rect {...common} height="11" rx="3.5" width="7" x="8.5" y="3" /><path {...common} d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></>;
    case "moon": return <path {...common} d="M20.5 13.2A8 8 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7Z" />;
    case "more": return <><circle cx="5" cy="12" fill="currentColor" r="1.5" /><circle cx="12" cy="12" fill="currentColor" r="1.5" /><circle cx="19" cy="12" fill="currentColor" r="1.5" /></>;
    case "network": return <><circle {...common} cx="5" cy="12" r="2" /><circle {...common} cx="19" cy="6" r="2" /><circle {...common} cx="19" cy="18" r="2" /><path {...common} d="m6.8 11.2 10.4-4.4M6.8 12.8l10.4 4.4" /></>;
    case "paperclip": return <path {...common} d="m9 12.5 5.9-5.9a3 3 0 0 1 4.2 4.2l-7.4 7.4a5 5 0 0 1-7.1-7.1l7.2-7.2M7.5 14l6.4-6.4" />;
    case "panel-right": return <><rect {...common} height="16" rx="2" width="19" x="2.5" y="4" /><path {...common} d="M16 4v16" /></>;
    // OpenAI 官方图标集（ChatGPT/Codex 会话置顶同款）的 Pin 图钉：实心填充，
    // 16px 小尺寸下仍清晰；置顶态用 is-active 强调色区分。
    case "pin": return <path d="M12.864 3.26a3.01 3.01 0 0 1 4.576-.378l3.678 3.678a3.01 3.01 0 0 1-.378 4.576l-4.261 3.044c-.315.225-.479.55-.479.82v2.5c0 1.407-.96 2.451-2.024 2.91-1.071.462-2.497.437-3.52-.586l-2.433-2.433-4.316 4.316a1 1 0 1 1-1.414-1.414l4.316-4.316-2.433-2.434c-1.023-1.022-1.048-2.447-.586-3.519C4.049 8.959 5.093 8 6.5 8H9c.27 0 .595-.164.82-.479z" fill="currentColor" />;
    case "person": return <><circle {...common} cx="12" cy="8" r="5" /><path {...common} d="M20 21a8 8 0 0 0-16 0" /></>;
    case "plug": return <><path {...common} d="M12 22v-5" /><path {...common} d="M15 8V2" /><path {...common} d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" /><path {...common} d="M9 8V2" /></>;
    case "power": return <><path {...common} d="M12 2v10" /><path {...common} d="M18.4 6.6a9 9 0 1 1-12.8 0" /></>;
    case "puzzle": return <path {...common} d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />;
    case "pull-request": return <><circle {...common} cx="7" cy="5" r="2" /><circle {...common} cx="7" cy="19" r="2" /><circle {...common} cx="17" cy="19" r="2" /><path {...common} d="M7 7v10M14 5h1a2 2 0 0 1 2 2v10M14 2l-3 3 3 3" /></>;
    case "refresh": return <><path {...common} d="M20 11a8 8 0 1 0 1 4" /><path {...common} d="M20 5v6h-6" /></>;
    case "remote": return <><rect {...common} height="14" rx="2" width="20" x="2" y="3" /><path {...common} d="M8 21h8M12 17v4" /></>;
    case "search": return <><path {...common} d="m21 21-4.34-4.34" /><circle {...common} cx="11" cy="11" r="8" /></>;
    case "server": return <><rect {...common} height="6" rx="1.5" width="16" x="4" y="3" /><rect {...common} height="6" rx="1.5" width="16" x="4" y="15" /><path {...common} d="M8 6h.01M8 18h.01M12 6h5M12 18h5" /></>;
    case "shield": return <path {...common} d="M12 3.5 5 6.5v5c0 4.6 2.9 7.8 7 9.5 4.1-1.7 7-4.9 7-9.5v-5L12 3.5Z" />;
    case "sidebar": return <><rect {...common} height="18" rx="2" width="18" x="3" y="3" /><path {...common} d="M9 3v18" /></>;
    case "settings": return <><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>;
    case "site": return <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3.5 12h17M12 3c2.4 2.5 3.5 5.5 3.5 9S14.4 18.5 12 21c-2.4-2.5-3.5-5.5-3.5-9S9.6 5.5 12 3Z" /></>;
    case "spark": return <><path {...common} d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path {...common} d="M20 2v4M22 4h-4" /><circle {...common} cx="4" cy="20" r="2" /></>;
    case "stop": return <rect fill="currentColor" height="9" rx="2" width="9" x="7.5" y="7.5" />;
    case "sun": return <><circle {...common} cx="12" cy="12" r="4" /><path {...common} d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3 7 7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7" /></>;
    case "terminal": return <><rect {...common} height="16" rx="2" width="19" x="2.5" y="4" /><path {...common} d="m6 9 3 3-3 3M12 15h5" /></>;
    case "timer": return <><line {...common} x1="10" x2="14" y1="2" y2="2" /><line {...common} x1="12" x2="15" y1="14" y2="11" /><circle {...common} cx="12" cy="14" r="8" /></>;
    case "trash": return <><path {...common} d="M3 6h18" /><path {...common} d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path {...common} d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path {...common} d="M10 11v6M14 11v6" /></>;
    case "volume": return <><path {...common} d="M11 5 6.5 9H3.5v6h3L11 19V5Z" /><path {...common} d="M14.5 9.5a3.5 3.5 0 0 1 0 5M17 7a7 7 0 0 1 0 10" /></>;
    case "volume-off": return <><path {...common} d="M11 5 6.5 9H3.5v6h3L11 19V5Z" /><path {...common} d="m15 10 5 4M20 10l-5 4" /></>;
    case "warning": return <><path {...common} d="M11 4.5 3.7 18a1 1 0 0 0 .9 1.5h14.8a1 1 0 0 0 .9-1.5L13 4.5a1.1 1.1 0 0 0-2 0Z" /><path {...common} d="M12 9v4M12 16.5h.01" /></>;
    case "sliders": return <path {...common} d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />;
    case "wand": return <><path {...common} d="m5 19 10.5-10.5M7 5h.01M17 4h.01M19 9h.01M5 12h.01M17 16h.01" /><path {...common} d="m15.5 3.5.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></>;
    case "wrench": return <path {...common} d="M14.5 6.2a4.5 4.5 0 0 0-5.8 5.7l-5.1 5.2a1.8 1.8 0 0 0 2.5 2.5l5.2-5.1a4.5 4.5 0 0 0 5.7-5.8l-3 3-2.5-.7-.7-2.5 3-3Z" />;
  }
}
