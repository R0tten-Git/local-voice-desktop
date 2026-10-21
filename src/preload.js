/**
 * 预加载脚本：只暴露必要的 IPC 接口，渲染进程拿不到 Node。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('localVoice', {
  probe: () => ipcRenderer.invoke('system:probe'),
  start: (modelId) => ipcRenderer.invoke('engine:start', modelId),
  transcribe: (wav, language, partial) =>
    ipcRenderer.invoke('engine:transcribe', { wav, language, partial }),
  stop: () => ipcRenderer.invoke('engine:stop'),
  download: (modelId) => ipcRenderer.invoke('model:download', modelId),
  installEnv: () => ipcRenderer.invoke('env:install'),
  onEnvLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('env:log', listener)
    return () => ipcRenderer.removeListener('env:log', listener)
  },
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('model:progress', listener)
    return () => ipcRenderer.removeListener('model:progress', listener)
  },
  openModelsFolder: () => ipcRenderer.invoke('app:openModelsFolder'),
  saveMarkdown: (text, suggestedName) => ipcRenderer.invoke('app:saveMarkdown', { text, suggestedName }),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  onLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('engine:log', listener)
    return () => ipcRenderer.removeListener('engine:log', listener)
  },
})
