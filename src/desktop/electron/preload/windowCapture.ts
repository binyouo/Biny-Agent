import { contextBridge, ipcRenderer } from "electron";
import { windowCaptureIpc, type WindowCaptureApi } from "../../windowCapture.js";
const api: WindowCaptureApi = {
  capture: async options => await ipcRenderer.invoke(windowCaptureIpc.capture, options),
  save: async dataUrl => await ipcRenderer.invoke(windowCaptureIpc.save, dataUrl),
  copy: async dataUrl => await ipcRenderer.invoke(windowCaptureIpc.copy, dataUrl)
};
contextBridge.exposeInMainWorld("binyCapture", api);
