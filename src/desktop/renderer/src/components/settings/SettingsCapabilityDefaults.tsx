/** 新对话的工具/技能默认范围；原生单选组支持键盘切换，提交仍走聊天草稿。 */
import type { CapabilitySelectionMode } from "../../../../../agent/capabilitySelection.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

export function SettingsCapabilityDefaults(): React.JSX.Element | null {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return null;
  return <div className="settings-sections capability-default-settings">
    {([{ label: "工具", field: "defaultToolSelection" }, { label: "技能", field: "defaultSkillSelection" }] as const).map(({ label, field }) => <section key={field}>
      <h3>默认{label}选择</h3><p>为新对话设置默认的{label}选择，发送前可在输入框调整。</p>
      <div aria-label={`默认${label}选择`} className="chat-capability-options" role="radiogroup">
        {(["auto", "all", "none"] as CapabilitySelectionMode[]).map((mode) => <label className="chat-capability-option" key={mode}>
          <input type="radio" name={field} value={mode} checked={draft.chatParams[field] === mode} onChange={() => setChatParams({ ...draft.chatParams, [field]: mode })} />
          <span><strong>{mode === "auto" ? "自动" : mode === "all" ? `全部${label}` : `禁用${label}`}</strong>
            <small>{mode === "auto" ? `根据上下文自动选择需要的${label}。` : mode === "all" ? `为每个对话启用所有可用${label}。` : `默认不调用${label}。`}</small></span>
        </label>)}
      </div>
    </section>)}
  </div>;
}
