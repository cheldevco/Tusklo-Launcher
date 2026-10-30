const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  call: (ch, arg) => ipcRenderer.invoke(ch, arg),
  on: (ch, fn) => ipcRenderer.on(ch, (_, d) => fn(d)),
});
