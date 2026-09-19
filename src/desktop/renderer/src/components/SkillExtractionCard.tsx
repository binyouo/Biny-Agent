/**
 * 技能提取进度卡（自进化）。
 *
 * 回合后旁路管线的界面反馈：analyst 判定值得提取后才出现，展示提取、保存与
 * 完成状态；新一轮 run.started 时由事件桥清除。卡片不创建对象，只呈现结果。
 */
import React from "react";
import type { SkillExtractionCardState } from "../app/useDesktopEventBridge.js";
import { Icon } from "./Icon.js";

const stageCopy: Record<SkillExtractionCardState["stage"], { title: string; detail: string }> = {
  extracting: { title: "正在提取可复用技能…", detail: "从本回合工作流生成 SKILL.md" },
  saving: { title: "正在保存技能…", detail: "写入全局技能目录，下一回合可用" },
  done: { title: "已提取新技能", detail: "下一回合可直接调用" }
};

export function SkillExtractionCard({ state, onDismiss }: { state: SkillExtractionCardState; onDismiss(): void }): React.JSX.Element {
  const copy = stageCopy[state.stage];
  const running = state.stage !== "done";
  return (
    <section aria-label="技能提取进度" className={`biny-skill-extraction-banner${running ? " is-running" : ""}`} role="status">
      <span aria-hidden="true" className="biny-skill-extraction-icon">
        {running ? <span className="mini-spinner" /> : <Icon name="wand" size={16} />}
      </span>
      <div className="biny-skill-extraction-copy">
        <div className="biny-skill-extraction-title-row">
          <h3>{copy.title}</h3>
          {state.skillName ? <span className={`biny-skill-extraction-badge${state.updated ? " is-updated" : ""}`}>{state.updated ? "已更新" : "新技能"}</span> : null}
        </div>
        {state.skillName ? <p className="biny-skill-extraction-name"><code>{state.skillName}</code>{state.skillDescription ? <span> — {state.skillDescription}</span> : null}</p> : null}
        <p className="biny-skill-extraction-detail">{copy.detail}</p>
      </div>
      {running ? null : (
        <button aria-label="关闭技能提取提示" className="biny-skill-extraction-dismiss" onClick={onDismiss} type="button"><Icon name="close" size={16} /></button>
      )}
    </section>
  );
}
