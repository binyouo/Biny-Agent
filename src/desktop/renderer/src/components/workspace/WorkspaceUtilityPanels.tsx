/** 工具面板读取当前时间线；浏览器与提交动作复用现有桌面入口。 */
import { executionToolLabel, type TimelineTool } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";

export function WorkspaceToolsPanel({ tools }: { tools: TimelineTool[] }): React.JSX.Element {
  const labels: Record<string, string> = { waiting: "等待中", running: "运行中", success: "已完成", failed: "失败", denied: "已拒绝", aborted: "已中断", cancelled: "已取消", skipped: "已跳过", unknown: "状态未知" };
  return <section className="inspector-utility-panel">
    <header className="inspector-utility-heading"><h2>工具运行</h2><p>本次对话中的工具调用、状态和耗时。</p></header>
    <div className="inspector-result-scroll">{tools.length === 0 ? <div className="inspector-empty"><Icon name="wrench" size={28} /><p>还没有工具调用</p><small>本次对话的工具运行记录会显示在这里。</small></div> : [...tools].reverse().map((tool, index) => <article className="inspector-tool-row" key={`${tool.id}:${index}`}>
      <header><strong>{executionToolLabel(tool.tool)}</strong><span className="inspector-tool-status" data-status={tool.status}>{labels[tool.status] ?? tool.status}</span></header>
      <div className="inspector-tool-meta"><code>{tool.id}</code>{tool.durationMs !== undefined ? <small>{(tool.durationMs / 1000).toFixed(1)}s</small> : null}</div>
      {tool.description ? <p>{tool.description}</p> : null}
      {tool.error ? <p className="inspector-error" role="alert">{tool.error}</p> : null}
      <details><summary>输入参数</summary><pre>{JSON.stringify(tool.args, null, 2)}</pre></details>
      {tool.result !== undefined ? <details><summary>运行结果</summary><pre>{typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}</pre></details> : null}
    </article>)}</div>
  </section>;
}
