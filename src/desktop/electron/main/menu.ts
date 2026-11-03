/**
 * 应用菜单。
 *
 * 自定义菜单项统一转成 `DesktopMenuAction` 发给渲染进程处理，主进程这边不实现业务动作；
 * 编辑、窗口、缩放等交给 Electron 的内置 role。
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { DesktopMenuAction } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";

export function installApplicationMenu(getWindow: () => BrowserWindow | undefined): void {
  const send = (action: DesktopMenuAction): void => {
    const window = getWindow();
    if (!window) return;
    // 窗口被显式隐藏时先显示出来，否则用户点了菜单看不到任何反应。
    if (!window.isVisible()) window.show();
    window.webContents.send(desktopIpc.menuAction, action);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Biny",
      submenu: [
        { role: "about", label: "关于 Biny" },
        { type: "separator" },
        { label: "设置…", accelerator: "CommandOrControl+,", click: () => send("settings") },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Biny" },
        { role: "hideOthers", label: "隐藏其他应用" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出 Biny" }
      ]
    },
    {
      label: "文件",
      submenu: [
        { label: "新建任务", accelerator: "CommandOrControl+N", click: () => send("new-task") },
        { label: "打开项目…", accelerator: "CommandOrControl+O", click: () => send("open-project") },
        { type: "separator" },
        { role: "close", label: "关闭窗口" }
      ]
    },
    {
      role: "editMenu",
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
        ...(process.platform === "darwin" ? [
          { type: "separator" as const },
          { label: "语音", submenu: [
            { role: "startSpeaking" as const, label: "开始朗读" },
            { role: "stopSpeaking" as const, label: "停止朗读" }
          ] }
        ] : [])
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "快速搜索", accelerator: "CommandOrControl+K", click: () => send("search") },
        { label: "显示或隐藏侧边栏", accelerator: "CommandOrControl+B", click: () => send("toggle-sidebar") },
        { label: "聚焦任务输入", accelerator: "CommandOrControl+Enter", click: () => send("focus-composer") },
        { type: "separator" },
        { label: "截取窗口…", accelerator: "CommandOrControl+Shift+S", click: () => send("capture-window") },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" }
      ]
    },
    {
      role: "windowMenu",
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(process.platform === "darwin" ? [
          { type: "separator" as const },
          { role: "front" as const, label: "前置全部窗口" }
        ] : [
          { role: "close" as const, label: "关闭窗口" }
        ])
      ]
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        {
          label: "Biny 版本",
          enabled: false,
          sublabel: app.getVersion()
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
