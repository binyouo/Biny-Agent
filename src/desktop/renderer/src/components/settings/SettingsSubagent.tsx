import type { DesktopSubagentSettings } from "../../../../protocol.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { modelPickerGroups } from "./settingsModelPickerData.js";

export function SettingsSubagent({ onOpenModels, busy = false }: { onOpenModels(): void; busy?: boolean }): React.JSX.Element | null {
  const { draft, snapshot, setSubagent, saveState } = useSettingsDraft();
  if (!draft || !snapshot) return null;
  const settings = draft.subagent;
  const disabled = busy || snapshot.hasRunningTasks || ["saving", "rolling_back", "recovery_required"].includes(saveState);
  const automatic = settings.runtime === "auto";
  const cli = settings.runtime === "codex" || settings.runtime === "claude-code";
  const external = settings.runtime !== "builtin";
  const connections = snapshot.models.connections.filter((connection) => connection.providerType === "acp");
  const providerAlias = settings.providerAlias;
  const selectedConnection = connections.find((connection) => connection.providerAlias === providerAlias);
  const selection = settings.runtime === "acp" ? `acp:${providerAlias ?? ""}` : settings.runtime;
  const models = snapshot.models.configured.filter((model) => model.available !== false && model.supportsTools !== false
    && model.showInPicker !== false && (settings.runtime === "acp" ? model.providerType === "acp" && model.provider === providerAlias : model.providerType !== "acp")
    && snapshot.models.connections.some((connection) => connection.providerAlias === model.provider && connection.enabled !== false));
  const unavailable = !cli && settings.model && !models.some((model) => model.alias === settings.model);
  const update = (patch: Partial<DesktopSubagentSettings>): void => setSubagent({ ...settings, ...patch });
  const restrictions = external ? [
    ...(draft.permission.mode !== "full-access" ? ["外部子代理需要自动批准工具请求；可在「聊天」中调整。"] : []),
    ...(draft.permission.denyPaths.length ? ["当前有拒绝访问的路径，外部子代理无法执行此限制。请使用 Biny 内置，或手动调整权限配置。"] : []),
    ...snapshot.externalSubagentBlockers
  ] : [];
  return <section className="settings-preference-section" id="subagent" tabIndex={-1}>
    <h3>子代理</h3>
    <div className="settings-form-group">
      <SettingsSwitch label="启用子代理" checked={settings.enabled} disabled={disabled}
        onChange={(enabled) => update({ enabled })} />
      {settings.enabled ? <>
        <label className="subagent-setting-row">
          <span>默认子代理</span>
          <select aria-label="默认子代理" disabled={disabled} value={selection}
            onChange={(event) => {
              const value = event.target.value;
              update({ runtime: value.startsWith("acp:") ? "acp" : value as DesktopSubagentSettings["runtime"],
                providerAlias: value.startsWith("acp:") ? value.slice(4) : undefined, model: undefined });
            }}>
            <option value="auto">自动</option>
            <option value="builtin">Biny 内置</option><option value="codex">Codex CLI</option>
            <option value="claude-code">Claude Code CLI</option>
            {settings.runtime === "acp" && !selectedConnection ? <option value={selection} disabled>
              {providerAlias ? `${providerAlias}（连接不可用）` : "请选择外部 Agent"}
            </option> : null}
            {connections.map((connection) => {
              const label = connection.displayName ?? catalogForConnection({ provider: connection.providerAlias, providerType: "acp" })?.label ?? connection.providerAlias;
              return <option key={connection.providerAlias} value={`acp:${connection.providerAlias}`} disabled={connection.enabled === false}>
                {/[(（]ACP[)）]$/u.test(label) ? label : `${label}（ACP）`}{connection.enabled === false ? " · 已停用" : ""}
              </option>;
            })}
          </select>
        </label>
        {automatic ? <p>优先使用本机 Claude Code，未找到时使用 Biny 内置；已指定模型时使用内置。</p> : null}
        {!automatic || settings.model ? <div className="subagent-setting-row">
          <span>{cli ? "模型 ID" : "模型"}</span>
          {cli ? <input aria-label="子代理模型 ID" autoCapitalize="none" autoComplete="off" spellCheck={false}
            disabled={disabled} value={settings.model ?? ""} placeholder="输入 CLI 支持的模型 ID"
            onChange={(event) => update({ model: event.target.value.trim() || undefined })} />
            : <SettingsModelPicker ariaLabel="子代理模型" disabled={disabled}
              groups={modelPickerGroups(models, snapshot.models.connections)}
              inheritLabel={automatic ? "自动选择" : external ? undefined : "跟随主模型"}
              placeholder={unavailable ? `${settings.model}（不可用）` : external ? "选择模型" : "跟随主模型"}
              value={settings.model} onChange={(model) => update({ model })} />}
        </div> : null}
        {external && !automatic && !settings.model ? <p role="status">{cli ? "请输入模型 ID 后保存。" : selectedConnection ? models.length ? "请选择该 Agent 的模型后保存。" : "该 Agent 没有可用模型，请在模型供应商中配置。" : "请选择外部 Agent。"}</p> : null}
        {unavailable ? <p role="alert">当前模型不可用，请重新选择。</p> : null}
        {settings.runtime === "acp" && selectedConnection?.enabled === false ? <p role="alert">此 Agent 连接已停用，请重新选择或在模型供应商中启用。</p> : null}
        <button type="button" className="settings-action-btn" disabled={disabled} onClick={onOpenModels}>
          {connections.length ? "管理 Agent 连接" : "添加外部 Agent"}
        </button>
        {cli ? <p>使用本机已安装并登录的 CLI。</p> : null}
        {restrictions.length ? <p role="status">{automatic ? "自动选中 Claude Code 时：" : ""}{restrictions.join(" ")}</p> : null}
      </> : null}
    </div>
  </section>;
}
