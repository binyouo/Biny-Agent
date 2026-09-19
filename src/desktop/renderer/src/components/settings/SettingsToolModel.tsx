/**
 * 后台文本任务的统一模型入口，复用模型设置事务与已有模型选择器。
 *
 * 布局沿用成熟的模型设置模式：标题与说明在上，选择器与测试按钮同行，
 * 测试结果以状态卡片展示；避免把动态状态混进说明文案后居中悬空。
 */
import { useState } from "react";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";
import { ModelTestButton, ModelTestResult } from "./ModelTestButton.js";
import type { DesktopModelConfigurationInput, DesktopModelConnectionTestResult } from "../../../../protocol.js";

export function SettingsToolModel({ onTest }: { onTest(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult> }): React.JSX.Element | null {
  const { draft, snapshot, saveModels, saveState } = useSettingsDraft();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DesktopModelConnectionTestResult>();
  if (!draft || !snapshot) return null;
  const active = snapshot.models.configured.find((model) => model.alias === snapshot.models.resolvedToolModel);
  const selectModel = (alias: string | undefined): void => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    setTestResult(undefined);
    void saveModels({ ...draft.models, toolModel: { alias } }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "工具模型保存失败，请重试。");
    }).finally(() => setSaving(false));
  };
  const runTest = (): void => {
    if (!active || testing) return;
    setTesting(true);
    setTestResult(undefined);
    void onTest({ alias: active.alias, displayName: active.displayName, providerAlias: active.provider,
      providerType: active.providerType as DesktopModelConfigurationInput["providerType"], model: active.model,
      baseUrl: active.baseUrl, supportsTools: active.supportsTools === true, supportsThinking: active.efforts.length > 0
    }).then(setTestResult).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "测试失败"))
      .finally(() => setTesting(false));
  };
  return (
    <div className="settings-sections">
      <section id="tool-model" tabIndex={-1}>
        <h3>工具模型</h3>
        <p>在保证生成质量的前提下尽可能快的模型，用于工具与技能筛选、会话标题、记忆、结晶和活动分析等辅助任务。</p>
        <div className="tool-model-row">
          <SettingsModelPicker
            ariaLabel="工具模型"
            disabled={saving || testing || snapshot.hasRunningTasks || saveState === "saving"}
            groups={modelPickerGroups(snapshot.models.configured)}
            inheritLabel="自动选择"
            onChange={selectModel}
            placeholder="自动选择"
            value={snapshot.models.toolModel}
          />
          <ModelTestButton disabled={!active || saving} label="测试模型" testing={testing} onClick={runTest} />
        </div>
        <p className="tool-model-status">{active
          ? snapshot.models.toolModel
            ? `当前使用：${active.displayName}。`
            : `当前使用：${active.displayName}（自动模式，按供应商与辅助型号优先级选择已配置模型）。`
          : "暂无可用工具模型，请先在「模型供应商」中配置。"}</p>
        <ModelTestResult result={testResult} />
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
