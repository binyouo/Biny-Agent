/** 当前会话的生成失败提示，固定在输入框上方，不作为助手内容写入时间线。 */
import React from "react";
import { Icon } from "../Icon.js";

export function GenerationErrorBanner({ error, model, title = "生成错误", onDismiss }: {
  error: string;
  model?: string;
  title?: string;
  onDismiss(): void;
}): React.JSX.Element {
  // 保留服务返回的解释，去掉堆栈与请求转储；不推测原因，也不生成新的回复文案。
  const lines = error.split("\n");
  const end = lines.findIndex((line) => /^(at\s|file:\/\/|node:|requestBody:|url:)/.test(line.trim()));
  const message = [...new Set((end < 0 ? lines : lines.slice(0, end)).map((line) => line.trim()).filter(Boolean))].join("\n") || "生成失败，请重试。";
  return (
    <div className="biny-generation-error" role="alert">
      <Icon name="warning" size={14} />
      <div className="biny-generation-error-body">
        <p className="biny-generation-error-title">{title}</p>
        <p className="biny-generation-error-text">{message}{model ? `\nModel ${model}` : ""}</p>
      </div>
      <button aria-label="关闭错误提示" onClick={onDismiss} title="关闭" type="button">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
