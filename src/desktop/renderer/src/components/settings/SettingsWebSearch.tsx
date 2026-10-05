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
      <SettingsSwitch checked={search.visibleBrowsing} label="可视化 Agent 浏览" detail="在侧栏显示搜索和网页访问；侧栏关闭时使用隐藏窗口。" onChange={(visibleBrowsing) => setWebSearch({ ...search, visibleBrowsing })} />
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
      <p>设置搜索语言、地区和安全搜索。</p>
      <button className="web-search-action" disabled={disabled} onClick={() => open("https://www.google.com/preferences", "google")} type="button">打开 Google 设置</button>
    </section>
    <section id="web-search-cookies" tabIndex={-1}>
      <h3>小红书设置</h3>
      <p>登录小红书以使用账户的搜索结果。</p>
      <button className="web-search-action" disabled={disabled} onClick={() => open("https://www.xiaohongshu.com/", "xiaohongshu")} type="button">打开小红书设置</button>
      <details className="settings-disclosure web-search-cookie-actions"><summary>Cookie 管理</summary>
        <p>通过剪贴板导入或导出 Cookie，共享登录状态。</p>
        <div className="settings-button-row">
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onExportCookies, "小红书 Cookie 已复制到剪贴板")} type="button"><Icon name="download" />导出</button>
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onImportCookies, "已从剪贴板导入小红书 Cookie")} type="button"><Icon name="arrow-up" />导入</button>
          <button className="web-search-action" disabled={disabled} onClick={() => void run(onClearCookies, "小红书 Cookie 操作已完成")} type="button"><Icon name="trash" />清除</button>
        </div>
      </details>
    </section>
    <section>
      <h3>网站登录</h3>
      <p>登录后，网页抓取可使用该网站的登录状态。</p>
      <form className="web-browser-url-row" onSubmit={(event) => { event.preventDefault(); open(browserUrl.trim()); }}>
        <input aria-label="网站地址" autoCapitalize="none" autoComplete="off" type="url" required value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} placeholder="https://" />
        <button className="web-search-action" disabled={disabled} type="submit">打开浏览器</button>
      </form>
    </section>
    {message ? <p role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    {sessionRunning ? <p role="status">当前任务运行中，登录和 Cookie 操作将在任务结束后可用。</p> : null}
  </div>;
}
