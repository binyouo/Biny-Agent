/** Agent 权限策略设置：控制工具执行前的批准边界，不改变工具/Skill 的可见性选择。 */
import type { DesktopPermissionSettings } from "../../../../protocol.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

export function SettingsPermissions(): React.JSX.Element {
  const { draft, loadError, setPermission } = useSettingsDraft();
  if (!draft) return <div className="settings-sections"><section><p role={loadError ? "alert" : "status"}>{loadError ?? "打开项目后可管理 Agent 工具权限。"}</p></section></div>;

  const permission = draft.permission;
  const update = (patch: Partial<DesktopPermissionSettings>): void => setPermission({ ...permission, ...patch });

  return (
    <div className="settings-sections agent-permission-settings">
      <section id="agent-permission-mode" tabIndex={-1}>
        <div className="section-heading-row">
          <div><h3>权限请求</h3><p>控制工具操作是否需要手动确认。</p></div>
          <span className="settings-scope-badge">全局</span>
        </div>
        <SettingsSwitch
          checked={permission.mode === "full-access"}
          detail="开启后自动批准工具请求，无需逐次确认；项目明确拒绝的路径仍会拦截。"
          label="自动批准所有工具请求"
          onChange={(enabled) => update({ mode: enabled ? "full-access" : "ask" })}
        />
      </section>
    </div>
  );
}
