const { contextBridge, ipcRenderer } = require('electron')

// Real installed RAM in GB — navigator.deviceMemory is capped at 8 by the
// browser, so the app uses this to raise its memory-gated limits on big
// machines (subdivision safety cap, 3MF import triangle limit).
let totalMemoryGB = 0
try {
  totalMemoryGB = Math.round(process.getSystemMemoryInfo().total / (1024 * 1024))
} catch {}

contextBridge.exposeInMainWorld('electronAPI', {
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  writeFile: (filePath, buffer) => ipcRenderer.invoke('write-file', filePath, buffer),
  totalMemoryGB
})