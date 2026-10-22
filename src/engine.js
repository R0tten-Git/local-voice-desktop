/**
 * Python 引擎桥：管理常驻的 Qwen3-ASR 进程。
 *
 * 协议与 DSH 插件版完全一致（ndjson over stdio），所以两端共用同一个 worker.py：
 *   启动完成 → {"type":"ready"}
 *   请求     → {"id":1,"wav":"<base64 WAV 16k mono pcm16>","language":"auto"}
 *   应答     → {"id":1,"text":"…","ms":620,"audioSec":3.1}
 *
 * 设计要点：
 *  · 模型只在启动时加载一次；
 *  · 空闲一段时间自动回收（省内存）；
 *  · 从睡眠唤醒后主动换新进程（Metal 上下文可能已失效）；
 *  · 传输层失败自动重启重试一次。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const READY_TIMEOUT_MS = 180_000
const REQUEST_TIMEOUT_MS = 30_000
const IDLE_MS = 300_000
const WAKE_GAP_MS = 90_000

/**
 * Apple Silicon 用 MLX 版 worker，其余平台用 torch 版。
 * 两者协议完全一致，主进程只换脚本，不用改引擎桥。
 */
function workerScript() {
  const name = process.platform === 'darwin' && process.arch === 'arm64'
    ? 'worker.py'
    : 'worker_torch.py'
  const candidates = [
    path.join(process.resourcesPath ?? '', 'engine', name),
    path.join(__dirname, '..', 'engine', name),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[1]
}

/** 找应用自己的 python（venv 里那个），Windows 与 POSIX 的目录结构不同。 */
function findPython() {
  const venv = process.env.LOCAL_VOICE_VENV ?? path.join(os.homedir(), '.local/venvs/mlx-audio')
  const candidates = [
    process.env.LOCAL_VOICE_PYTHON,
    process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'python.exe')
      : path.join(venv, 'bin', 'python'),
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) ?? 'python3'
}

function isTransportFailure(error) {
  return /worker|管道|pipe|EPIPE|closed|不可用|超时|已退出/i.test(String(error && error.message))
}

class Engine {
  constructor(log = () => {}) {
    this.log = log
    this.child = undefined
    this.starting = undefined
    this.onReady = undefined
    this.buffer = ''
    this.pending = new Map()
    this.seq = 0
    this.idle = undefined
    this.lastUsedAt = undefined
    this.model = undefined
  }

  get running() {
    return this.child !== undefined
  }

  /** 启动（或确认已启动）引擎。 */
  async ensure(modelPath) {
    if (!modelPath) throw new Error('未指定模型目录：先调用 ensure(modelPath) 或 engine:start')
    if (this.child && this.model !== modelPath) {
      this.kill(`切换模型：${path.basename(this.model ?? '')} → ${path.basename(modelPath)}`)
    }
    if (this.child !== undefined && this.onReady === undefined) return
    if (this.starting === undefined) {
      this.model = modelPath
      this.starting = this.start(modelPath).catch((error) => {
        this.starting = undefined
        throw error
      })
    }
    await this.starting
  }

  /** 拉起子进程并等 ready。 */
  start(modelPath) {
    return new Promise((resolve, reject) => {
      const python = findPython()
      const script = workerScript()
      this.log(`启动引擎：${python} ${script} ${modelPath}`)
      let child
      try {
        child = spawn(python, [script, modelPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Windows 上 Python 的 stdout 默认走系统代码页（中文系统是 GBK），
          // 父进程按 UTF-8 解码就会变成乱码方块。
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        })
      } catch (error) {
        reject(error)
        return
      }
      this.child = child
      let settled = false
      let timer
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.onReady = undefined
        if (error) {
          this.starting = undefined
          this.kill(`启动失败：${error.message}`)
          reject(error)
        } else {
          this.armIdle()
          resolve()
        }
      }
      timer = setTimeout(() => settle(new Error('模型加载超时')), READY_TIMEOUT_MS)
      this.onReady = () => settle()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.receive(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) this.log(line.trim())
        }
      })
      child.on('error', (error) => settle(error))
      child.on('exit', (code, signal) => {
        this.failAll(new Error(`引擎已退出（code=${code}, signal=${signal}）`))
        if (!settled) settle(new Error(`引擎退出（code=${code}）`))
        this.child = undefined
        this.starting = undefined
      })
    })
  }

  receive(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.dispatch(line)
    }
  }

  dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`忽略无法解析的输出：${line.slice(0, 120)}`)
      return
    }
    if (message.type === 'ready') {
      this.onReady?.()
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (typeof message.error === 'string') {
      entry.reject(new Error(message.error))
    } else {
      entry.resolve({
        text: message.text ?? '',
        audioSeconds: message.audioSec ?? 0,
        inferenceSeconds: (message.ms ?? 0) / 1000,
      })
    }
  }

  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** 转写一段 16kHz 单声道 PCM16 WAV。 */
  async transcribe(wav, language = 'auto', timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.model) throw new Error('引擎尚未启动：请先选择模型')
    const now = Date.now()
    // 只有完全空闲时才做"唤醒重启"，否则会把在途的临时稿请求一起判死
    if (
      this.child &&
      this.pending.size === 0 &&
      this.lastUsedAt &&
      now - this.lastUsedAt > WAKE_GAP_MS
    ) {
      this.kill('空闲超过 90 秒，视为刚唤醒')
    }
    try {
      const result = await this.attempt(wav, language, timeoutMs)
      this.lastUsedAt = Date.now()
      return result
    } catch (error) {
      if (!isTransportFailure(error)) throw error
      this.kill(`传输层失败：${error.message}`)
      const result = await this.attempt(wav, language, timeoutMs)
      this.lastUsedAt = Date.now()
      return result
    }
  }

  async attempt(wav, language, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ensure(this.model)
    const child = this.child
    if (!child) throw new Error('引擎不可用')
    const id = ++this.seq
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.log(`识别超时（${timeoutMs}ms）`)
        reject(new Error('识别超时'))
        // 只有连一条都不剩了才重启引擎，避免一次超时把别的请求一起判死
        if (this.pending.size === 0) this.kill('最后一条请求超时')
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ id, wav: wav.toString('base64'), language })}\n`)
    this.armIdle()
    return await result
  }

  armIdle() {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.pending.size === 0 && this.child) {
        this.kill('空闲 5 分钟回收')
      }
    }, IDLE_MS)
    this.idle.unref?.()
  }

  /**
   * 停止引擎并拒绝在途请求。
   * @param {string} reason - 谁触发停止，会写进日志（排查事故的关键）
   */
  kill(reason = '未说明') {
    const inflight = this.pending.size
    this.log(`停止引擎（原因：${reason}，在途请求 ${inflight} 个）`)
    clearTimeout(this.idle)
    const child = this.child
    this.child = undefined
    this.starting = undefined
    this.onReady = undefined
    this.buffer = ''
    this.failAll(new Error(`引擎已停止（${reason}）`))
    if (!child) return
    try {
      child.stdin.end()
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已经没了 */
        }
      }, 2000).unref?.()
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Engine, findPython, workerScript }
