const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("geminiDesktop", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  openDevTools: () => ipcRenderer.invoke("window:devtools"),
  openAppWindow: (url) => ipcRenderer.invoke("tool:openAppWindow", url),
  browserUserAgent: () => ipcRenderer.invoke("browser:userAgent"),
  authStatus: () => ipcRenderer.invoke("auth:status"),
  clearGoogleSession: () => ipcRenderer.invoke("auth:clear"),
  onAuthChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },
  onInternalNavigate: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on("navigate:internal", listener);
    return () => ipcRenderer.removeListener("navigate:internal", listener);
  }
});
