import { useEffect, useRef, useState } from "react";
import type { AppshotsApi, AppshotsState } from "../../../../../computer/appshotsProtocol.js";
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

/**
 * 参照实现的取值。三个修饰键双击是同一族（说明文字按当前选中项换），
 * 顺手保留了旧配置里出现过的组合键，避免升级后选择被清成空白。
 */
const SHORTCUTS = [
  { value: "double-cmd", label: "⌘ + ⌘", hint: "同时按下左右两个 ⌘，或快速连按两次 ⌘" },
  { value: "double-option", label: "⌥ + ⌥", hint: "同时按下左右两个 ⌥，或快速连按两次 ⌥" },
  { value: "double-shift", label: "⇧ + ⇧", hint: "同时按下左右两个 ⇧，或快速连按两次 ⇧" },
  { value: "DoubleCommand", label: "⌘ + ⌘", hint: "同时按下左右两个 ⌘，或快速连按两次 ⌘" },
  { value: "DoubleOption", label: "⌥ + ⌥", hint: "同时按下左右两个 ⌥，或快速连按两次 ⌥" },
  { value: "DoubleShift", label: "⇧ + ⇧", hint: "同时按下左右两个 ⇧，或快速连按两次 ⇧" },
  { value: "Control+Alt+C", label: "⌃ + ⌥ + C", hint: "" }
] as const;

export function SettingsAppshots(): React.JSX.Element {
  const [state, setState] = useState<AppshotsState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const [warming, setWarming] = useState(false);
  const alive = useRef(false);
  const busy = useRef(false);
  const warmed = useRef(false);
  const api = window.binyAppshots;

  useEffect(() => {
    alive.current = true;
    if (!api) { setError("请重新启动 Biny 以加载 Appshot 服务。"); return () => { alive.current = false; }; }
    void api.state().then(value => { if (alive.current) setState(value); }).catch(reason => { if (alive.current) setError(String(reason)); });
    // 预热只做一次：它要拉起桌面控制组件，每次进设置页都做一遍是白等。
    if (!warmed.current && typeof api.prewarm === "function") {
      warmed.current = true; setWarming(true);
      void api.prewarm().then(value => { if (alive.current) setState(value); })
        .catch(reason => { if (alive.current) setError(String(reason)); })
        .finally(() => { if (alive.current) setWarming(false); });
    }
    return () => { alive.current = false; };
  }, [api]);

  const perform = async (key: string, action: () => Promise<AppshotsState>): Promise<void> => {
    if (busy.current || !api) return;
    busy.current = true; setPending(key); setError("");
    try { const next = await action(); if (alive.current) setState(next); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busy.current = false; if (alive.current) setPending(undefined); }
  };

  const settings = state?.settings;
  const hotkey = settings?.hotkey ?? "";
  const armed = state?.active === true;
  // 已配置但没能武装：热键按下去不会有反应，这和「关闭」是两种状态，不能都说成"未开启"。
  const stale = !armed && hotkey !== "";
  const supported = Boolean(api) && !stale;
  const hint = SHORTCUTS.find(entry => entry.value === hotkey)?.hint ?? "";
  const known = SHORTCUTS.some(entry => entry.value === hotkey);
  const spinner = warming || pending !== undefined;
  const current = error || state?.error;

  return <div className="settings-sections appshot-settings">
    <section className="cu-card appshot-hero">
      <span aria-hidden="true" className="appshot-hero-badge"><Icon name="camera" size={24} /></span>
      <div className="appshot-hero-copy">
        <h3>用 Appshot 把当前窗口给 Biny 看</h3>
        <p className="cu-description">
          Appshot 会截取你的前台窗口——既有看得见的画面，也有无障碍文本轮廓——并把它放进聊天输入框。
          在任何应用里<strong>同时按下两个 ⌘ 键</strong>，或快速连按两次修饰键即可；Biny 会带着这张截图回到前台，
          文本轮廓随消息隐形同乘，模型因此看到完整窗口上下文。
        </p>
      </div>
    </section>

    {stale ? <section className="appshot-notice">
      <Icon name="warning" size={18} />
      <p>热键已保存，但当前没有生效——通常是因为截图所需的系统权限还没给到。到
        Computer Use 页授权辅助功能与屏幕录制，再回到这里重新预热。</p>
    </section> : null}

    <section className="cu-card appshot-rows">
      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong>截图快捷键</strong>
          {hint ? <p>{hint}</p> : <p>未设置快捷键——Appshot 处于关闭状态。</p>}
          {warming ? <p>正在启动桌面控制组件…</p> : null}
          {current ? <p className="appshot-error" role="alert">
            {appshotError(current)}
            {/accessibility|ax_not_granted|appshot_tap_unavailable/.test(current) ? <button
              className="appshot-link" type="button" disabled={!api || pending !== undefined}
              onClick={() => void perform("accessibility", async () => { await window.binyComputer.requestAccessibility(); return await api.prewarm(); })}
            >打开辅助功能设置</button> : null}
          </p> : null}
        </div>
        <label className="appshot-field">
          <span className="cu-sr-only">截图快捷键</span>
          <span className="appshot-select">
            {spinner ? <Icon className="appshot-spin" name="loader" size={12} /> : null}
            <select
              aria-label="截图快捷键" disabled={!api || pending !== undefined}
              value={hotkey}
              onChange={event => void perform("hotkey", () => api.settings({ ...settings!, hotkey: event.target.value }))}
            >
              {hotkey && !known ? <option value={hotkey}>{hotkey}</option> : null}
              {SHORTCUTS.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              <option value="">关闭</option>
            </select>
          </span>
        </label>
      </div>

      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong>截图放到哪里</strong>
          <p><strong>当前聊天</strong>（默认）把截图放进已经打开的那个对话，方便接着聊你正在看的窗口；<strong>新聊天</strong>每次为截图开一段全新对话。</p>
        </div>
        <SettingsSegmentedControl
          label="截图目标"
          value={settings?.target ?? "current"}
          disabled={!api || pending !== undefined}
          options={[{ value: "current", label: "当前聊天" }, { value: "new", label: "新聊天" }]}
          onChange={target => void perform("target", () => api.settings({ ...settings!, target }))}
        />
      </div>

      <div className="appshot-row">
        <div className="appshot-row-copy">
          <strong>试一次</strong>
          <p>忽略快捷键，直接对 Biny 认为的前台窗口触发一次截图——用来确认权限和捕获链路是否正常。</p>
        </div>
        <button
          type="button" className="settings-secondary-button" disabled={!api || pending !== undefined || !supported}
          onClick={() => void perform("capture", () => api.capture())}
        >{pending === "capture" ? "正在截图…" : "立即截图"}</button>
      </div>
    </section>

    <section className="cu-card appshot-foot">
      <p className="cu-description">
        截图不依赖 Computer History 记录；敏感应用排除名单仍然生效，被排除的应用既不会被截取，也不会带上窗口上下文。
        快捷键监控由桌面控制组件分发，因此本页与 Computer Use 共用同一套权限。
      </p>
      <div className="cu-button-row">
        <button
          type="button" className="settings-secondary-button" disabled={!api || pending !== undefined}
          onClick={() => void perform("prewarm", () => api.prewarm())}
        >{pending === "prewarm" ? "正在预处理…" : "预热与重试"}</button>
        <button
          type="button" className="settings-secondary-button"
          onClick={() => void window.biny.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")}
        >辅助功能设置</button>
        <button
          type="button" className="settings-secondary-button"
          onClick={() => void window.biny.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")}
        >屏幕录制设置</button>
      </div>
    </section>
  </div>;
}
