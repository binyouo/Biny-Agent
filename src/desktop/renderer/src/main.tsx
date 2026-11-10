/**
 * 渲染进程入口。
 *
 * 只做挂载：找到 root 节点并渲染 `App`，不放任何业务逻辑。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThreadBriefProvider } from "./threadBrief/ThreadBriefProvider.js";
import { App } from "./App.js";
import "./styles/layers.css";
// KaTeX 公式样式在入口引入：组件里引 CSS 会让 node 侧的 SSR 测试挂掉（tsx 不认 .css）。
import "katex/dist/katex.min.css";

// 样式表按平台分叉（macOS 玻璃侧栏），挂载前先把平台标到根节点上。
document.documentElement.dataset.platform = navigator.userAgent.includes("Mac OS") ? "darwin" : "other";

const root = document.getElementById("root");
if (!root) throw new Error("Biny renderer root is missing.");

createRoot(root).render(
  <StrictMode>
    <ThreadBriefProvider><App /></ThreadBriefProvider>
  </StrictMode>
);
