/** Composer 的发送/停止状态切换。 */
import React from "react";
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";

export function SendOrStopButton({
  disabled,
  disabledReason,
  hasDraft,
  onSend,
  onStop,
  running,
  stopPending
}: {
  disabled: boolean;
  disabledReason?: string;
  hasDraft: boolean;
  onSend(): void;
  onStop(): void;
  running: boolean;
  stopPending: boolean;
}): React.JSX.Element {
  // 生成中始终保留停止入口；出现新草稿时再并列显示排队发送。
  const showSend = !running || hasDraft;
  // 停止请求发出后运行态可能还要等待 provider/tool 收尾；这段时间仍要允许用户重试取消。
  const sendLabel = running ? "加入队列" : "发送消息";
  const sendTooltip = disabledReason ?? (disabled
    ? "输入内容或附件后发送消息"
    : running ? "加入待发送队列 — 点「插话」立即注入本轮，或等本轮结束后自动发送" : "发送消息");

  return (
    <span className="biny-send-button-group">
      {running ? (
        <span className={`biny-send-button-anchor${stopPending ? " is-pending" : ""}`} aria-busy={stopPending || undefined}>
          <ComposerActionButton
            active
            className="biny-send-button is-stop"
            label={stopPending ? "正在停止" : "停止生成"}
            loading={stopPending}
            onClick={onStop}
            tooltip={stopPending ? "正在停止当前运行，点击可重试" : "停止当前运行"}
          >
            <Icon name="stop" size={15} />
          </ComposerActionButton>
        </span>
      ) : null}
      {showSend ? (
        <span className="biny-send-button-anchor">
          <ComposerActionButton
            className="biny-send-button"
            disabled={disabled}
            disabledReason={disabled ? disabledReason ?? "输入内容或附件后发送消息" : undefined}
            label={sendLabel}
            onClick={onSend}
            tooltip={sendTooltip}
          >
            <Icon name="arrow-up" size={15} />
          </ComposerActionButton>
        </span>
      ) : null}
    </span>
  );
}
