/**
 * 复制文本到剪贴板。
 *
 * 优先用异步剪贴板 API，失败时退回隐藏 textarea + `execCommand` 的老办法，两条路都不行
 * 才返回 false，由调用方给出提示。
 */
export async function copyToClipboard(text: string, options: { preserveNonBreakingSpaces?: boolean } = {}): Promise<boolean> {
  // 排版文本默认还原不换行空格；原始代码的字面字符由调用方明确保留。
  const value = options.preserveNonBreakingSpaces ? text : text.replace(/\u00a0/g, " ");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 权限受限或非安全上下文，落到下面的 execCommand 路径。
  }
  try {
    // 元素必须在文档里且可聚焦才能被选中，所以只能靠 1px + 透明把它藏起来。
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.left = "0";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
