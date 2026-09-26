/** 网络搜索设置：引擎和可视化偏好走设置草稿，登录与小红书 Cookie 操作即时执行。 */
import { useRef, useState } from "react";
import type { DesktopCookieJarStatus } from "../../../../protocol.js";
import { Icon } from "../Icon.js";
import { NativeSelect } from "../NativeSelect.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

export function SettingsWebSearch({ onOpenBrowser, onExportCookies, onImportCookies, onClearCookies, sessionRunning }: {
  onOpenBrowser(url?: string, purpose?: "google" | "xiaohongshu" | "webfetch"): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  sessionRunning: boolean;
}): React.JSX.Element {
  const { draft, setWebSearch } = useSettingsDraft();
  const [browserUrl, setBrowserUrl] = useState("https://");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const search = draft?.webSearch;
  if (!search) return <p role="status">正在加载设置…</p>;
  const run = async (operation: () => Promise<unknown>, success?: string): Promise<void> => {
    if (running.current || sessionRunning) return;
    running.current = true; setBusy(true); setMessage(undefined);
    try { await operation(); if (success) setMessage({ text: success, error: false }); }
    catch (error) { setMessage({ text: error instanceof Error ? error.message : String(error), error: true }); }
    finally { running.current = false; setBusy(false); }
  };
  const disabled = busy || sessionRunning;
  const open = (url: string, purpose: "google" | "xiaohongshu" | "webfetch" = "webfetch"): void => { void run(() => onOpenBrowser(url, purpose)); };
  return <div className="settings-sections web-search-settings">
    <section>
      <SettingsSwitch checked={search.visibleBrowsing} label="可视化 Agent 浏览" detail="开启后，网络搜索和网页抓取会在侧边栏浏览器中以可见标签页运行，你可以实时看到 Agent 正在访问哪些网站。侧边栏浏览器关闭时，会自动回退到隐藏窗口。" onChange={(visibleBrowsing) => setWebSearch({ ...search, visibleBrowsing })} />
    </section>
    <section id="web-search-provider" tabIndex={-1}>
      <h3>搜索引擎</h3>
      <label htmlFor="web-search-engine">选择搜索引擎</label>
      <NativeSelect id="web-search-engine" value={search.provider} onChange={(event) => setWebSearch({ ...search, provider: event.target.value as "google" | "xiaohongshu" })}>
        <option value="google">Google</option><option value="xiaohongshu">小红书</option>
      </NativeSelect>
      <p>选择用于网络搜索的搜索引擎。Google 适用于通用搜索，小红书适用于中文生活方式和购物内容。</p>
      <div className="web-search-options-grid">
        <div>
          <label htmlFor="web-search-timeout">搜索等待时间</label>
          <NativeSelect id="web-search-timeout" value={String(search.timeoutMs)} onChange={(event) => setWebSearch({ ...search, timeoutMs: Number(event.target.value) })}>
            {[1_000, 5_000, 10_000, 15_000, 30_000, 60_000].map((milliseconds) => <option key={milliseconds} value={milliseconds}>{milliseconds / 1_000} 秒</option>)}
            {[1_000, 5_000, 10_000, 15_000, 30_000, 60_000].includes(search.timeoutMs) ? null : <option value={search.timeoutMs}>{search.timeoutMs / 1_000} 秒（当前）</option>}
          </NativeSelect>
        </div>
        <div>
          <label htmlFor="web-search-max-results">最多返回结果</label>
          <NativeSelect id="web-search-max-results" value={String(search.maxResults)} onChange={(event) => setWebSearch({ ...search, maxResults: Number(event.target.value) })}>
            {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} 条</option>)}
          </NativeSelect>
        </div>
      </div>
    </section>
    <section>
      <h3>Google 搜索设置</h3>
      <p>打开浏览器窗口以配置 Google 搜索设置（语言、地区、安全搜索等）。这些设置将在网络搜索获取结果时使用。</p>
      <button className="web-search-action" disabled={disabled} onClick={() => open("https://www.google.com/preferences", "google")} type="button">打开 Google 设置</button>
    </section>
    <section id="web-search-cookies" tabIndex={-1}>
      <h3>小红书设置</h3>
      <p>打开浏览器窗口登录小红书并配置您的账户。登录后可以获得更好的搜索结果和个性化内容。</p>
      <button className="web-search-action" disabled={disabled} onClick={() => open("https://www.xiaohongshu.com/", "xiaohongshu")} type="button">打开小红书设置</button>
      <div className="web-search-cookie-actions">
        <h4>Cookie 管理</h4>
        <p>导入/导出 Cookie 以与浏览器扩展（如 Cookie-Editor）共享登录状态。这样您可以同时在 Biny 和浏览器中保持登录。</p>
        <div className="settings-button-row">
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onExportCookies, "小红书 Cookie 已复制到剪贴板")} type="button"><Icon name="download" />导出</button>
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onImportCookies, "已从剪贴板导入小红书 Cookie")} type="button"><Icon name="arrow-up" />导入</button>
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onClearCookies, "小红书 Cookie 操作已完成")} type="button"><Icon name="trash" />清除</button>
        </div>
      </div>
    </section>
    <section>
      <h3>WebFetch 浏览器</h3>
      <p>打开浏览器窗口登录网站。登录后，WebFetch 可以访问需要身份验证的内容。</p>
      <form className="web-browser-url-row" onSubmit={(event) => { event.preventDefault(); open(browserUrl.trim()); }}>
        <input aria-label="网站地址" autoCapitalize="none" autoComplete="off" type="url" required value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} placeholder="https://" />
        <button className="web-search-action" disabled={disabled} type="submit">打开浏览器</button>
      </form>
    </section>
    {message ? <p role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    {sessionRunning ? <p role="status">当前任务运行中，登录和 Cookie 操作将在任务结束后可用。</p> : null}
  </div>;
}
