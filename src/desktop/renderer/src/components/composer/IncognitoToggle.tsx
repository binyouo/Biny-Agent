/** 会话无痕状态的输入区入口；状态与持久化由 App 管理。 */
import React from "react";
import { ComposerActionButton } from "./ComposerActionButton.js";
import { Icon } from "../Icon.js";

export function IncognitoToggle({ enabled, busy, disabled, disabledReason, onToggle }: {
  enabled: boolean;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle(): Promise<void>;
}): React.JSX.Element {
  return <ComposerActionButton
    aria-pressed={enabled}
    className="biny-memory-toggle"
    data-memory-enabled={enabled ? "true" : "false"}
    disabled={disabled}
    disabledReason={disabledReason}
    label={enabled ? "关闭当前聊天无痕模式" : "开启当前聊天无痕模式"}
    loading={busy}
    onClick={() => { void onToggle(); }}
    tooltip={enabled ? "关闭无痕聊天" : "开启无痕聊天"}
  >
    <Icon name={enabled ? "eye-off" : "eye"} size={20} />
  </ComposerActionButton>;
}
