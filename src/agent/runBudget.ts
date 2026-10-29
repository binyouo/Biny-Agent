/**
 * 普通 Agent Loop 的运行预算。
 *
 * 配置解析集中在这里，避免 AgentSession 和 Coordinator 分别解释预算。
 */
import type { AgentConfig } from "../config/schema.js";

export interface RunBudget {
  softStepLimit: number;
  hardStepLimit: number;
}

export function resolveRunBudget(agent: AgentConfig["agent"]): RunBudget {
  return {
    softStepLimit: Math.min(agent.softStepLimit, agent.hardStepLimit),
    hardStepLimit: agent.hardStepLimit
  };
}
