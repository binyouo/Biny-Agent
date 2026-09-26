/**
 * 复制按钮。
 *
 * 复制成功后图标临时变成对勾再自动复原，复制失败则不给成功反馈。
 * `resolveValue` 用于内容会变的场景（如实时渲染的代码块），点击时才取当前文本。
 */
import React, { useState } from "react";
import { copyToClipboard } from "../copyToClipboard.js";
import { Icon } from "./Icon.js";

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  size?: number;
  resolveValue?: () => string;
  /** 图标旁展示文字标签（复制成功变为「已复制」）。 */
  showLabel?: boolean;
  showTooltip?: boolean;
}

export function CopyButton({
  value,
  label = "复制",
  className = "copy-button",
  size = 12,
  resolveValue,
  showLabel = false,
  showTooltip = true
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={copied ? "已复制" : label}
      className={`${className}${copied ? " is-copied" : ""}`}
      onClick={() => {
        // 去掉结尾换行：代码块渲染时会带一个，复制到别处会多出一空行。
        const text = (resolveValue?.() ?? value).replace(/\n$/, "");
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_200);
        });
      }}
      title={showTooltip ? copied ? "已复制" : label : undefined}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
      {showLabel ? <span className="copy-button-text" data-copied={copied || undefined}>{copied ? "已复制" : label}</span> : null}
    </button>
  );
}
