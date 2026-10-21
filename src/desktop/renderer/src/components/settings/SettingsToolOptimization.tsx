import { OptimizationCallDetail } from "./OptimizationCallDetail.js";
import type { ToolOptimizationEntry } from "../../../../../session/toolOptimization.js";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { toolOptimizationState } from "./toolOptimizationState.js";

type MetricIcon = "code" | "zap" | "sparkles" | "layers" | "down" | "input" | "output" | "clock" | "terminal";
function SavingsIcon({ name, size = 16 }: { name: MetricIcon; size?: number }): React.JSX.Element {
  const paths: Record<MetricIcon, ReactNode> = {
    code: <><path d="m18 16 4-4-4-4M6 8l-4 4 4 4m8-12-4 16" /></>,
    zap: <path d="m13 2-10 12h8l-1 8L21 10h-8l1-8" />,
    sparkles: <><path d="m12 3 2.5 7.5L22 13l-7.5 2.5L12 23l-2.5-7.5L2 13l7.5-2.5L12 3ZM5 2v4M3 4h4" /></>,
    layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></>,
    down: <path d="m22 17-8-8-5 5-7-7m14 10h6v-6" />,
    input: <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />,
    output: <path d="M12 17V5m-5 5 5-5 5 5M5 17v4h14v-4" />,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    terminal: <><path d="m4 17 6-5-6-5m8 12h8" /></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function SavingsCard({ title, description, icon, children }: { title: string; description?: string; icon?: MetricIcon; children: ReactNode }): React.JSX.Element {
  return <section className="savings-card"><header><h3>{icon ? <span className="savings-emerald"><SavingsIcon name={icon} size={18} /></span> : null}{title}</h3>{description ? <p>{description}</p> : null}</header><div className="savings-card-content">{children}</div></section>;
}
function Metric({ icon, color, label, value, title }: { icon: MetricIcon; color: string; label: string; value: string; title?: string }): React.JSX.Element {
  return <div className="savings-metric" title={title}><div><span className={`savings-${color}`}><SavingsIcon name={icon} /></span>{label}</div><strong className={value.startsWith("-") ? "savings-rose" : undefined}>{value}</strong></div>;
}
const number = (value: number): string => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const percent = (value: number): string => `${value.toFixed(1)}%`;
const rate = (before: number, saved: number): number => before ? saved / before * 100 : 0;
const tier = (value: number): string => value < 0 ? "rose" : value >= 70 ? "emerald" : value >= 40 ? "cyan" : "blue";

export function SettingsToolOptimization(): React.JSX.Element {
  const [detail, setDetail] = useState<{ origin: NonNullable<ToolOptimizationEntry["origin"]>; optimizationId: string }>();
  const state = toolOptimizationState(window.biny);
  const { data: stats, error } = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  useEffect(() => { void state.refresh(); }, [state]);
  if (!stats && !error) return <div className="savings-loading" role="status"><span className="savings-spinner" />加载中…</div>;
  if (!stats) return <div className="savings-loading" role="alert"><p>统计读取失败：{error}</p><button type="button" onClick={() => { void state.refresh(true); }}>重试</button></div>;
  const compression = rate(stats.rtk.beforeTokens, stats.rtk.savedTokens);
  const maxCommand = Math.max(1, ...stats.commands.map(command => Math.abs(command.savedTokens)));
  const colors = ["emerald", "cyan", "blue", "violet", "fuchsia", "amber", "rose", "teal"];
  const positiveMax = Math.max(0, ...stats.daily.map(day => day.savedTokens));
  const negativeMax = Math.max(0, ...stats.daily.map(day => -day.savedTokens));
  const chartRange = Math.max(1, positiveMax + negativeMax);
  const baseline = negativeMax === 0 ? 160 : positiveMax / chartRange * 160;
  return <div className="tool-optimization-page">
    {detail ? <OptimizationCallDetail origin={detail.origin} optimizationId={detail.optimizationId} onClose={() => setDetail(undefined)} /> : null}
    <SavingsCard title="编程式工具调用" description="在沙箱内筛选工具结果，减少上下文占用。" icon="code">
      <div className="savings-ptc-metrics">
        <Metric icon="zap" color="emerald" label="节省 Token" value={number(stats.ptc.savedTokens)} />
        <Metric icon="sparkles" color="cyan" label="脚本运行次数" value={number(stats.ptc.runs)} />
        <Metric icon="layers" color="blue" label="工具调用次数" value={number(stats.toolCalls)} />
        <Metric icon="down" color="violet" label="已处理结果" value={number(stats.ptc.beforeTokens)} />
      </div>
    </SavingsCard>
    {stats.rtk.runs ? <>
      <SavingsCard title="RTK 压缩概览" icon="sparkles">
        <div className="savings-overview">
          <div className={`savings-gauge savings-${tier(compression)}`} role="img" aria-label={`压缩率 ${percent(compression)}`}>
            <svg width="140" height="80" viewBox="0 0 140 80" aria-hidden="true"><path className="savings-gauge-track" d="M14 70 A56 56 0 0 1 126 70" /><path d="M14 70 A56 56 0 0 1 126 70" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.min(100, Math.max(0, compression))} /></svg>
            <div><strong>{percent(compression)}</strong><span>压缩率</span></div>
          </div>
          <div className="savings-rtk-metrics">
            <Metric icon="zap" color="emerald" label="已节省 Token" value={number(stats.rtk.savedTokens)} />
            <Metric icon="terminal" color="blue" label="命令次数" value={number(stats.rtk.runs)} />
            <Metric icon="down" color="cyan" label="平均节省" value={percent(stats.average)} />
            <Metric icon="input" color="violet" label="输入 Token" value={number(stats.rtk.beforeTokens)} />
            <Metric icon="output" color="fuchsia" label="输出 Token" value={number(stats.rtk.afterTokens)} />
            <Metric icon="clock" color="amber" label="平均耗时" value={stats.durationCount ? `${Math.round(stats.totalDurationMs / stats.durationCount).toLocaleString()} ms` : "—"} title={`已采集 ${stats.durationCount} / ${stats.rtk.runs} 次命令耗时；旧记录不补造`} />
          </div>
        </div>
      </SavingsCard>
      <SavingsCard title="每日节省" description="最近 30 天">
        <div className="savings-daily-chart"><span className="savings-zero-line" style={{ top: `${baseline}px` }} />{stats.daily.map(day => <div tabIndex={0} key={day.date} className={`savings-column savings-${tier(rate(day.beforeTokens, day.savedTokens))}`} style={{ height: `${Math.max(1, Math.abs(day.savedTokens) / chartRange * 160)}px`, top: `${day.savedTokens > 0 ? baseline - day.savedTokens / chartRange * 160 : Math.min(159, baseline)}px` }} aria-label={`${day.date}：${day.savedTokens.toLocaleString()} tokens，${percent(rate(day.beforeTokens, day.savedTokens))}`}>
          <span className="savings-tooltip">{day.date}：{number(day.savedTokens)} tokens（{percent(rate(day.beforeTokens, day.savedTokens))}）</span>
        </div>)}</div>
        <div className="savings-chart-dates"><span>{stats.daily[0]?.date}</span><span>{stats.daily.at(-1)?.date}</span></div>
      </SavingsCard>
      <SavingsCard title="按命令统计" description="按节省量排序">
        <div className="savings-command-chart">{stats.commands.map((item, index) => <div key={item.command}>
          <div className="savings-command-label"><code title={item.command}>{item.command}</code><span>{number(item.savedTokens)} <small>({percent(rate(item.beforeTokens, item.savedTokens))})</small></span></div>
          <div className="savings-command-track"><span className={`savings-${item.savedTokens < 0 ? "rose" : colors[index % colors.length]}`} style={{ width: `${Math.abs(item.savedTokens) / maxCommand * 100}%` }} /></div>
        </div>)}</div>
      </SavingsCard>
      <SavingsCard title="最近命令" description="最近 20 条">
        <div className="savings-table-scroll"><table><thead><tr><th>时间</th><th>命令</th><th>已节省</th><th>压缩率</th></tr></thead><tbody>{stats.recent.map(({ optimization: item, time, origin }) => <tr key={item.id}>
          <td>{new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>{origin ? <button type="button" className="savings-command-link" onClick={() => setDetail({ origin, optimizationId: item.id })} title="查看原调用参数和结果"><code title={item.originalCommand ?? item.command}>{item.originalCommand ?? item.command ?? "未知命令"}</code></button> : <code title={item.originalCommand ?? item.command}>{item.originalCommand ?? item.command ?? "未知命令"}</code>}</td><td>{number(item.savedTokens)}</td><td className={`savings-${tier(rate(item.beforeTokens, item.savedTokens))}`}>{percent(rate(item.beforeTokens, item.savedTokens))}</td>
        </tr>)}</tbody></table></div>
      </SavingsCard>
    </> : <section className="savings-card savings-empty"><SavingsIcon name="zap" size={48} /><h3>暂无节省数据</h3><p>执行支持的命令后显示统计。</p></section>}
    {stats.incompleteSessions ? <p className="savings-notice" role="status">有 {stats.incompleteSessions} 个会话或项目无法读取，当前显示部分统计。</p> : null}
    <p className="savings-notice">全部项目累计估算；负数表示上下文增加。不含脚本生成、缓存和原文回查，不代表账单节省。<button type="button" onClick={() => { void state.refresh(true); }}>刷新</button></p>
    {error ? <p className="savings-notice" role="alert">刷新失败：{error}</p> : null}
  </div>;
}
