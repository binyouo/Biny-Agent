import type { DesktopSubagentSettings } from "../../../../protocol.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

const defaultChoices: Array<{ value: string; label: string; settings: DesktopSubagentSettings }> = [
  { value: "auto", label: "自动", settings: { enabled: true, runtime: "auto" } },
  { value: "claude-code", label: "Claude Code", settings: { enabled: true, runtime: "claude-code" } },
  { value: "builtin", label: "内置 Agent", settings: { enabled: true, runtime: "builtin" } }
];

export function SettingsSubagent({ onOpenProviders, busy = false }: { onOpenProviders(): void; busy?: boolean }): React.JSX.Element | null {
  const { draft, snapshot, setSubagent, saveState } = useSettingsDraft();
  if (!draft || !snapshot) return null;
  const settings = draft.subagent;
  const disabled = busy || snapshot.hasRunningTasks || ["saving", "rolling_back", "recovery_required"].includes(saveState);
  const connections = snapshot.models.connections.filter(connection => connection.providerType === "acp");
  const choices = new Map(defaultChoices.map(choice => [choice.value, choice.settings]));
  const selectedProviderAlias = settings.providerAlias
    ?? (settings.model ? snapshot.models.configured.find(model => model.alias === settings.model)?.provider : undefined);
  const options = connections.map(connection => {
    const value = `acp:${connection.providerAlias}`;
    const label = connection.displayName ?? catalogForConnection({ provider: connection.providerAlias, providerType: connection.providerType })?.label ?? connection.providerAlias;
    choices.set(value, { enabled: true, runtime: "acp", providerAlias: connection.providerAlias });
    return { value, label, disabled: connection.enabled === false };
  });
  const availableValues = new Set([...choices.keys()]);
  const selected = settings.runtime === "acp" && selectedProviderAlias && availableValues.has(`acp:${selectedProviderAlias}`)
    ? `acp:${selectedProviderAlias}`
    : settings.runtime === "auto" || settings.runtime === "claude-code" || settings.runtime === "builtin" ? settings.runtime : "auto";
  const external = settings.enabled && settings.runtime !== "builtin";
  const restrictions = external ? [
    ...(draft.permission.mode !== "full-access" ? ["外部子代理需要自动批准工具请求。"] : []),
    ...(draft.permission.denyPaths.length ? ["外部子代理无法执行拒绝路径限制。"] : []),
    ...snapshot.externalSubagentBlockers
  ] : [];
  return <section className="settings-preference-section" id="subagent" tabIndex={-1}>
    <h3>Coding Agent</h3>
    <div className="settings-form-group">
      <p className="settings-subagent-description">选择 `coder` 类型 subagent 执行代码任务时使用的后端。</p>
      <div className="settings-subagent-select-field">
        <label htmlFor="settings-subagent-default">默认 Coding Agent</label>
        <select id="settings-subagent-default" aria-label="默认 Coding Agent" className="settings-subagent-select" disabled={disabled} value={selected}
          onChange={event => {
            const next = choices.get(event.currentTarget.value);
            if (!disabled && next) setSubagent(next);
          }}>
          {defaultChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          {options.map(option => <option key={option.value} disabled={option.disabled} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="settings-subagent-help">
        <p>优先使用 Claude Code，不可用时回退到内置 agent。</p>
        <p>直接使用本地安装的 Claude Code CLI。</p>
        <p>使用 Biny 内置子代理，并沿用当前聊天模型。</p>
        <p>使用已配置的 ACP provider，例如 Codex CLI 或 Gemini CLI。</p>
      </div>
      <div className="settings-subagent-providers">
        <p>{connections.length ? `ACP Providers: ${connections.length}` : "还没有配置 ACP provider。"}</p>
        <button className="settings-secondary-button settings-subagent-manage" onClick={onOpenProviders} type="button">管理 Providers</button>
      </div>
      {restrictions.length ? <p role="status">{restrictions.join(" ")}</p> : null}
    </div>
  </section>;
}
