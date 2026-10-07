export type ApplicationImportSource = "claude" | "codex" | "chatgpt";
export type ApplicationImportCategory = "settings" | "mcp" | "sessions";

export interface ApplicationImportItem {
  id: string;
  category: ApplicationImportCategory;
  label: string;
  detail: string;
}

export interface ApplicationImportPreview {
  id: string;
  source: ApplicationImportSource;
  label: string;
  items: ApplicationImportItem[];
  warnings: string[];
}

export interface ApplicationImportResult {
  id: string;
  category: ApplicationImportCategory;
  label: string;
  status: "imported" | "skipped" | "failed" | "unknown";
  detail?: string;
  sessionId?: string;
}

export interface ApplicationImportHistory {
  id: string;
  source: ApplicationImportSource;
  label: string;
  time: string;
  workspaceRoot: string;
  results: ApplicationImportResult[];
}

export interface ApplicationImportSnapshot {
  sources: Array<{ source: ApplicationImportSource; label: string; detected: boolean; description: string }>;
  history: ApplicationImportHistory[];
  sync: { enabled: boolean; hasSelection: boolean; lastError?: string;
    selections?: Array<{ source: ApplicationImportSource; label: string; workspaceRoot: string; itemIds: string[] }> };
}
