import { completeSyntaxColors } from "../../../../../appearance/palette.js";
import type { ThemePalette } from "../../../../../appearance/types.js";

export function ThemePreview({ palette, name }: { palette: ThemePalette; name: string }): React.JSX.Element {
  const colors = palette.base_30;
  const syntax = completeSyntaxColors(palette);
  return <div className="theme-preview" style={{ background: colors.black, color: colors.white, borderColor: colors.line }}>
    <div className="theme-preview-title" style={{ background: colors.one_bg, borderColor: colors.line }}>{name || "主题预览"}</div>
    <div className="theme-preview-body">
      <div className="theme-preview-sidebar" style={{ background: colors.darker_black, color: colors.grey_fg }}>
        <strong style={{ color: colors.folder_bg }}>▰ 工作区</strong><span style={{ color: colors.blue, background: colors.one_bg2 }}>示例对话</span><span>最近打开</span>
      </div>
      <div className="theme-preview-chat"><p style={{ background: colors.one_bg, color: colors.white }}>你好，介绍一下这个项目。</p>
        <p>文字、链接和代码使用同一套配色。<a style={{ color: colors.blue }}>查看详情</a></p>
        <pre style={{ background: syntax.base00, color: syntax.base05 }}><span style={{ color: syntax.base0E }}>const </span><span style={{ color: syntax.base08 }}>message</span> = <span style={{ color: syntax.base0B }}>"Hello"</span>;<br /><span style={{ color: syntax.base03 }}>// 示例代码</span></pre>
        <div className="theme-preview-controls"><span style={{ color: colors.green }}>● 已完成</span><button type="button" tabIndex={-1} style={{ background: colors.blue, color: colors.black }}>发送</button></div>
      </div>
    </div>
  </div>;
}
