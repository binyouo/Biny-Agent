import { useRef, useState } from "react";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";

export function SettingsVisionModel(): React.JSX.Element | null {
  const { snapshot, saveModels, saveState } = useSettingsDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  if (!snapshot) return null;
  const models = snapshot.models.configured.filter(model => model.providerType !== "acp" && model.available !== false
    && model.capabilities?.vision === true && snapshot.models.connections.some(connection => connection.providerAlias === model.provider && connection.enabled !== false));
  const select = (alias: string | undefined): void => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true); setError(undefined);
    void saveModels({ upserts: [], removeAliases: [], visionModel: { alias } })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { pending.current = false; setSaving(false); });
  };
  return <section className="settings-preference-section" id="vision-model" tabIndex={-1}>
    <h3>视觉模型</h3>
    <div className="settings-form-group">
      <p>选定后由该模型识别图片，主模型接收文字描述。</p>
      <SettingsModelPicker ariaLabel="视觉模型" groups={modelPickerGroups(models, snapshot.models.connections)}
        inheritLabel="跟随主模型" placeholder={snapshot.models.visionModel ? "所选模型不可用" : "跟随主模型"}
        value={snapshot.models.visionModel} onChange={select}
        disabled={saving || ["saving", "rolling_back", "recovery_required"].includes(saveState)} />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
