import { contextBridge, ipcRenderer } from "electron";
import { appshotsIpc, type AppshotEvent, type AppshotsApi } from "../../../computer/appshotsProtocol.js";
const api: AppshotsApi = {
  state: async () => await ipcRenderer.invoke(appshotsIpc.state), settings: async value => await ipcRenderer.invoke(appshotsIpc.settings, value),
  prewarm: async () => await ipcRenderer.invoke(appshotsIpc.prewarm), capture: async () => await ipcRenderer.invoke(appshotsIpc.capture),
  attach: async (project, id) => await ipcRenderer.invoke(appshotsIpc.attach, project, id),
  onEvent: listener => { const receive = (_event: Electron.IpcRendererEvent, value: AppshotEvent): void => listener(value); ipcRenderer.on(appshotsIpc.event, receive); return () => { ipcRenderer.removeListener(appshotsIpc.event, receive); }; }
};
contextBridge.exposeInMainWorld("binyAppshots", api);
