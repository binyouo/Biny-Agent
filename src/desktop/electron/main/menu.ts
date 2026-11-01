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
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Biny" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: "退出 Biny" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "新建任务", accelerator: "CommandOrControl+N", click: () => send("new-task") },
        { label: "打开项目…", accelerator: "CommandOrControl+O", click: () => send("open-project") },
        { type: "separator" },
        { role: "close", label: "关闭窗口" }
      ]
    },
    { role: "editMenu", label: "Edit" },
    {
      label: "View",
      submenu: [
        { label: "快速搜索", accelerator: "CommandOrControl+K", click: () => send("search") },
        { label: "显示或隐藏侧边栏", accelerator: "CommandOrControl+B", click: () => send("toggle-sidebar") },
        { label: "聚焦任务输入", accelerator: "CommandOrControl+Enter", click: () => send("focus-composer") },
        { type: "separator" },
        { label: "截取窗口…", accelerator: "CommandOrControl+Shift+S", click: () => send("capture-window") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu", label: "Window" },
    {
      role: "help",
      label: "Help",
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
