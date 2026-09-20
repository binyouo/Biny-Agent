/**
 * 结构化命令卡片数据。
 *
 * `/status`、`/usage` 等报告类命令除纯文本 `content` 外，可附带这份结构化数据
 * （纯 JSON，可跨 Runtime Host 序列化），TUI 用它渲染报告卡片；
 * CLI / Desktop 继续使用纯文本，互不影响。
 */

export interface CommandCardData {
  title: string;
  /** 分区之间渲染空行分隔，不设分区标题。 */
  sections: CommandCardSection[];
}

export interface CommandCardSection {
  rows: CommandCardRow[];
}

export interface CommandCardRow {
  label: string;
  value: CommandCardValue | CommandCardValue[];
  /** 行级强调色；对未显式指定样式的片段生效。 */
  tone?: "dim" | "muted" | "accent" | "success" | "warning" | "error";
  /** 默认折叠的细节行，展开后才显示。 */
  detail?: boolean;
}

export type CommandCardValue =
  | string
  | { text: string; style?: CardValueStyle }
  /** token 数由 TUI 端做紧凑格式化（1.2k / 128k / 1.5M）。 */
  | { tokens: number; style?: CardValueStyle };

export type CardValueStyle = "dim" | "muted" | "bold" | "accent" | "success" | "warning" | "error";
