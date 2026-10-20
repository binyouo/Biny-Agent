import { useState } from "react";
import type { TimelineTool } from "../../sessionTimeline.js";
import { ToolActivityDetail } from "../ToolActivity.js";
import { IoCard } from "./IoCard.js";

export function ScriptToolDetails({ tool, projectId, onPreviewFile, onOpenExternal }: {
  tool: TimelineTool; projectId: string; onPreviewFile(path: string): void; onOpenExternal(url: string): void;
}): React.JSX.Element {
  const [tab, setTab] = useState("返回结果");
  const args = tool.args as { code?: string } | undefined;
  return <section className="tool-section">
    <div className="tool-optimization-tabs" role="group" aria-label="脚本详情">
      {["返回结果", "内部调用", "脚本"].map(name => <button type="button" key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}
    </div>
    {tab === "返回结果" ? <IoCard input={null} output={tool.result === undefined ? "等待脚本返回结果" : JSON.stringify(tool.modelResult ?? tool.result, null, 2)} outputError={tool.status === "failed"} /> : null}
    {tab === "脚本" ? <IoCard input={args?.code ?? "此记录未保存脚本正文"} output={null} /> : null}
    {tab === "内部调用" ? <>
      <p className="tool-optimization-note">展开结果只在本地显示，不会自动加入模型上下文。</p>
      {tool.children?.length ? tool.children.map(child => <details key={child.id}>
        <summary>{child.tool} · {({ success: "完成", running: "运行中", waiting: "等待中", failed: "失败", denied: "已拒绝", aborted: "已中止", cancelled: "已取消", skipped: "已跳过", unknown: "结果未知" })[child.status]}</summary>
        <ToolActivityDetail tool={child} projectId={projectId} onPreviewFile={onPreviewFile} onOpenExternal={onOpenExternal} />
      </details>) : <p>尚无内部调用记录</p>}
    </> : null}
  </section>;
}
