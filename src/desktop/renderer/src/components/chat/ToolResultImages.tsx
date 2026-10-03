import React, { memo, useMemo } from "react";
import { MarkdownImage } from "../MarkdownImage.js";

import { toolResultImages } from "../../toolImagePresentation.js";

export const ToolResultImages = memo(function ToolResultImages({ result }: { result: unknown }): React.JSX.Element | null {
  const presentation = useMemo(() => toolResultImages(result), [result]);
  if (!presentation) return null;
  return <div className="chat-tool-images" aria-label="工具图片结果">
    {presentation.images.map(source => <MarkdownImage key={source} src={source} alt={presentation.caption ?? "工具图片结果"} local />)}
  </div>;
});
