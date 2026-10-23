/**
 * 预加载脚本：只暴露必要的 IPC 接口，渲染进程拿不到 Node。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('localVoice', {
  probe: () => ipcRenderer.invoke('system:probe'),
  start: (modelId) => ipcRenderer.invoke('engine:start', modelId),
  transcribe: (wav, language, partial, speakers) =>
    ipcRenderer.invoke('engine:transcribe', { wav, language, partial, speakers }),
  resetSpeakers: () => ipcRenderer.invoke('speaker:reset'),
  speakerMenu: (payload) => ipcRenderer.invoke('speaker:menu', payload),
  stop: () => ipcRenderer.invoke('engine:stop'),
  download: (modelId) => ipcRenderer.invoke('model:download', modelId),
  installEnv: () => ipcRenderer.invoke('env:install'),
  cudaStatus: () => ipcRenderer.invoke('env:cuda-status'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  installCuda: () => ipcRenderer.invoke('env:install-cuda'),
  onCudaProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('cuda:progress', listener)
    return () => ipcRenderer.removeListener('cuda:progress', listener)
  },
  onEngineLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('engine:log', listener)
    return () => ipcRenderer.removeListener('engine:log', listener)
  },
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
  reportStatus: (status) => ipcRenderer.send('status:update', status),
  /** 悬浮窗专用：接收主进程广播的状态 */
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('status:sync', listener)
    return () => ipcRenderer.removeListener('status:sync', listener)
  },
  /** 悬浮窗点击后回到主窗口 */
  showMain: () => ipcRenderer.send('float:show-main'),
  /** 保存完成后请求关闭窗口 */
  closeNow: () => ipcRenderer.send('app:close-now'),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command)
    ipcRenderer.on('command:show', listener)
    ipcRenderer.on('command:toggle', listener)
    ipcRenderer.on('command:save-then-close', listener)
    return () => ipcRenderer.removeListener('command:toggle', listener)
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
