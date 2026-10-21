import React, { useId, useRef, useState } from "react";
import { formatDuration } from "../../chatModel.js";
import type { TimelineTool } from "../../sessionTimeline.js";
import { Icon } from "../Icon.js";
import { ToolCodeBlock } from "./ToolCodeBlock.js";
import { ToolExecutionStatus } from "./ToolExecutionStatus.js";
import { ToolParameters } from "./ToolParameters.js";

export function ScriptToolDetails({ tool }: { tool: TimelineTool }): React.JSX.Element {
  const [showCalls, setShowCalls] = useState(false);
  const callsId = useId();
  const result = tool.modelResult ?? tool.result;
  const envelope = result !== null && typeof result === "object" && "ok" in result && typeof result.ok === "boolean" && "childCalls" in result && Array.isArray(result.childCalls) ? result : undefined;
  const children = tool.children ?? [];
  const count = children.length || (envelope && Array.isArray(envelope.childCalls) ? envelope.childCalls.length : 0);
  const progress = tool.updates.filter(update => update.text).map(update => update.text).join("\n");
  const stdout = envelope && "stdout" in envelope && typeof envelope.stdout === "string" ? envelope.stdout : result === undefined && progress ? progress : undefined;
  const error = envelope && "error" in envelope && typeof envelope.error === "string" ? envelope.error : undefined;
  const value = envelope ? "value" in envelope ? envelope.value : undefined : result;
  return <section className="script-tool-details">
    <ToolParameters args={tool.args} toolName={tool.tool} />
    <section className="script-result" aria-label="脚本结果">
      <div className="script-result-summary">
        <h4 className="tool-section-label">结果</h4>
        <ToolExecutionStatus status={tool.status} />
        {count > 0 ? <button type="button" className="script-calls-toggle" aria-expanded={showCalls} aria-controls={callsId} onClick={() => setShowCalls(current => !current)}>
          <Icon name="chevron" size={12} />{count} tool {count === 1 ? "call" : "calls"}
        </button> : null}
        {tool.optimization ? <span className={tool.optimization.savedTokens < 0 ? "script-token-increase" : undefined} title="工具结果估算，不代表账单节省">{tool.optimization.savedTokens >= 0 ? `~${tool.optimization.savedTokens.toLocaleString()} tokens saved` : `~${Math.abs(tool.optimization.savedTokens).toLocaleString()} extra tokens`}</span> : null}
      </div>
      {showCalls ? <ul className="script-child-calls" id={callsId} aria-label="内部工具调用">
        {children.map(child => <ScriptChildCall key={child.id} tool={child} />)}
        {!children.length ? <li className="script-output-empty">当前记录未保存内部调用详情</li> : null}
      </ul> : null}
      {stdout !== undefined && stdout !== "" ? <ToolCodeBlock text={stdout} label="工具结果" copyLabel="复制输出" /> : null}
      {value !== undefined ? <>
        {stdout ? <h4 className="tool-section-label">返回值</h4> : null}
        <ToolCodeBlock text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} language={typeof value === "string" ? "text" : "json"} label="工具结果" copyLabel="复制返回值" />
      </> : null}
      {error && error !== tool.error ? <div className="script-output-error"><ToolCodeBlock text={error} label="脚本错误" copyLabel="复制错误" /></div> : null}
      {!stdout && value === undefined && !error && !tool.error ? <p className="script-output-empty">{tool.status === "success" ? "已完成，无输出" : "暂无输出"}</p> : null}
    </section>
  </section>;
}

function ScriptChildCall({ tool }: { tool: TimelineTool }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const result = tool.result;
  return <li className="script-child-call" data-tool-call-id={tool.id} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); button.current?.focus(); }
  }}>
    <button type="button" ref={button} aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(value => !value)}>
      <ToolExecutionStatus status={tool.status} compact />
      <span className="script-child-name">{tool.tool}</span>
      {tool.durationMs !== undefined ? <span>{tool.durationMs < 1000 ? `${tool.durationMs}ms` : formatDuration(tool.durationMs)}</span> : null}
      {!open && tool.error ? <span className="script-child-error-preview">{tool.error}</span> : null}
      <span className="script-child-chevron"><Icon name="chevron" size={12} /></span>
    </button>
    {open ? <div className="script-child-detail" id={detailId}>
      {tool.args !== undefined ? <div><h5>ARGS</h5><ToolCodeBlock text={typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2)} language={typeof tool.args === "string" ? "text" : "json"} label="调用参数" copyLabel="复制调用参数" /></div> : null}
      {result !== undefined ? <div><h5>RESULT</h5><ToolCodeBlock text={typeof result === "string" ? result : JSON.stringify(result, null, 2)} language={typeof result === "string" ? "text" : "json"} label="调用结果" copyLabel="复制调用结果" /></div> : null}
      {tool.error ? <p role="alert" className="script-output-error">{tool.error}</p> : null}
    </div> : null}
  </li>;
}
