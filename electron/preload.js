const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  openCashDrawer: (printerName) => ipcRenderer.invoke('open-cash-drawer', printerName),
});
