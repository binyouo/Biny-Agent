/**
 * 设置侧栏图标。
 *
 * 与全局 `Icon` 集分开：侧栏要的是「每页一张脸」，不是通用工具图标——
 * 全部按 duotone 语言自绘（软填充底 + 描边细节 + 实心点缀），沿用 `memory` 图标的做法。
 * 新增设置页时在 `SettingsTab` 与下方 `pathFor` 各补一项。
 */
import React from "react";
import type { SettingsTab } from "./SettingsOverlay.js";

const S = { stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.6 };
const F = { fill: "currentColor", stroke: "none" };

export function SettingsNavIcon({ page, size = 17 }: { page: SettingsTab; size?: number }): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      {pathFor(page)}
    </svg>
  );
}

function pathFor(page: SettingsTab): React.JSX.Element {
  switch (page) {
    // 通用：圆角卡片叠一枚齿轮 —— 「这里是所有默认值的入口」。
    case "通用": return <>
      <rect {...S} height="15" rx="4" width="15" x="4.5" y="4.5" fill="currentColor" fillOpacity="0.1" />
      <circle {...S} cx="12" cy="12" r="2.6" />
      <path {...S} d="M12 7.2v1.6M12 15.2v1.6M7.2 12h1.6M15.2 12h1.6" />
    </>;
    // 模型：三个圆点连成的网络节点 —— 多供应商/多连接。
    case "模型": return <>
      <circle {...S} cx="5.5" cy="12" r="2.2" fill="currentColor" fillOpacity="0.12" />
      <circle {...S} cx="18.5" cy="6" r="2.2" fill="currentColor" fillOpacity="0.12" />
      <circle {...S} cx="18.5" cy="18" r="2.2" fill="currentColor" fillOpacity="0.12" />
      <path {...S} d="m7.4 11 8.9-3.8M7.4 13l8.9 3.8" />
    </>;
    // 聊天：气泡里一条回复线。
    case "聊天": return <>
      <path {...S} d="M21 15.5a2.5 2.5 0 0 1-2.5 2.5H8l-4.5 3.5v-14A2.5 2.5 0 0 1 6 5h12.5A2.5 2.5 0 0 1 21 7.5Z" fill="currentColor" fillOpacity="0.1" />
      <path {...S} d="M8 10h8M8 13h5" />
    </>;
    // Token 节省：向上的折线 + 末端箭头，落在仪表盘刻度上。
    case "Token 节省": return <>
      <path {...S} d="M4 19.5h16M4 19.5V5" opacity="0.45" />
      <path {...S} d="M6 15.5 10 11l3 3 5-6" />
      <path {...S} d="M15.5 8H18v2.5" />
      <circle {...F} cx="6" cy="15.5" r="1.3" />
    </>;
    // 用户界面：窗口框架（顶栏 + 两栏）。
    case "用户界面": return <>
      <rect {...S} height="15" rx="2.5" width="17" x="3.5" y="4.5" />
      <path {...S} d="M3.5 8.5h17" opacity="0.7" />
      <rect {...S} height="7" rx="1.5" width="6" x="6" y="10.5" fill="currentColor" fillOpacity="0.12" />
      <path {...S} d="M15 11h2.5M15 14h2.5M15 17h2.5" />
    </>;
    // 配色：调色盘 + 三个色点。
    case "配色": return <>
      <path {...S} d="M12 3.8a8.2 8.2 0 1 0 0 16.4c1.5 0 2.2-.9 2.2-1.9 0-.9-.6-1.5-.6-2.4 0-1 .8-1.7 1.9-1.7h2.3a2.4 2.4 0 0 0 2.4-2.4C20.2 7.4 16.5 3.8 12 3.8Z" fill="currentColor" fillOpacity="0.1" />
      <circle {...F} cx="8" cy="10" r="1.3" />
      <circle {...F} cx="12" cy="7.8" r="1.3" />
      <circle {...F} cx="16" cy="10" r="1.3" />
    </>;
    // 记忆：大脑双半球的简化版 —— 软底 + 中线 + 记忆点。
    case "记忆": return <>
      <path {...S} d="M12 4.5c2.4-1.2 4.8-.1 5 2.4 2.3.4 3.4 3 2.2 4.9 1.3 1.8.5 4.5-1.9 4.7-.4 2.1-3 3.3-5.3 2.2-2.3 1.1-4.9-.1-5.3-2.2-2.4-.2-3.2-2.9-1.9-4.7-1.2-1.9-.1-4.5 2.2-4.9.2-2.5 2.6-3.6 5-2.4Z" fill="currentColor" fillOpacity="0.1" />
      <path {...S} d="M12 4.8v13.9" opacity="0.6" />
      <circle {...F} cx="8.6" cy="10.4" r="1.2" />
      <circle {...F} cx="15.4" cy="13.6" r="1.2" />
    </>;
    // 技能：魔杖 + 三点闪光。
    case "技能": return <>
      <path {...S} d="m5 19 9.5-9.5" />
      <path {...S} d="m15.5 4.5.8 2.6 2.6.8-2.6.8-.8 2.6-.8-2.6-2.6-.8 2.6-.8.8-2.6Z" fill="currentColor" fillOpacity="0.14" />
      <circle {...F} cx="18.5" cy="14.5" r="1.1" />
      <circle {...F} cx="20" cy="7" r="0.9" />
    </>;
    // MCP 服务器：两层机架 + 指示灯。
    case "MCP 服务器": return <>
      <rect {...S} height="6" rx="1.8" width="16" x="4" y="4" fill="currentColor" fillOpacity="0.1" />
      <rect {...S} height="6" rx="1.8" width="16" x="4" y="14" fill="currentColor" fillOpacity="0.1" />
      <circle {...F} cx="7.5" cy="7" r="1" />
      <circle {...F} cx="7.5" cy="17" r="1" />
      <path {...S} d="M12 7h4.5M12 17h4.5" opacity="0.7" />
    </>;
    // 插件：拼图块（实心小件）。
    case "插件": return <>
      <path {...S} d="M14.8 4.6a2.1 2.1 0 1 1 4.2 0c0 .5.2.8.7.8h1.1A1.2 1.2 0 0 1 22 6.6v1.1c0 .5-.3.8-.8.8a2.1 2.1 0 1 0 0 4.2c.5 0 .8.3.8.8v1.1a1.2 1.2 0 0 1-1.2 1.2h-1.1c-.5 0-.8.3-.8.8a2.1 2.1 0 1 1-4.2 0c0-.5-.3-.8-.8-.8h-1.1a1.2 1.2 0 0 1-1.2-1.2v-1.1c0-.5-.3-.8-.8-.8a2.1 2.1 0 1 0 0-4.2c.5 0 .8-.3.8-.8V6.6A1.2 1.2 0 0 1 11 5.4h1.1c.5 0 .8-.3.8-.8Z" fill="currentColor" fillOpacity="0.1" transform="translate(-2.5 0)" />
    </>;
    // 网络搜索：放大镜里一条结果行。
    case "网络搜索": return <>
      <circle {...S} cx="11" cy="11" r="6.5" fill="currentColor" fillOpacity="0.1" />
      <path {...S} d="m21 21-4.2-4.2" />
      <path {...S} d="M8.5 10h5M8.5 12.5h3.5" opacity="0.75" />
    </>;
    // 浏览器：指南针圆环 + 指针。
    case "浏览器": return <>
      <circle {...S} cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity="0.1" />
      <path {...S} d="m15.5 8.5-1.8 5.2-5.2 1.8 1.8-5.2 5.2-1.8Z" />
      <circle {...F} cx="12" cy="12" r="1.1" />
    </>;
    // Appshots：取景框 + 中心快门点。
    case "Appshots": return <>
      <path {...S} d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <rect {...S} height="7" rx="1.8" width="9" x="7.5" y="8.5" fill="currentColor" fillOpacity="0.12" />
      <circle {...F} cx="12" cy="12" r="1.4" />
    </>;
    // Computer Use：显示器里的指针。
    case "Computer Use": return <>
      <rect {...S} height="11.5" rx="2" width="17" x="3.5" y="5" />
      <path {...S} d="M12 16.5V19M9 19.5h6" opacity="0.7" />
      <path {...S} d="m10 8.5 4.8 2.6-2.5.9-1 2.5-1.3-6Z" fill="currentColor" fillOpacity="0.14" />
    </>;
    // 隐私脱敏：盾牌里的钥匙孔。
    case "隐私脱敏": return <>
      <path {...S} d="M12 3.8 5.5 6.5v5c0 4.3 2.7 7.3 6.5 8.9 3.8-1.6 6.5-4.6 6.5-8.9v-5L12 3.8Z" fill="currentColor" fillOpacity="0.1" />
      <circle {...S} cx="12" cy="10.5" r="1.8" />
      <path {...S} d="M12 12.3v2.7" />
    </>;
    // Computer History：屏幕上的时钟。
    case "Computer History": return <>
      <rect {...S} height="11.5" rx="2" width="17" x="3.5" y="5" />
      <path {...S} d="M12 16.5V19M9 19.5h6" opacity="0.7" />
      <circle {...S} cx="12" cy="10.5" r="2.6" fill="currentColor" fillOpacity="0.12" />
      <path {...S} d="M12 9.4v1.1l.9.6" />
    </>;
    // 导入：向下箭头落进托盘。
    case "导入": return <>
      <path {...S} d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      <path {...S} d="M12 4v9" />
      <path {...S} d="m8 9.5 4 4 4-4" />
      <circle {...F} cx="12" cy="16.5" r="1" opacity="0.6" />
    </>;
    // 关于：i 字母的圆章。
    case "关于": return <>
      <circle {...S} cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity="0.1" />
      <path {...S} d="M12 11v5" />
      <circle {...F} cx="12" cy="8" r="1.2" />
    </>;
  }
}
