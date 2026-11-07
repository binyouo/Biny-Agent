const independentPages = new Set(["插件", "MCP 服务器", "导入", "浏览器", "远程访问", "Computer Use", "Appshots", "Token 节省", "关于"]);

export function settingsPageNeedsSnapshot(tab: string): boolean {
  return !independentPages.has(tab);
}
