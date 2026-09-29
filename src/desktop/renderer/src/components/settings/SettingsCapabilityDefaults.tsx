/** 新对话的工具/技能默认范围；原生单选组支持键盘切换，提交仍走聊天草稿。 */
import type { CapabilitySelectionMode } from "../../../../../agent/capabilitySelection.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsSegmentedControl } from "./SettingsSegmentedControl.js";

export function SettingsCapabilityDefaults(): React.JSX.Element | null {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return null;
  return <section className="settings-preference-section capability-default-settings">
    <h3>新对话默认能力</h3>
    <div className="settings-row-group">
      {([{ label: "工具", field: "defaultToolSelection" }, { label: "技能", field: "defaultSkillSelection" }] as const).map(({ label, field }) => <div className="settings-preference-row" key={field}>
        <div className="settings-row-copy"><strong>默认{label}选择</strong><p>自动按上下文选择；发送前仍可在输入框调整。</p></div>
        <SettingsSegmentedControl<CapabilitySelectionMode> label={`默认${label}选择`} value={draft.chatParams[field]} options={[
          { value: "auto", label: "自动" }, { value: "all", label: `全部${label}` }, { value: "none", label: `禁用${label}` }
        ]} onChange={(mode) => setChatParams({ ...draft.chatParams, [field]: mode })} />
      </div>)}
    </div>
  </section>;
}
