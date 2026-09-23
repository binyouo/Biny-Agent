/** 对话摘要、用户待办状态和项目建议的持久化契约；可被桌面渲染层直接引用。 */
export interface ThreadBriefSettings {
  enabled: boolean;
  autoTodo: boolean;
  projectSuggestions: boolean;
  minUserTurns: number;
  minNewChars: number;
  cluster: { threads: number; spread: number };
}

export const defaultThreadBriefSettings: ThreadBriefSettings = {
  enabled: true, autoTodo: true, projectSuggestions: true,
  minUserTurns: 2, minNewChars: 400, cluster: { threads: 3, spread: 2 }
};

export interface ThreadBrief {
  topic: string;
  goal: string;
  objects: string[];
  conclusions: string[];
  followUp: { what: string; quote: string } | null;
}

export interface BriefThreadReference {
  sessionId: string;
  projectId: string;
  title: string;
  createdAt: string;
}

export interface ThreadBriefRecord extends BriefThreadReference {
  brief: ThreadBrief;
  contentHash: string;
  materialLength: number;
  userTurns: number;
  updatedAt: string;
  status: "inbox" | "todo" | "done";
  statusManual: boolean;
  autoTodo?: { what: string; quote: string; at: string };
}

export interface BriefProjectCard {
  projectId: string;
  name: string;
  brief: string;
  focus: string;
  threads: BriefThreadReference[];
}

export interface BriefProjectSuggestion {
  id: string;
  signature: string;
  location?: string;
  kind: "create" | "link";
  projectId?: string;
  status: "open" | "accepted" | "dismissed" | "rejected";
  name: string;
  brief: string;
  focus: string;
  reason: string;
  threads: BriefThreadReference[];
  createdAt: string;
}

export interface ThreadBriefSnapshot {
  config: ThreadBriefSettings;
  defaults: ThreadBriefSettings;
  enabledAt: string;
  briefs: ThreadBriefRecord[];
  suggestions: BriefProjectSuggestion[];
  projects: BriefProjectCard[];
  lastError?: { sessionId: string; message: string; at: string };
}
