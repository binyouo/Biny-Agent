/** 回合产出使用独立文件卡片，列数随聊天容器宽度变化。 */
import { memo } from "react";
import type { TimelineChangedFile } from "../../sessionTimeline.js";
import { FileLinkCard } from "../FileLinkCard.js";

export const ChangesSummary = memo(function ChangesSummary({ files, onPreviewFile }: {
  files: TimelineChangedFile[];
  onPreviewFile(path: string): void;
}): React.JSX.Element {
  return <section aria-label="本轮产出" className="biny-output-cards">
    {files.map((file) => <FileLinkCard key={file.path} path={file.path} description={`${file.operation === "write" ? "写入文件" : "更新文件"} · ${file.path}`} onPreviewFile={onPreviewFile} />)}
  </section>;
});
