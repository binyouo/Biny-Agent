import { useEffect, useRef, useState } from "react";
import type { AppshotsApi, AppshotsState } from "../../../../../computer/appshotsProtocol.js";
import { NativeSelect } from "../NativeSelect.js";
import { Icon } from "../Icon.js";
import { SettingsSegmentedControl } from "./SettingsSegmentedControl.js";

declare global { interface Window { binyAppshots: AppshotsApi } }

/**
 * Appshot 的错误来自四个不同的地方（tap 建不起来 / 屏幕录制 / 排除名单 / 前台漂移），
 * 下一步动作也各不相同。合并成一句"截图失败"会让用户去改与病因无关的那个设置，
 * 所以这里逐类给出「做什么」。
 */
function appshotError(error: string): string {
  if (/appshot_tap_unavailable|accessibility_not_granted|ax_not_granted/.test(error)) return "辅助功能权限尚未就绪——双击修饰键由系统的全局事件监听分发，没有这项权限热键不会被触发。请点「授权辅助功能」后重试。";
  if (/screen_recording|sc_not_granted/.test(error)) return "屏幕录制尚未授权——没有它拿不到窗口画面。请在系统设置里允许 Biny 录制屏幕，然后回到这里重试。";
  if (/excluded|application_excluded/.test(error)) return "当前应用在排除名单里（截图与窗口上下文都不会被采集）。请切到别的应用后重试。";
  if (/frontmost_changed/.test(error)) return "截图期间目标应用发生了变化——请先切到你要截的窗口，再触发一次。";
  if (/frontmost_unavailable|no_window/.test(error)) return "当前没有可捕获的应用窗口。请先切到目标应用。";
  if (/capture_busy/.test(error)) return "上一次截图还没结束，请稍候片刻再试。";
  if (/capture_expired/.test(error)) return "这一张截图已过期（保留 5 分钟），请重新触发。";
  if (/budget_exceeded/.test(error)) return "窗口内容超过 4 MB 上限，无法作为附件。请截一个内容更少的窗口。";
  if (/disconnected/.test(error)) return "与桌面控制组件的连接已断开——请点「预热与重试」重新建立。";
  return error;
}

// 旧配置里的组合键仍可选择；别名在展示时合并为同一项。
const SHORTCUTS = [
  { value: "double-cmd", label: "⌘ + ⌘", hint: "同时按下左右两个 ⌘，或快速连按两次 ⌘" },
  { value: "double-option", label: "⌥ + ⌥", hint: "同时按下左右两个 ⌥，或快速连按两次 ⌥" },
  { value: "double-shift", label: "⇧ + ⇧", hint: "同时按下左右两个 ⇧，或快速连按两次 ⇧" },
  { value: "Control+Alt+C", label: "⌃ + ⌥ + C", hint: "" }
] as const;
const SHORTCUT_ALIASES = new Map([["DoubleCommand", "double-cmd"], ["DoubleOption", "double-option"], ["DoubleShift", "double-shift"]]);

export function SettingsAppshots(): React.JSX.Element {
  const [state, setState] = useState<AppshotsState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const [warming, setWarming] = useState(false);
  const alive = useRef(false);
  const busy = useRef(false);
  const revision = useRef(0);
  const api = window.binyAppshots;

  useEffect(() => {
    alive.current = true;
    const request = ++revision.current;
    let cancelled = false, prewarmApplied = false;
    const current = () => !cancelled && request === revision.current;
    if (!api) { setError("请重新启动 Biny 以加载 Appshot 服务。"); return () => { alive.current = false; }; }
    void api.state().then(value => { if (current() && !prewarmApplied) setState(value); })
      .catch(reason => { if (current() && !prewarmApplied) setError(String(reason)); });
    if (typeof api.prewarm === "function") {
      setWarming(true);
      void api.prewarm().then(value => { if (current()) { prewarmApplied = true; setState(value); setError(""); } })
        .catch(reason => { if (current()) setError(String(reason)); })
        .finally(() => { if (!cancelled) setWarming(false); });
    }
    return () => { cancelled = true; alive.current = false; revision.current++; };
  }, [api]);

  const perform = async (key: string, action: () => Promise<AppshotsState>): Promise<void> => {
    if (busy.current || !api) return;
    const request = ++revision.current;
    busy.current = true; setPending(key); setError("");
    try { const next = await action(); if (alive.current && request === revision.current) setState(next); }
    catch (failure) { if (alive.current && request === revision.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busy.current = false; if (alive.current) setPending(undefined); }
  };

  const settings = state?.settings;
  const hotkey = settings?.hotkey ?? "";
  const selectedHotkey = SHORTCUT_ALIASES.get(hotkey) ?? hotkey;
  const armed = state?.active === true;
  // 已配置但没能武装：热键按下去不会有反应，这和「关闭」是两种状态，不能都说成"未开启"。
  const stale = !armed && hotkey !== "";
  const hint = SHORTCUTS.find(entry => entry.value === selectedHotkey)?.hint ?? "";
  const known = SHORTCUTS.some(entry => entry.value === selectedHotkey);
  const spinner = warming || pending !== undefined;
  const current = error || state?.error;

  return <div className="settings-sections appshot-settings">
    <section className="cu-card appshot-hero">
      <div className="appshot-hero-copy">
        <h3>窗口截图</h3>
        <p className="cu-description">截取前台窗口及无障碍文本，放入聊天草稿；发送后才交给模型。</p>
      </div>
    </section>

    {stale ? <section className="appshot-notice">
      <Icon name="warning" size={18} />
      <p>热键已保存，但监听尚未生效。可检查辅助功能权限后重试预热，也可直接测试截图。</p>
    </section> : null}

    <section className="cu-card appshot-rows">
      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong id="appshot-hotkey-label">截图快捷键</strong>
          {hint ? <p>{hint}</p> : hotkey ? <p>使用已保存的快捷键。</p> : armed
            ? <p>快捷键已清空，但监听可能仍在运行。请重试停止。</p>
            : <p>未设置快捷键——Appshot 处于关闭状态。</p>}
          {warming ? <p>正在启动桌面控制组件…</p> : null}
          {current ? <p className="appshot-error" role="alert">
            {appshotError(current)}
            {/accessibility|ax_not_granted|appshot_tap_unavailable/.test(current) ? <button
              className="settings-action settings-text-action appshot-link" type="button" disabled={!api || pending !== undefined}
              onClick={() => void perform("accessibility", async () => { await window.binyComputer.requestAccessibility(); return await api.prewarm(); })}
            >打开辅助功能设置</button> : null}
          </p> : null}
        </div>
        <div className="appshot-field">
          <span className="appshot-select">
            {spinner ? <Icon className="appshot-spin" name="loader" size={12} /> : null}
            <NativeSelect className="settings-field"
              aria-labelledby="appshot-hotkey-label" disabled={!api || !settings || pending !== undefined}
              value={selectedHotkey}
              onChange={event => void perform("hotkey", () => api.settings({ ...settings!, hotkey: event.target.value }))}
            >
              {hotkey && !known ? <option value={hotkey}>{hotkey}</option> : null}
              {SHORTCUTS.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              <option value="">关闭</option>
            </NativeSelect>
          </span>
        </div>
      </div>

      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong id="appshot-target-label">截图目标</strong>
        </div>
        <SettingsSegmentedControl
          label="截图目标"
          labelledBy="appshot-target-label"
          value={settings?.target ?? "current"}
          disabled={!api || !settings || pending !== undefined}
          options={[{ value: "current", label: "当前聊天" }, { value: "new", label: "新聊天" }]}
          onChange={target => void perform("target", () => api.settings({ ...settings!, target }))}
        />
      </div>

      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong>测试截图</strong>
          <p>截取前台窗口，检查权限是否可用。</p>
        </div>
        <button
          type="button" className="settings-action settings-secondary-button" disabled={!api || pending !== undefined}
          onClick={() => void perform("capture", () => api.capture())}
        >{pending === "capture" ? "正在截图…" : "立即截图"}</button>
      </div>
    </section>

    <section className="cu-card appshot-foot">
      <p className="cu-description">
        无需开启 Computer History。排除的应用不会被截图或读取窗口文本。
        需要辅助功能与屏幕录制权限。
      </p>
      <div className="cu-button-row">
        <button
          type="button" className="settings-action settings-secondary-button" disabled={!api || pending !== undefined}
          onClick={() => void perform("prewarm", () => api.prewarm())}
        >{pending === "prewarm" ? "正在预处理…" : "预热与重试"}</button>
        <button
          type="button" className="settings-action settings-secondary-button"
          onClick={() => void window.biny.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")}
        >辅助功能设置</button>
        <button
          type="button" className="settings-action settings-secondary-button"
          onClick={() => void window.biny.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")}
        >屏幕录制设置</button>
      </div>
    </section>
  </div>;
}
