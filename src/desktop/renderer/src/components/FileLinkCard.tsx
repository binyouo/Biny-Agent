/**
 * 消息内本地文件链接的卡片呈现（资源卡样式）。
 *
 * Markdown 链接指向本地路径时不再渲染成普通 <a>，而是收成一张
 * 「类型角标 + 文件名 + 目录副标题 + 右上箭头」的卡片，点击在右侧预览。
 * inline-flex 让卡片既保持文本流内的行内语义，又具备卡片的视觉密度。
 */
import { Icon } from "./Icon.js";
import { FileTypeMarker } from "./workspace/FileTypeMarker.js";

export function FileLinkCard({ path, description, projectFile, onPreviewFile }: { path: string; description?: string; projectFile?: boolean; onPreviewFile(path: string): void }): React.JSX.Element {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  const name = separator < 0 ? normalized : normalized.slice(separator + 1);
  const dir = separator < 0 ? "" : normalized.slice(0, separator);
  return (
    <button className="markdown-file-link" onClick={() => onPreviewFile(path)} title={`在右侧预览 ${path}`} type="button">
      <span className="markdown-file-link-icon"><FileTypeMarker name={name} /></span>
      <span className="markdown-file-link-main">
        <span className="markdown-file-link-title"><span className="markdown-file-link-name">{name}</span>{projectFile ? <span className="biny-output-location">项目</span> : null}</span>
        {description || dir ? <span className="markdown-file-link-dir">{description ?? dir}</span> : null}
      </span>
      <span className="markdown-file-link-open"><Icon name="arrow-up-right" size={13} /></span>
    </button>
  );
}
