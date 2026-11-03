import { useEffect, useRef, useState } from "react";
import type { DesktopSettingsModelsInput } from "../../../../protocol.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";

export function SettingsVisionModel({ onNotify }: { onNotify(message: string): void }): React.JSX.Element | null {
  const { snapshot, saveModels, saveState, modelSelectionSaving } = useSettingsDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reportError = (message: string): void => {
    if (mounted.current) setError(message);
    else onNotify(message);
  };
  if (!snapshot) return null;
  const models = snapshot.models.configured.filter(model => model.providerType !== "acp" && model.available !== false
    && model.capabilities?.vision === true && snapshot.models.connections.some(connection => connection.providerAlias === model.provider && connection.enabled !== false));
  const enabled = snapshot.models.visionModelEnabled ?? Boolean(snapshot.models.visionModel);
  const disabled = saving || (saveState === "saving" && !modelSelectionSaving) || saveState === "rolling_back" || saveState === "recovery_required";
  const save = (update: Pick<DesktopSettingsModelsInput, "visionModel" | "visionModelEnabled">): void => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true); setError(undefined);
    void saveModels({ upserts: [], removeAliases: [], ...update })
      .then(result => { if (result && result.status !== "committed" && (mounted.current || result.status !== "recovery_required")) reportError(result.message ?? "视觉模型保存失败，请重试。"); })
      .catch(reason => reportError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { pending.current = false; setSaving(false); });
  };
  return <section className="settings-preference-section" id="vision-model" tabIndex={-1}>
    <div className="settings-preference-heading">
      <h3>视觉模型</h3>
      <input aria-label="启用视觉模型" aria-describedby="vision-model-description" aria-checked={enabled}
        checked={enabled} className="settings-switch" disabled={disabled}
        onChange={event => save({ visionModelEnabled: event.currentTarget.checked })} role="switch" type="checkbox" />
    </div>
    <div className="settings-form-group">
      <p id="vision-model-description">开启后，主模型不支持图片输入时，由视觉模型识别图片并转成文字。主模型支持图片时直接处理。</p>
      {enabled ? <SettingsModelPicker ariaLabel="视觉模型" groups={modelPickerGroups(models, snapshot.models.connections)}
        placeholder={snapshot.models.visionModel ? "所选模型不可用" : "选择模型…"}
        value={snapshot.models.visionModel} onChange={alias => save({ visionModel: { alias } })}
        disabled={disabled} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
