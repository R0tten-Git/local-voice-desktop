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
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const READY_TIMEOUT_MS = 180_000
const REQUEST_TIMEOUT_MS = 30_000
const IDLE_MS = 300_000
const WAKE_GAP_MS = 90_000

/** llama-server 可执行文件：优先用打包进来的。 */
function llamaBinary() {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const candidates = [
    path.join(process.resourcesPath ?? '', 'llama', name),
    path.join(__dirname, '..', 'vendor', 'llama', name),
    path.join(__dirname, '..', 'llama-test', `llama-b11804`, name),
  ]
  return candidates.find((p) => fs.existsSync(p))
}

/** 找一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 把最近的音频片段留样，方便事后核对送进去的到底是什么。 */
const CHUNK_DIR = path.join(os.homedir(), 'Library', 'Logs', 'localvoice-chunks')
let chunkSeq = 0

function dumpChunk(wav) {
  try {
    fs.mkdirSync(CHUNK_DIR, { recursive: true })
    chunkSeq = (chunkSeq + 1) % 5
    fs.writeFileSync(path.join(CHUNK_DIR, `chunk-${chunkSeq}.wav`), wav)
  } catch {
    /* 留样失败不影响主流程 */
  }
}

/** 从 WAV 里取时长与峰值，写进日志。 */
function wavStats(wav) {
  try {
    const declaredRate = wav.readUInt32LE(24)
    const samples = Math.floor((wav.length - 44) / 2)
    let peak = 0
    for (let i = 44; i + 1 < wav.length; i += 2) {
      const v = Math.abs(wav.readInt16LE(i))
      if (v > peak) peak = v
    }
    return { seconds: samples / declaredRate, peak: peak / 32768, rate: declaredRate }
  } catch {
    return { seconds: 0, peak: 0, rate: 0 }
  }
}

/** 判断是不是模型退化输出（同一字符刷屏）。 */
function isDegenerate(text) {
  if (text.length < 12) return false
  // 某个字符连续出现 8 次以上
  if (/(.)\1{7,}/u.test(text)) return true
  // 字符种类极少但长度不短
  const unique = new Set(text.replace(/[\s，。、,.!?！？]/gu, '')).size
  return unique > 0 && unique <= 3 && text.length > 20
}

/** 去掉 llama.cpp 输出的 "language Chinese<asr_text>" 前缀。 */
function cleanAsrText(raw) {
  let text = String(raw ?? '').trim()
  if (text.includes('<asr_text>')) text = text.split('<asr_text>').pop()
  text = text.replace(/^language\s+\w+\s*/i, '')
  text = text.trim()
  return isDegenerate(text) ? '' : text
}

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
  async ensure(modelPath, gguf) {
    if (!modelPath) throw new Error('未指定模型目录：先调用 ensure(modelPath) 或 engine:start')
    if (this.child && (this.model !== modelPath || this.ggufKey !== JSON.stringify(gguf ?? null))) {
      this.kill(`切换模型：${path.basename(this.model ?? '')} → ${path.basename(modelPath)}`)
    }
    if (this.child !== undefined && this.onReady === undefined) return
    if (this.starting === undefined) {
      this.model = modelPath
      this.gguf = gguf
      this.ggufKey = JSON.stringify(gguf ?? null)
      this.starting = this.start(modelPath, gguf).catch((error) => {
        this.starting = undefined
        throw error
      })
    }
    await this.starting
  }

  /** 拉起子进程并等 ready。 */
  /**
   * 启动引擎。gguf 存在时走 llama.cpp，否则走 Python worker。
   * @param {string} modelPath 模型目录
   * @param {{model:string, mmproj:string}} [gguf] GGUF 文件名
   */
  async start(modelPath, gguf) {
    if (gguf !== undefined) return this.startLlama(modelPath, gguf)
    return this.startPython(modelPath)
  }

  /** llama.cpp 后端：常驻 llama-server，走 OpenAI 兼容 HTTP。 */
  async startLlama(modelPath, gguf) {
    const exe = llamaBinary()
    if (!exe) throw new Error('缺少 llama-server（安装包不完整）')
    this.mode = 'llama'
    this.model = modelPath
    this.port = await freePort()
    this.log(`启动 llama-server：${exe} --port ${this.port}`)

    const args = [
      '-m', path.join(modelPath, gguf.model),
      '--mmproj', path.join(modelPath, gguf.mmproj),
      '--port', String(this.port),
      '-c', '8192',
      '-t', String(Math.max(2, os.cpus().length)),
      '-ngl', this.allowGpu === false ? '0' : '99',
      // 音频编码器固定放 CPU：mtmd 的音频支持还是实验特性，
      // 在 Vulkan 等后端上会产出无效特征，导致模型输出一串重复字符。
      '--no-mmproj-offload',
      '--no-webui',
    ]
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(exe) })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          const text = line.trim()
          // 全量记录：启动失败往往只有几行 stderr，过滤掉就没线索了
          if (text) this.log(text.slice(0, 300))
        }
      })
    }
    child.on('error', (error) => {
      this.log(`llama-server 无法启动：${error.message}`)
      this.child = undefined
    })
    child.on('exit', (code, signal) => {
      this.log(`llama-server 退出（code=${code}, signal=${signal ?? '无'}）`)
      this.failAll(new Error(`llama-server 退出（code=${code}）`))
      this.child = undefined
    })

    // 等 /health 通过
    const started = Date.now()
    for (let i = 0; i < 240; i += 1) {
      if (!this.child) throw new Error('llama-server 启动失败')
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (response.ok) {
          this.log(`llama-server 就绪（${Date.now() - started}ms）`)
          this.armIdle()
          return
        }
      } catch {
        /* 继续等 */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.log(`llama-server 在 ${Date.now() - started}ms 内没有响应 /health`)
    this.kill('llama-server 启动超时')
    throw new Error('llama-server 启动超时')
  }

  startPython(modelPath) {
    this.mode = 'python'
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
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            // 缓解 CUDA 显存碎片（PyTorch 官方建议）
            PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
          },
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
    if (this.mode === 'llama') return this.attemptLlama(wav, timeoutMs)
    await this.ensure(this.model, this.gguf)
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

  /** 一次 llama.cpp 转写：音频以 base64 传给 /v1/chat/completions。 */
  async attemptLlama(wav, timeoutMs) {
    if (!this.child || this.port === undefined) throw new Error('引擎不可用')
    const started = Date.now()
    const stats = wavStats(wav)
    dumpChunk(wav)
    this.log(
      `音频 ${stats.seconds.toFixed(1)}s · ${stats.rate}Hz · 峰值 ${stats.peak.toFixed(3)}`,
    )
    const payload = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }],
        },
      ],
      temperature: 0,
      // 没有重复惩罚时，遇到静音/异常音频会退化成 "GGGG..." 直到上限
      repeat_penalty: 1.15,
      repeat_last_n: 64,
      max_tokens: 200,
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`llama-server HTTP ${response.status}`)
    const json = await response.json()
    this.lastUsedAt = Date.now()
    this.armIdle()
    const rawText = String(json.choices?.[0]?.message?.content ?? '')
    const degenerate = isDegenerate(rawText)
    this.log(`原始输出：${rawText.slice(0, 80)}${degenerate ? '（判定为退化输出）' : ''}`)

    if (degenerate) {
      this.degenerateCount = (this.degenerateCount ?? 0) + 1
      // 连续三次退化，说明这个后端在这台机器上算不对，切纯 CPU 重置
      if (this.degenerateCount >= 3 && this.allowGpu !== false) {
        this.log('连续退化输出，改用纯 CPU 重新加载模型')
        this.allowGpu = false
        this.kill('退化输出，切换纯 CPU')
      }
    } else {
      this.degenerateCount = 0
    }
    return {
      text: cleanAsrText(rawText),
      audioSeconds: Math.round(wav.length / 32) / 1000,
      inferenceSeconds: (Date.now() - started) / 1000,
    }
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
      if (this.mode !== 'llama') child.stdin.end()
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
