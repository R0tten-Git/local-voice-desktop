/**
 * Electron 主进程：窗口、麦克风权限、引擎 IPC。
 */
const { app, BrowserWindow, ipcMain, session, shell, dialog, clipboard } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Engine } = require('./engine')
const { probe, MODELS } = require('../scripts/probe')
const { downloadModel } = require('./downloader')
const bootstrap = require('./bootstrap')

/** @type {BrowserWindow | undefined} */
let window
const engine = new Engine((line) => {
  console.log('[engine]', line)
  window?.webContents.send('engine:log', String(line))
})

/** 模型目录：默认 ~/models/<仓库名>。 */
function modelDir(repo) {
  return path.join(os.homedir(), 'models', repo.split('/').pop())
}

/** 已下载的模型。 */
function installed() {
  return MODELS.filter((m) => {
    const dir = modelDir(m.repo)
    try {
      return fs.readdirSync(dir).some((name) => name.endsWith('.safetensors') || name.endsWith('.gguf'))
    } catch {
      return false
    }
  }).map((m) => m.id)
}

function createWindow() {
  window = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 480,
    title: 'LocalVoice',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#111214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  window.on('closed', () => {
    window = undefined
  })
}

app.whenReady().then(() => {
  // 麦克风权限：Electron 默认会拒，必须显式放行
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture')
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media')

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  engine.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => engine.kill())

// ---------------------------------------------------------------- IPC

ipcMain.handle('system:probe', async () => {
  const result = await probe()
  return { ...result, installed: installed(), environment: bootstrap.status() }
})

/** 环境安装：同一时间只跑一个 */
let installingEnv = false

ipcMain.handle('env:install', async () => {
  if (installingEnv) throw new Error('环境安装已在进行中')
  installingEnv = true
  try {
    const result = await bootstrap.install((line) => {
      window?.webContents.send('env:log', line)
    })
    return result
  } finally {
    installingEnv = false
  }
})

ipcMain.handle('engine:start', async (_event, modelId) => {
  const model = MODELS.find((m) => m.id === modelId)
  if (!model) throw new Error(`未知模型：${modelId}`)
  const dir = modelDir(model.repo)
  if (!fs.existsSync(dir)) throw new Error(`模型未下载：${dir}`)
  const started = Date.now()
  await engine.ensure(dir)
  return { modelId, modelPath: dir, loadMs: Date.now() - started }
})

ipcMain.handle('engine:transcribe', async (_event, { wav, language }) => {
  if (typeof wav !== 'string' || wav.length === 0) throw new Error('音频为空')
  return await engine.transcribe(Buffer.from(wav, 'base64'), language ?? 'auto')
})

ipcMain.handle('engine:stop', async () => {
  engine.kill()
  return true
})

/** 同一时间只允许一个下载任务 */
let downloading = undefined

ipcMain.handle('model:download', async (_event, modelId) => {
  if (downloading !== undefined) throw new Error('已有下载在进行中')
  const model = MODELS.find((m) => m.id === modelId)
  if (!model) throw new Error(`未知模型：${modelId}`)
  const dest = modelDir(model.repo)
  downloading = modelId
  try {
    const result = await downloadModel(model.repo, dest, (progress) => {
      window?.webContents.send('model:progress', { modelId, ...progress })
    })
    return { ...result, modelId }
  } finally {
    downloading = undefined
  }
})

ipcMain.handle('app:saveMarkdown', async (_event, { text, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '保存转写',
    defaultPath: path.join(app.getPath('documents'), suggestedName ?? 'transcript.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (canceled || !filePath) return { saved: false }
  fs.writeFileSync(filePath, text, 'utf8')
  return { saved: true, filePath }
})

ipcMain.handle('app:copy', async (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

ipcMain.handle('app:openModelsFolder', async () => {
  const dir = path.join(os.homedir(), 'models')
  fs.mkdirSync(dir, { recursive: true })
  shell.openPath(dir)
  return dir
})
