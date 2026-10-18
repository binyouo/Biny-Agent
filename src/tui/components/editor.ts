import { CURSOR_MARKER, Editor, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";

/** 只装饰框架渲染结果；编辑、补全、历史和光标仍由 Editor 持有。 */
export class BinyEditor extends Editor {
  constructor(ui: TUI, editorTheme: EditorTheme) {
    super(ui, editorTheme, { paddingX: 0 });
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    // 极窄终端不能容纳边框和宽字符；保留输入与 IME 标记，不交给框架的一列换行路径。
    if (safeWidth < 10) {
      return [`${this.focused ? CURSOR_MARKER : ""}${truncateToWidth(`› ${this.getText().split("\n")[0] ?? ""}`, safeWidth, "…")}`];
    }
    const innerWidth = safeWidth - 4;
    const lines = super.render(innerWidth);
    // Editor 的末尾可能是补全列表；只框住两个原生水平边界之间的编辑区域。
    let bottom = lines.length - 1;
    for (const [index, line] of lines.entries()) {
      if (index > 0 && visibleWidth(line) === innerWidth && line.replace(/\u001b\[[0-9;]*m/gu, "").startsWith("─")) bottom = index;
    }
    return lines.map((line, index) => {
      if (index === 0 || index === bottom) {
        return this.borderColor(index === 0 ? "╭─" : "╰─") + line + this.borderColor(index === 0 ? "─╮" : "─╯");
      }
      if (index > bottom) return `   ${line} `;
      const text = index === 1 ? line.replace(/^\/[a-z_-]+/iu, (command) => theme.fg("accent", command)) : line;
      return this.borderColor("│") + (index === 1 ? theme.fg("accent", "› ") : "  ")
        + text + this.borderColor("│");
    });
  }
}
