/**
 * 快速对话（QuickChat）设置页。
 *
 * 三个开关都是纯 UI 行为偏好，走 DesktopStateStore 的逐字段直达通道（setQuickChatSettings），
 * 即时生效，不进跨页设置草稿事务。首帧复用启动偏好，挂载时通过 quickChatSettings()
 * 校验；用户编辑后的旧读取不再回填。前台应用上下文由 QuickChat 唤起时按需读取，
 * 与活动记录器完全分离。
 */
import { useEffect, useRef, useState } from "react";
import type { DesktopQuickChatSettings } from "../../../../protocol.js";
import { SettingsSwitch } from "./SettingsSwitch.js";

export function SettingsQuickChat({ initialSettings, onSettingsChanged }: {
  initialSettings?: DesktopQuickChatSettings;
  onSettingsChanged?(settings: DesktopQuickChatSettings): void;
}): React.JSX.Element {
  const [settings, setSettings] = useState<DesktopQuickChatSettings | undefined>(initialSettings);
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    const readRevision = revision.current;
    setLoadError(undefined);
    void window.biny.quickChatSettings()
      .then((nextSettings) => {
        if (cancelled || revision.current !== readRevision) return;
        setSettings(nextSettings);
        onSettingsChanged?.(nextSettings);
      })
      .catch((error: unknown) => {
        if (!cancelled && revision.current === readRevision) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [attempt, onSettingsChanged]);

  const update = (patch: Partial<DesktopQuickChatSettings>): void => {
    if (!settings || saving) return;
    revision.current += 1;
    const next = { ...settings, ...patch };
    setSaving(true);
    setSaveError(undefined);
    setSettings(next);
    void window.biny.setQuickChatSettings(next).then((value) => { if (mounted.current) { setSettings(value); onSettingsChanged?.(value); } }).catch((error: unknown) => {
      if (!mounted.current) return;
      setSaveError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (mounted.current) setSaving(false); });
  };

  return (
    <div className="settings-preferences">
      <section className="settings-preference-section" id="quickchat-behavior" tabIndex={-1}>
        <h3>悬浮窗口</h3>
        <div className="settings-row-group" aria-busy={saving || !settings}>
          <SettingsSwitch
            disabled={saving || !settings}
            checked={settings?.autoHideOnBlur ?? false}
            label="失焦时自动隐藏"
            onChange={(value) => update({ autoHideOnBlur: value })}
          />
          <SettingsSwitch
            disabled={saving || !settings}
            checked={settings?.injectScreenContext ?? false}
            detail="发送时附带前台应用、窗口标题和浏览器地址。"
            label="注入前台应用上下文"
            onChange={(value) => update({ injectScreenContext: value })}
          />
          <SettingsSwitch
            disabled={saving || !settings}
            checked={settings?.clickThrough ?? false}
            detail="悬浮显示但不响应鼠标，用快捷键唤起。"
            label="以环境（点击穿透）模式启动"
            onChange={(value) => update({ clickThrough: value })}
          />
        </div>
      </section>
      {loadError ? <div className="settings-inline-error"><p role="alert">{loadError}</p>
        <button aria-label="重新加载快速对话设置" className="settings-action settings-secondary-button" onClick={() => setAttempt((value) => value + 1)} type="button">重新加载</button></div> : null}
      {saveError ? <div className="settings-inline-error">
        <p className="settings-save-error" role="alert">{saveError}。保存尚未确认，待保存的选择已保留。</p>
        <button aria-label="重试保存快速对话设置" className="settings-action settings-secondary-button" onClick={() => update({})} type="button">重试保存</button>
      </div> : null}
      {saving ? <p className="settings-inline-status" role="status">正在保存…</p> : null}
    </div>
  );
}
