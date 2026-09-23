/**
 * Eval 契约模块。
 *
 * 存在的理由：loop、压缩策略、工具结果预算、system prompt 都改过了，但没有任何方式证明
 * 这些改动是进步。没有可重复的度量，后续每次调整都只能凭感觉，而"感觉变好了"和"真的变
 * 好了"在 agent 上经常是两回事。
 *
 * 度量口径刻意保持窄：通过与否、步数、token、成本、耗时。这几项都是客观可比的；"回答质量"
 * 这类需要再找一个模型来打分的指标不在这里，那会把评测本身变成又一个不可信的黑盒。
 */

export interface EvalFixtureFile {
  path: string;
  content: string;
  /** 验收前后必须保持原文和普通文件身份；这是结果约束，不是进程沙箱。 */
  protected?: boolean;
}

export interface EvalTask {
  id: string;
  prompt: string;
  /** 评测开始前写入临时工作区的文件。 */
  fixture: EvalFixtureFile[];
  /**
   * 判定通过的检查。命令在工作区内执行，退出码 0 视为通过。
   * 用可执行判据而不是让模型自评 —— 自评的通过率没有参考价值。
   */
  verify: string;
  /** 单个任务的步数上限；不给则用配置默认值。 */
  maxSteps?: number;
}

export interface EvalAttemptMetrics {
  steps: number;
  totalTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
}

export interface EvalTaskResult {
  taskId: string;
  passed: boolean;
  /** 未通过时的原因：验证失败输出，或运行期错误。 */
  failure?: string;
  durationMs: number;
  metrics: EvalAttemptMetrics;
}

export interface EvalReport {
  suite: string;
  label: string;
  startedAt: string;
  model: string;
  results: EvalTaskResult[];
  summary: EvalSummary;
}

export interface EvalSummary {
  tasks: number;
  passed: number;
  passRate: number;
  totalSteps: number;
  totalTokens?: number;
  totalCostUsd?: number;
  /** 有任一任务缺价格时为 false，此时不给成本数字。 */
  pricingKnown: boolean;
  totalDurationMs: number;
}

/** 两次运行的对照。指标缺失时给 undefined 而不是 0，避免把"没测到"读成"没变化"。 */
export interface EvalComparison {
  baseline: string;
  candidate: string;
  passRateDelta: number;
  stepsDelta: number;
  tokensDelta?: number;
  costUsdDelta?: number;
  /** 只在一侧通过的任务，是回归和改进最直接的证据。 */
  newlyPassing: string[];
  newlyFailing: string[];
}
