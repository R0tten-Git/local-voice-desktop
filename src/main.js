/**
 * Electron 主进程：窗口、麦克风权限、引擎 IPC。
 */
const { app, BrowserWindow, ipcMain, session, shell, dialog, clipboard, Tray, Menu, nativeImage, nativeTheme } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Engine } = require('./engine')
const { probe, MODELS } = require('../scripts/probe')
const { downloadModel } = require('./downloader')
const bootstrap = require('./bootstrap')

/** @type {BrowserWindow | undefined} */
let window
/** 引擎日志同时写一份到文件：出问题时不用复现也能看现场。 */
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs')
const LOG_PATH = path.join(LOG_DIR, 'LocalVoice.log')

function logLine(line) {
  console.log('[engine]', line)
  window?.webContents.send('engine:log', String(line))
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

const engine = new Engine(logLine)

// ------------------------------------------------------------------ 悬浮窗

/** @type {BrowserWindow | undefined} */
let floatWindow

function createFloatWindow() {
  if (floatWindow) return floatWindow
  floatWindow = new BrowserWindow({
    width: 168,
    height: 46,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  floatWindow.setAlwaysOnTop(true, 'floating')
  floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  floatWindow.loadFile(path.join(__dirname, 'renderer', 'float.html'))

  // 放在屏幕右上角，避开菜单栏
  const { workArea } = require('electron').screen.getPrimaryDisplay()
  floatWindow.setPosition(workArea.x + workArea.width - 190, workArea.y + 12)
  return floatWindow
}

function showFloat() {
  const win = createFloatWindow()
  if (!win) return
  win.webContents.send('status:sync', status)
  win.showInactive()
}

function hideFloat() {
  floatWindow?.hide()
}

ipcMain.on('float:show-main', () => showWindow())

ipcMain.on('app:close-now', () => {
  closing = true
  window?.close()
})

// ------------------------------------------------------------------ 菜单栏

/** @type {Tray | undefined} */
let tray
/** 最近一次上报的状态，菜单栏和菜单文案都靠它 */
let status = { phase: 'idle', elapsedMs: 0, chars: 0 }
/** 用户在关闭对话框里已做出选择，后续 close 不再拦截 */
let closing = false
/** 菜单文案没变就不重建，否则每 500ms 重建一次菜单 */
let lastMenuLabel = ''

function statusText() {
  const seconds = Math.floor(status.elapsedMs / 1000)
  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  if (status.phase === 'recording') return `● ${mmss}`
  if (status.phase === 'paused') return `❚❚ ${mmss}`
  return ''
}

function refreshTray() {
  if (!tray) return
  // macOS 直接把文字放在菜单栏；Windows 没有 setTitle，只能靠 tooltip 和菜单
  if (process.platform === 'darwin') tray.setTitle(statusText())
  const label =
    status.phase === 'recording'
      ? `录音中 ${statusText().replace('● ', '')} · ${status.chars} 字`
      : status.phase === 'paused'
        ? `已暂停 · ${status.chars} 字`
        : '就绪'
  tray.setToolTip(`LocalVoice — ${label}`)
  if (label === lastMenuLabel) return
  lastMenuLabel = label
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: '显示窗口', click: () => showWindow() },
      {
        label: status.phase === 'recording' ? '暂停' : '开始 / 继续',
        click: () => window?.webContents.send('command:toggle'),
      },
      { type: 'separator' },
      { label: '退出 LocalVoice', click: () => app.quit() },
    ]),
  )
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png')
    const icon = nativeImage.createFromPath(iconPath)
    logLine(`托盘图标：${iconPath} 尺寸=${icon.getSize().width}x${icon.getSize().height} 空=${icon.isEmpty()}`)
    icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.on('click', () => showWindow())
    refreshTray()
    logLine('托盘已创建')
  } catch (error) {
    logLine(`托盘创建失败：${error.message}`)
  }
}

function showWindow() {
  if (!window || window.isDestroyed()) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

ipcMain.on('status:update', (_event, next) => {
  const changed = status.phase !== next.phase
  status = { ...status, ...next }
  refreshTray()
  // 只有录音/暂停时才浮出来，空闲就藏起来
  if (status.phase === 'idle') hideFloat()
  else floatWindow?.webContents.send('status:sync', status)
  if (changed) logLine(`状态：${next.phase} 时长=${Math.round(next.elapsedMs / 1000)}s`)
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
  closing = false
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
  // 主窗口收起时用悬浮小球接管"还在录音"的反馈。
  // 必须绑在 createWindow 里：关掉窗口再打开会得到一个新对象，
  // 之前绑在旧对象上的监听不会自动迁移。
  window.on('minimize', () => {
    if (status.phase === 'recording' || status.phase === 'paused') showFloat()
  })
  window.on('hide', () => {
    if (status.phase === 'recording' || status.phase === 'paused') showFloat()
  })
  window.on('restore', () => hideFloat())
  window.on('show', () => hideFloat())
  // 关窗保护：有内容时先问要不要保存，避免一键 X 丢掉整场转写
  window.on('close', (event) => {
    if (closing) return
    if (status.chars <= 0) return
    event.preventDefault()

    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['保存并关闭', '直接关闭', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      message: '关闭前要保存这次转写吗？',
      detail: `本次共 ${status.chars} 字，直接关闭将无法恢复。`,
    })
    if (choice === 2) return
    if (choice === 1) {
      closing = true
      window.close()
      return
    }
    window.webContents.send('command:save-then-close')
  })

  window.on('closed', () => {
    hideFloat()
    window = undefined
  })
}

app.whenReady().then(() => {
  // 麦克风权限：Electron 默认会拒，必须显式放行
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture')
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media')

  if (process.env.LOCALVOICE_SNAPSHOT_THEME) {
    nativeTheme.themeSource = process.env.LOCALVOICE_SNAPSHOT_THEME
  }

  logLine(`启动 LocalVoice ${app.getVersion()} · ${process.platform}/${process.arch}`)

  createWindow()
  createTray()

  // 开发用：设了 LOCALVOICE_SNAPSHOT 就把窗口内容存成 PNG 后退出
  if (process.env.LOCALVOICE_SNAPSHOT) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.LOCALVOICE_SNAPSHOT_DEMO) {
          try {
            const injected = await window.webContents.executeJavaScript(`
              (() => {
                const rows = [
                  ['23:04:27', '首先来猜一猜，下面哪些是现代最重的动物？'],
                  ['23:04:32', '是从这个像素运用到这个像素，沿着画好的路径。'],
                  ['23:04:40', '是时光飞逝，恰好存在六点十五分，是地图上一个真实的坐标，一段精准的海岸线。'],
                  ['23:04:48', '是一字不差的文字，用代码代替你，是用傅里叶函数画出的樱花。'],
                  ['23:04:50', '答案是以上所有。'],
                ]
                const host = document.querySelector('.transcript')
                host.innerHTML = ''
                for (const [ts, text] of rows) {
                  const line = document.createElement('div')
                  line.className = 'line'
                  const time = document.createElement('time')
                  time.textContent = ts
                  const span = document.createElement('span')
                  span.textContent = text
                  line.append(time, span)
                  host.append(line)
                }
                const partial = document.createElement('div')
                partial.className = 'line partial'
                const t2 = document.createElement('time')
                t2.textContent = '23:04:56'
                const s2 = document.createElement('span')
                s2.textContent = '各种 AI 平台，包括 Cloud'
                partial.append(t2, s2)
                host.append(partial)

                const state = document.querySelector('#state')
                state.textContent = '录音中 00:54'
                state.classList.add('live')
                document.querySelector('#stats').textContent = '288 字 · 11 句'
                document.querySelector('#toggle').classList.add('live')
                document.querySelector('#levelFill').style.width = '46%'
                document.querySelector('#diag').textContent =
                  '电平 0.0121 · 峰值 0.2250 · 阈值 0.0035 · MacBook Air 麦克风 · 48000Hz · 推理 297ms'

                const wave = document.querySelector('#wave')
                wave.classList.add('live')
                const shape = [.02, .06, .11, .05, .16, .09, .03, .12, .07, .19, .04, .08, .14, .06, .1, .05, .13, .07]
                ;[...wave.children].forEach((bar, index) => {
                  bar.style.height = (3 + Math.min(19, Math.sqrt(shape[index % shape.length] / 0.05) * 19)).toFixed(1) + 'px'
                })
                for (const id of ['copy', 'save', 'clear']) document.getElementById(id).disabled = false

                return host.children.length
              })()
            `)
            console.error('[snapshot] 注入结果:', injected)
            await new Promise((resolve) => setTimeout(resolve, 800))
          } catch (error) {
            console.error('[snapshot] 注入失败:', error.message)
          }
        }
        const image = await window.webContents.capturePage()
        fs.writeFileSync(process.env.LOCALVOICE_SNAPSHOT, image.toPNG())
        closing = true // 截图工具不弹"要保存吗"
        app.quit()
      }, process.env.LOCALVOICE_SNAPSHOT_DEMO ? 5200 : 2500)
    })
  }

  // 点击程序坞图标时无论如何都把窗口带回来（包括最小化状态，以及窗口已被关闭）
  app.on('activate', () => showWindow())
})

app.on('window-all-closed', () => {
  engine.kill()
  if (process.platform !== 'darwin') {
    tray?.destroy()
    app.quit()
  }
})

app.on('before-quit', () => engine.kill())

// ---------------------------------------------------------------- IPC

ipcMain.handle('system:probe', async () => {
  const result = await probe()
  return { ...result, installed: installed(), environment: bootstrap.status() }
})

ipcMain.handle('app:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('只允许打开 http(s) 链接')
  await shell.openExternal(url)
  return true
})

ipcMain.handle('env:cuda-status', async () => {
  const [cuda, torch] = [await bootstrap.detectCuda(), bootstrap.torchCuda()]
  return { ...cuda, ...torch }
})

let installingCuda = false

ipcMain.handle('env:install-cuda', async () => {
  if (installingCuda) throw new Error('GPU 加速包正在安装')
  installingCuda = true
  try {
    return await bootstrap.installCudaTorch(
      (line) => window?.webContents.send('env:log', line),
      (progress) => window?.webContents.send('cuda:progress', progress),
    )
  } finally {
    installingCuda = false
  }
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
  let model = MODELS.find((m) => m.id === modelId)
  if (!model) {
    // 兜底：界面状态异常导致传了空 id 时，选一个已下载的可用模型
    const ready = MODELS.filter((m) => fs.existsSync(modelDir(m.repo)))
    model = ready[0]
    if (!model) throw new Error(`未知模型：${modelId ?? '(空)'}，且没有已下载的模型`)
    logLine(`模型 id 为空，回退到 ${model.id}`)
  }
  const dir = modelDir(model.repo)
  if (!fs.existsSync(dir)) throw new Error(`模型未下载：${dir}`)
  const started = Date.now()
  await engine.ensure(dir, model.gguf)
  return { modelId, modelPath: dir, loadMs: Date.now() - started }
})

ipcMain.handle('engine:transcribe', async (_event, { wav, language, partial }) => {
  if (typeof wav !== 'string' || wav.length === 0) throw new Error('音频为空')
  // 临时稿允许更早放弃：它只是预览，卡住不能拖累定稿
  return await engine.transcribe(
    Buffer.from(wav, 'base64'),
    language ?? 'auto',
    partial === true ? 8_000 : 30_000,
  )
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
    const result = await downloadModel(
      model.repo,
      dest,
      (progress) => {
        window?.webContents.send('model:progress', { modelId, ...progress })
      },
      model.include,
    )
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
