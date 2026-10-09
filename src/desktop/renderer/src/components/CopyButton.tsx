/**
 * 复制按钮。
 *
 * 复制成功后图标临时变成对勾再自动复原，复制失败则不给成功反馈。
 * `resolveValue` 用于内容会变的场景（如实时渲染的代码块），点击时才取当前文本。
 */
import React, { useEffect, useRef, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  const requestRef = useRef<object | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
    setFailed(false);
    return () => {
      requestRef.current = undefined;
      window.clearTimeout(timerRef.current);
    };
  }, [value]);
  const feedback = copied ? "已复制" : failed ? "复制失败，点击重试" : label;
  return (
    <button
      aria-label={feedback}
      className={`${className}${copied ? " is-copied" : ""}`}
      onClick={() => {
        if (requestRef.current) return;
        const request = {};
        requestRef.current = request;
        window.clearTimeout(timerRef.current);
        setCopied(false);
        setFailed(false);
        // 去掉结尾换行：代码块渲染时会带一个，复制到别处会多出一空行。
        const text = (resolveValue?.() ?? value).replace(/\n$/, "");
        void copyToClipboard(text).then((ok) => {
          if (requestRef.current !== request) return;
          requestRef.current = undefined;
          if (!ok) { setFailed(true); return; }
          setCopied(true);
          timerRef.current = window.setTimeout(() => setCopied(false), 1_200);
        });
      }}
      title={showTooltip ? feedback : undefined}
      type="button"
    >
      <Icon name={copied ? "check" : "copy"} size={size} />
      {showLabel ? <span className="copy-button-text" data-copied={copied || undefined}>{copied ? "已复制" : label}</span> : null}
    </button>
  );
}
