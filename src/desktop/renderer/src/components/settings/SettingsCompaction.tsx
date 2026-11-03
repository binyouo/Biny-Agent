/** 自动压缩设置分页：触发阈值、保留策略与摘要模型，统一走设置草稿，保存时进入主进程事务。 */
import { useEffect, useState } from "react";
import type { DesktopCompactionSettings } from "../../../../protocol.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";

/** 可留空的数字输入：空文本提交为 undefined（交给后端自动推导），越界值夹取到 [min, max]。行内布局：标签在左、输入在右。 */
export function OptionalNumberField({
  hint,
  id,
  label,
  max,
  min,
  onCommit,
  unit,
  value
}: {
  hint?: string;
  id: string;
  label: string;
  max: number;
  min: number;
  onCommit(value: number | undefined): void;
  unit?: string;
  value: number | undefined;
}): React.JSX.Element {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = (): void => {
    if (text.trim() === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(value === undefined ? "" : String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.trunc(parsed)));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label className="setting-row" htmlFor={id}>
      <span><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>
      <div className="activity-number-input"><input className="settings-field" id={id} inputMode="numeric" max={max} min={min} onBlur={commit} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} placeholder="自动" type="number" value={text} />{unit ? <em>{unit}</em> : null}</div>
    </label>
  );
}

export function SettingsCompaction(): React.JSX.Element {
  const { draft, setCompaction, snapshot } = useSettingsDraft();
  if (!draft || !snapshot) return <div className="settings-sections"><section><p>正在加载压缩设置…</p></section></div>;
  const compaction = draft.compaction;
  const update = (patch: Partial<DesktopCompactionSettings>): void => setCompaction({ ...compaction, ...patch });

  // 阈值滑块以百分比交互，存储为 0.5–0.95 的小数；未配置时按 80% 展示（后端缺省自动推导）。
  const percent = Math.round((compaction.triggerPercent ?? 0.8) * 100);
  const modelChoices = snapshot.models.configured;
  const thresholdProgress = `${((percent - 50) / 45) * 100}%`;

  return (
    <div className="settings-sections compaction-settings">
      <section className="settings-preference-section" id="compaction-enable" tabIndex={-1}>
        <h3>自动压缩</h3>
        <div className="settings-form-group">
          <SettingsSwitch checked={compaction.enabled} detail="关闭后需手动压缩。" label="启用自动压缩" onChange={(enabled) => update({ enabled })} />
          <label className="compaction-threshold-field">
            <span><strong>触发阈值</strong><em>{percent}%</em></span>
            <input className="settings-range" aria-label="压缩阈值" disabled={!compaction.enabled} max={95} min={50} onChange={(event) => update({ triggerPercent: Number(event.target.value) / 100 })} style={{ "--range-progress": thresholdProgress } as React.CSSProperties} type="range" value={percent} />
          </label>
          <OptionalNumberField id="compaction-keep-messages" label="保留最近消息数" max={500} min={1} onCommit={(keepRecentMessages) => update({ keepRecentMessages })} unit="条" value={compaction.keepRecentMessages} />
          <div className="setting-row">
            <span><strong>摘要模型</strong></span>
            <SettingsModelPicker
              ariaLabel="压缩模型"
              disabled={!compaction.enabled}
              groups={modelPickerGroups(modelChoices, snapshot.models.connections)}
              inheritLabel="跟随当前模型"
              onChange={(summaryModel) => update({ summaryModel })}
              placeholder="跟随当前模型"
              value={compaction.summaryModel}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
