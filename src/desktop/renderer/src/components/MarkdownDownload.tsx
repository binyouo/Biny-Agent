/** 消息资源下载按钮；原始 Blob 不重编码，保留 GIF 等动画。 */
import React, { useState } from "react";
import { Icon } from "./Icon.js";

export function DownloadButton({ label, filename, getContent, showLabel }: {
  label: string; filename: string; showLabel?: boolean; getContent(): Blob | Promise<Blob>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <><button type="button" className="markdown-download" aria-label={label} title={label} disabled={busy} onClick={async () => {
    setBusy(true); setError(false);
    try {
      const content = await getContent();
      const url = URL.createObjectURL(content);
      const link = document.createElement("a");
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
      // 下载导航需要先消费 URL，下一事件循环再释放。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(true); }
    finally { setBusy(false); }
  }}>{showLabel ? label : <Icon name={busy ? "loader" : "download"} size={14} />}</button>{error ? <span role="alert" className="markdown-resource-error">下载失败，请重试</span> : null}</>;
}
