import { createContext, type ReactNode } from "react";

/** 右栏接收当前有效渲染快照，预览不依赖工作区文件或运行时。 */
export interface RenderingPreview {
  id: string;
  title: string;
  source: string;
  language: string;
  filename: string;
  renderPreview(): ReactNode;
}

export const RenderingPreviewContext = createContext<((preview: RenderingPreview) => void) | undefined>(undefined);
