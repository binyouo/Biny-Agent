import { useEffect, useRef, useState } from "react";
import { acpConfigSchema } from "../../../../../acp/config.js";
import type { DesktopModelConfigurationInput, DesktopModelConnection, DesktopModelConnectionTestResult } from "../../../../protocol.js";
import type { ProviderCatalogItem } from "../../providerCatalog.js";
import { modelAliasFor } from "../../providerCatalog.js";
import { copyToClipboard } from "../../copyToClipboard.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { NativeSelect } from "../NativeSelect.js";

export function AcpProviderPanel({ catalog, connection, currentModel, onSave, onTest, onDelete }: {
  catalog: ProviderCatalogItem;
  connection?: DesktopModelConnection;
  currentModel?: string;
  onSave(input: DesktopModelConfigurationInput): Promise<boolean>;
  onTest(input: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onDelete?: () => void;
}): React.JSX.Element {
  const [alias, setAlias] = useState(connection?.providerAlias ?? catalog.id);
  const [command, setCommand] = useState(connection?.acp?.command ?? catalog.acpCommand ?? "");
  const [args, setArgs] = useState(JSON.stringify(connection?.acp?.args ?? []));
  const [env, setEnv] = useState(JSON.stringify(connection?.acp?.env ?? {}));
  const [mcp, setMcp] = useState(connection?.acp?.mcpServers.join("\n") ?? "");
  const [allowMemory, setAllowMemory] = useState(connection?.acp?.allowMemory ?? false);
  const [auth, setAuth] = useState(connection?.acp?.authMethodId ?? "");
  const [mode, setMode] = useState(connection?.acp?.modeId ?? "");
  const [model, setModel] = useState(currentModel ?? "default");
  const [result, setResult] = useState<DesktopModelConnectionTestResult>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setResult(undefined); }, [command, args, env, mcp, auth]);
  useEffect(() => { setMessage(""); setFailed(false); }, [alias, command, args, env, mcp, auth, model, mode, allowMemory]);
  // 修改过的命令不能套用内置程序的安装和登录指引。
  const setup = command === catalog.acpCommand && args === "[]" && env === "{}" ? catalog.acpSetup : undefined;
  const copy = async (text: string): Promise<void> => {
    const copied = await copyToClipboard(text);
    if (!active.current) return;
    setFailed(!copied);
    setMessage(copied ? "已复制，请在终端粘贴并执行。" : "复制失败，请手动选择命令复制。");
  };
  const input = (): DesktopModelConfigurationInput => {
    let parsedArgs: unknown;
    let parsedEnv: unknown;
    try { parsedArgs = JSON.parse(args); } catch { throw new Error('启动参数格式有误，请填写 JSON 数组，例如 ["--stdio"]。'); }
    try { parsedEnv = JSON.parse(env); } catch { throw new Error('环境变量格式有误，请填写 JSON 对象，例如 {"API_KEY":"MY_AGENT_KEY"}。'); }
    return {
      alias: modelAliasFor(alias.trim(), model), displayName: model === "default" ? `${catalog.label} · 默认` : model,
      providerAlias: alias.trim(), providerType: "acp", model, requiresApiKey: false, supportsTools: true,
      acp: acpConfigSchema.parse({ command, args: parsedArgs, env: parsedEnv, mcpServers: mcp.split("\n").map((name) => name.trim()).filter(Boolean),
        allowMemory, promptTimeoutMs: connection?.acp?.promptTimeoutMs, maxOutputBytes: connection?.acp?.maxOutputBytes,
        authMethodId: auth.trim() || undefined, modeId: mode || undefined })
    };
  };
  const execute = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setMessage("正在连接…"); setFailed(false);
    try {
      const configuration = input();
      if (!configuration.providerAlias) throw new Error("请在高级设置中填写连接名称。");
      const response = await onTest(configuration);
      if (!active.current) return;
      setResult(response);
      if (!response.ok) { setMessage(response.message); setFailed(true); return; }
      setMessage("正在保存…");
      const saved = await onSave(configuration);
      if (!active.current) return;
      setMessage(saved ? "已连接并保存" : "连接成功，但保存失败，请重试。");
      setFailed(!saved);
    } catch (error) {
      if (active.current) { setMessage(error instanceof Error ? error.message : String(error)); setFailed(true); }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  return <div className="provider-panel">
    <h3>{catalog.label}</h3>
    <fieldset disabled={busy} className="acp-provider-fields">
      {setup ? <>
        <p>已在本机登录？直接连接，无需填写 API Key。</p>
        <details className="provider-endpoint-details acp-setup" open={!connection}>
          <summary><span>首次使用：安装与登录</span></summary>
          <div className="provider-connection-fields">
            <p>在终端依次执行，登录完成后回到这里连接。安装需要 Node.js 和 npm。</p>
            {[
              { action: "复制安装命令", command: setup.installCommand },
              { action: "复制登录命令", command: setup.loginCommand }
            ].map((step) => <div className="acp-setup-step" key={step.action}>
              <code>{step.command}</code>
              <button type="button" className="settings-secondary-button" onClick={() => void copy(step.command)}>{step.action}</button>
            </div>)}
            <button type="button" className="settings-secondary-button" onClick={() => void window.biny.openExternal(setup.docsUrl).catch(() => { setMessage("无法打开安装说明，请检查系统浏览器。"); setFailed(true); })}>安装说明</button>
          </div>
        </details>
      </> : null}
      <details className="provider-endpoint-details acp-advanced" open={!catalog.acpSetup}>
        <summary><span>{catalog.acpSetup ? "高级设置" : "启动配置"}</span></summary>
        <div className="provider-connection-fields">
          <label>连接名称<input value={alias} disabled={Boolean(connection)} onChange={(event) => setAlias(event.target.value)} /></label>
          <label>启动命令<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="可执行文件或绝对路径" spellCheck={false} /></label>
          <label>参数（JSON 数组）<input value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false} /></label>
          <label>环境变量引用（变量名 → 本机变量名）<input value={env} onChange={(event) => setEnv(event.target.value)} placeholder={'{"API_KEY":"MY_AGENT_KEY"}'} spellCheck={false} /></label>
          <label>认证方式 ID（可选）<input value={auth} onChange={(event) => setAuth(event.target.value)} spellCheck={false} /></label>
          <label>MCP 服务名（每行一个，完全访问模式下授权整个服务）<textarea value={mcp} onChange={(event) => setMcp(event.target.value)} rows={3} spellCheck={false} /></label>
        </div>
      </details>
      {result?.acp || model !== "default" || mode ? <>
        <label>模型<NativeSelect value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="default">Agent 默认模型</option>
          {model !== "default" && !result?.acp?.models.some((item) => item.id === model) ? <option value={model}>{model}</option> : null}
          {result?.acp?.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </NativeSelect></label>
        <label>运行模式<NativeSelect value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="">Agent 默认模式</option>
          {mode && !result?.acp?.modes.some((item) => item.id === mode) ? <option value={mode}>{mode}</option> : null}
          {result?.acp?.modes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </NativeSelect></label>
      </> : null}
      <SettingsSwitch label="允许此 Agent 接收 Biny 记忆" checked={allowMemory} onChange={setAllowMemory} disabled={busy} detail="还需开启聊天记忆。关闭后停止新注入，已发送的内容仍可能保留在外部历史中。" />
      <p>仅连接可信程序。外部 Agent 可访问本机文件；Biny 只能处理它主动发出的审批。</p>
      <div className="settings-row-actions">
        <button type="button" className="settings-primary-button" disabled={!command.trim()} onClick={execute}>{busy ? "正在连接并保存…" : "连接并保存"}</button>
        {onDelete ? <button type="button" className="settings-secondary-button" onClick={onDelete}>删除连接</button> : null}
      </div>
    </fieldset>
    {message ? <p role={failed ? "alert" : "status"}>{message}</p> : null}
  </div>;
}
