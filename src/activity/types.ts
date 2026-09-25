/**
 * Activity 与模型之间共享的最小数据契约。
 *
 * 分析模型只读取脱敏后的事件、OCR 和分析投影，不接收截图原图。
 * 查询统一返回已脱敏的 OCR 摘录和摘要，不因聊天模型位置而隐藏尚未分析的命中。
 */
export type ActivityModelRuntime = "builtin-llama.cpp" | "provider";

/**
 * 分析结果的存储档位：影响记忆重要性、摘要裁剪与未来的保留策略。
 * - ephemeral  : 临时/琐碎，通常很快会被覆盖
 * - standard   : 普通工作记录（默认）
 * - important  : 高价值产出，值得长期检索（决策、发布、架构结论）
 */
export type ActivityStorageTier = "ephemeral" | "standard" | "important";

/** 截图文件的物理保留档位，与分析结果的 storageTier 不是同一套枚举。 */
export type ActivitySnapshotStorageTier = "hot" | "warm" | "cold";

export type ActivitySource = "event" | "screenshot_fallback";

export type ActivityEventType =
  | "click"
  | "keypress"
  | "app_focus"
  | "browser_visit"
  | "window_title"
  | "lock"
  | "unlock"
  | "system";

export type ActivityServiceState =
  | "stopped"
  | "paused"
  | "running"
  | "permission_required"
  | "unavailable"
  | "error";

/** Desktop 设置页展示的运行态；它不包含截图、OCR 原文或输入具体键值。 */
export interface ActivityRuntimeSnapshot {
  state: ActivityServiceState;
  collectorAvailable: boolean;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  fallbackAvailable: boolean;
  /** macOS 当前是否处于锁屏；锁屏期间不采集截图，解锁后恢复。 */
  screenLocked: boolean;
  sessions: number;
  events: number;
  fallbackCaptures: number;
  storageBytes: number;
  recentSessions: ActivitySessionSummary[];
  currentSessionId?: string;
  currentApplication?: string;
  error?: string;
}

export interface ActivitySessionSummary {
  id: string;
  startedAt: string;
  endedAt?: string;
  snapshotCount: number;
  eventCount: number;
  applications: string[];
  /** 已分析 session 的标题/摘要投影；未分析时为空，设置页最近会话直接展示。 */
  analysisTitle?: string;
  analysisDescription?: string;
}
