import { contextBridge, ipcRenderer } from "electron";
import { computerIpc, type ComputerDesktopApi } from "../../../computer/protocol.js";
const api: ComputerDesktopApi = {
  strict: async enabled => await ipcRenderer.invoke(computerIpc.strict, enabled),
  approve: async bundleId => await ipcRenderer.invoke(computerIpc.approve, bundleId),
  revoke: async bundleId => await ipcRenderer.invoke(computerIpc.revoke, bundleId),
  status: async () => await ipcRenderer.invoke(computerIpc.status),
  enable: async () => await ipcRenderer.invoke(computerIpc.enable),
  control: async value => await ipcRenderer.invoke(computerIpc.control, value),
  preview: async enabled => await ipcRenderer.invoke(computerIpc.preview, enabled),
  foreground: async enabled => await ipcRenderer.invoke(computerIpc.foreground, enabled),
  logging: async enabled => await ipcRenderer.invoke(computerIpc.logging, enabled),
  diagnostics: async () => await ipcRenderer.invoke(computerIpc.diagnostics),
  requestAccessibility: async () => await ipcRenderer.invoke(computerIpc.accessibility),
  testSetup: async () => await ipcRenderer.invoke(computerIpc.test)
};
contextBridge.exposeInMainWorld("binyComputer", api);
