/**
 * 快速对话（QuickChat）设置页。
 *
 * 三个开关都是纯 UI 行为偏好，走 DesktopStateStore 的逐字段直达通道（setQuickChatSettings），
 * 即时生效，不进跨页设置草稿事务——所以这里不读 useSettingsDraft，而是挂载时拉一次
 * quickChatSettings()，勾选后直接把整份设置回写。前台应用上下文由 QuickChat 唤起时按需读取，
 * 与活动记录器完全分离。
 */
import { useEffect, useRef, useState } from "react";
import type { DesktopQuickChatSettings } from "../../../../protocol.js";
import { SettingsSwitch } from "./SettingsSwitch.js";

export function SettingsQuickChat(): React.JSX.Element {
  const [settings, setSettings] = useState<DesktopQuickChatSettings>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    setLoadError(undefined);
    void window.biny.quickChatSettings()
      .then((nextSettings) => {
        if (cancelled) return;
        setSettings(nextSettings);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [attempt]);

  const update = (patch: Partial<DesktopQuickChatSettings>): void => {
    if (!settings || saving) return;
    const next = { ...settings, ...patch };
    setSaving(true);
    setSaveError(undefined);
    setSettings(next);
    void window.biny.setQuickChatSettings(next).then((value) => { if (mounted.current) setSettings(value); }).catch((error: unknown) => {
      if (!mounted.current) return;
      setSaveError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (mounted.current) setSaving(false); });
  };

  if (loadError) {
    return <div className="settings-load-state"><div role="alert"><h3>无法加载快速对话设置</h3><p>{loadError}</p></div>
      <button aria-label="重新加载快速对话设置" className="settings-secondary-button" onClick={() => setAttempt((value) => value + 1)} type="button">重新加载</button></div>;
  }
  if (!settings) {
    return <div className="settings-sections"><section className="appearance-card"><p className="quickchat-hint">正在加载快速对话设置…</p></section></div>;
  }

  return (
    <div className="settings-preferences">
      <section className="settings-preference-section" id="quickchat-behavior" tabIndex={-1}>
        <h3>悬浮窗口</h3>
        <div className="settings-row-group" aria-busy={saving}>
          <SettingsSwitch
            disabled={saving}
            checked={settings.autoHideOnBlur}
            label="失焦时自动隐藏"
            onChange={(value) => update({ autoHideOnBlur: value })}
          />
          <SettingsSwitch
            disabled={saving}
            checked={settings.injectScreenContext}
            detail="发送时附带前台应用、窗口标题和浏览器地址。"
            label="注入前台应用上下文"
            onChange={(value) => update({ injectScreenContext: value })}
          />
          <SettingsSwitch
            disabled={saving}
            checked={settings.clickThrough}
            detail="悬浮显示但不响应鼠标，用快捷键唤起。"
            label="以环境（点击穿透）模式启动"
            onChange={(value) => update({ clickThrough: value })}
          />
        </div>
      </section>
      {saveError ? <div className="settings-inline-error">
        <p className="settings-save-error" role="alert">{saveError}。保存尚未确认，待保存的选择已保留。</p>
        <button aria-label="重试保存快速对话设置" className="settings-secondary-button" onClick={() => update({})} type="button">重试保存</button>
      </div> : null}
      {saving ? <p className="settings-inline-status" role="status">正在保存…</p> : null}
    </div>
  );
}
