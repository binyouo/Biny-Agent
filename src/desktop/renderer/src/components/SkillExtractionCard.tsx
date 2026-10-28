/**
 * 技能提取进度卡（自进化）。
 *
 * 回合后旁路管线的界面反馈：展示提取、保存及结束状态；新一轮开始时清除。
 */
import React from "react";
import type { SkillExtractionCardState } from "../app/useDesktopEventBridge.js";
import { Icon } from "./Icon.js";

const stageCopy: Record<SkillExtractionCardState["stage"], string> = {
  extracting: "正在提取技能…",
  saving: "正在保存技能…",
  done: "已提取新技能",
  failed: "技能提取失败"
};

export function SkillExtractionCard({ state, onDismiss }: { state: SkillExtractionCardState; onDismiss(): void }): React.JSX.Element {
  const title = state.stage === "done" && state.updated ? "已更新技能" : stageCopy[state.stage];
  const running = state.stage !== "done" && state.stage !== "failed";
  return (
    <section aria-label="技能提取进度" className={`biny-skill-extraction-banner${running ? " is-running" : ""}`} role="status">
      <span aria-hidden="true" className="biny-skill-extraction-icon">
        {running ? <span className="mini-spinner" /> : <Icon name={state.stage === "failed" ? "info" : "wand"} size={16} />}
      </span>
      <div className="biny-skill-extraction-copy">
        <h3>{title}</h3>
        {state.skillName ? <p className="biny-skill-extraction-name"><code>{state.skillName}</code>{state.skillDescription ? <span> — {state.skillDescription}</span> : null}</p> : null}
      </div>
      {running ? null : (
        <button aria-label="关闭技能提取提示" className="biny-skill-extraction-dismiss" onClick={onDismiss} type="button"><Icon name="close" size={16} /></button>
      )}
    </section>
  );
}
