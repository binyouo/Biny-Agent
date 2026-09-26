/** 图片保持原始比例与动画，加载完成时淡入；失败可重试，下载保留原始文件。 */
import React, { useState } from "react";
import { DownloadButton } from "./MarkdownDownload.js";

export function MarkdownImage({ src, alt, title }: { src: string; alt: string; title?: string }): React.JSX.Element {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  return <span className={`markdown-image-frame is-${status}`}>
    {status === "error" ? <span role="alert">{alt || "图片"}加载失败 <button type="button" onClick={() => { setStatus("loading"); setRevision(value => value + 1); }}>重试</button></span> : <img key={revision} alt={alt} src={src} title={title} className="markdown-image" loading="lazy" decoding="async" onLoad={() => setStatus("ready")} onError={() => setStatus("error")} />}
    <span className="markdown-image-actions"><DownloadButton label="下载图片" filename={imageFilename(src, alt)} getContent={async () => {
      const response = await fetch(src);
      if (!response.ok) throw new Error("Image download failed");
      return response.blob();
    }} /></span>
  </span>;
}
function imageFilename(src: string, alt: string): string {
  const match = /\.(png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/i.exec(src);
  const mime = /^data:image\/([\w+.-]+)/i.exec(src)?.[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg");
  return `${(alt || "image").replace(/[/\\:*?"<>|]/g, "_").slice(0, 80)}.${match?.[1] ?? mime ?? "png"}`;
}
