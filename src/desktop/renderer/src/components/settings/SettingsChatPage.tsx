/** 聊天参数、展示偏好、能力范围和压缩共用一个草稿与保存事务。 */
import type { ChatResponseSettings } from "../../../../../config/schema.js";
import { useState } from "react";
import { DEFAULT_CHAT_RESPONSE } from "../../chatResponseSettings.js";
import { SettingsChatParams } from "./SettingsChatParams.js";
import { SettingsCapabilityDefaults } from "./SettingsCapabilityDefaults.js";
import { SettingsCompaction } from "./SettingsCompaction.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const responseOptions: Array<{ key: keyof ChatResponseSettings; label: string; detail?: string }> = [
  { key: "streaming", label: "启用流式响应", detail: "边生成边显示。" },
  { key: "showTokenUsage", label: "显示令牌使用情况", detail: "在回复菜单中查看。" },
  { key: "markdown", label: "启用 Markdown 渲染" },
  { key: "singleDollarMath", label: "渲染单美元符号数学公式", detail: "识别 $…$ 公式，可能将金额误判为公式。" },
  { key: "collapseThinking", label: "默认折叠思考过程" },
  { key: "openLinksInBrowser", label: "在内置浏览器打开链接", detail: "Cmd/Ctrl + 点击可用系统浏览器打开。" }
];

export function SettingsChatPage(): React.JSX.Element {
  const { draft, setChatParams } = useSettingsDraft();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (!draft) return <div className="settings-sections"><section><p>正在加载聊天设置…</p></section></div>;
  const response = { ...DEFAULT_CHAT_RESPONSE, ...draft.chatParams.response };
  return (
    <div className="settings-preferences settings-chat-page">
      <section className="settings-preference-section">
        <h3>回复显示</h3>
        <div className="settings-row-group">
          {responseOptions.map(({ key, label, detail }) => <SettingsSwitch key={key} label={label} detail={detail}
            checked={response[key]} disabled={key === "singleDollarMath" && !response.markdown}
            onChange={(value) => setChatParams({ ...draft.chatParams, response: { ...draft.chatParams.response, [key]: value } })} />)}
        </div>
      </section>
      <SettingsCapabilityDefaults />
      <details className="settings-advanced" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary><span><strong>高级设置</strong><small>采样参数、上下文压缩与实验性编辑工具</small></span></summary>
        {advancedOpen ? <div className="settings-advanced-content">
          <SettingsChatParams />
          <SettingsCompaction />
          <div className="settings-sections">
            <section>
              <h3>编辑工具模式</h3>
              <SettingsSwitch checked={draft.chatParams.hashlineEdit === true} label="Hashline 编辑模式（实验）"
                detail="Read 输出行哈希，Edit 通过行标签定位修改。保存后从下一回合生效。"
                onChange={(hashlineEdit) => setChatParams({ ...draft.chatParams, hashlineEdit })} />
            </section>
          </div>
        </div> : null}
      </details>
    </div>
  );
}
