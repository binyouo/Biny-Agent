export const googleWorkspaceExportFormats = ["pdf", "docx", "odt", "rtf", "txt", "html", "epub", "md", "xlsx", "ods", "csv", "tsv", "pptx", "odp", "png", "svg", "jpeg"] as const;

export type GoogleWorkspaceKind = "document" | "spreadsheets" | "presentation" | "drawings";
type GoogleWorkspaceFormat = typeof googleWorkspaceExportFormats[number];

const exportFormats: Record<GoogleWorkspaceKind, readonly GoogleWorkspaceFormat[]> = {
  document: ["pdf", "docx", "odt", "rtf", "txt", "html", "epub", "md"],
  spreadsheets: ["xlsx", "ods", "csv", "tsv", "pdf"],
  presentation: ["pptx", "odp", "pdf", "txt"],
  drawings: ["png", "svg", "pdf", "jpeg"]
};

export function googleWorkspaceExportUrl(pageUrl: string, format: string): { url: string; kind: GoogleWorkspaceKind } {
  const page = new URL(pageUrl);
  if (page.origin !== "https://docs.google.com" || page.username || page.password) throw new Error("Google Workspace 导出需要当前页面位于 docs.google.com。");
  const match = /^\/(document|spreadsheets|presentation|drawings)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(page.pathname);
  if (!match) throw new Error("当前页面不是可导出的 Google 文档、表格或演示文稿。");
  const kind = match[1] as GoogleWorkspaceKind;
  if (!(exportFormats[kind] as readonly string[]).includes(format)) throw new Error(`Google ${kind} 不支持 ${format} 格式导出。`);
  const target = new URL(`/${kind}/d/${match[2]}/export`, page.origin);
  target.searchParams.set("format", format);
  if (kind === "spreadsheets") {
    const hash = new URLSearchParams(page.hash.slice(1));
    const gid = page.searchParams.get("gid") ?? hash.get("gid");
    if (gid && /^\d+$/u.test(gid)) target.searchParams.set("gid", gid);
  }
  return { url: target.href, kind };
}
