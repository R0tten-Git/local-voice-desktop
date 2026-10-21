/**
 * 渲染进程：录音 → 能量切句 → 交给主进程的引擎 → 上屏。
 *
 * 音频参数与 DSH 插件版保持一致，这样两边的识别效果可以直接对照：
 *   16 kHz 单声道 · 30 ms 一帧 · 静音 950 ms 判句 · 最长 9 s 强切
 */
const api = window.localVoice

const LIVE = {
  sampleRate: 16000,
  silenceMs: 950,
  minSpeechMs: 400,
  maxChunkMs: 9000,
  calibrateMs: 1200,
  /** 阈值下限：防数字静音误触发，但别设太高（实测底噪 0.0005 时 0.008 会吃掉小声） */
  /** 句首回卷：触发时把前面这段也带上，避免切掉第一个字或被重复解码 */
  prerollMs: 400,
  minThreshold: 0.0035,
  maxThreshold: 0.03,
}

const el = {
  model: document.getElementById('model'),
  setup: document.getElementById('setup'),
  recommend: document.getElementById('recommend'),
  cmd: document.getElementById('cmd'),
  copyCmd: document.getElementById('copyCmd'),
  openModels: document.getElementById('openModels'),
  download: document.getElementById('download'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  dlText: document.getElementById('dlText'),
  transcript: document.getElementById('transcript'),
  toggle: document.getElementById('toggle'),
  state: document.getElementById('state'),
  stats: document.getElementById('stats'),
  diag: document.getElementById('diag'),
  copy: document.getElementById('copy'),
  save: document.getElementById('save'),
  clear: document.getElementById('clear'),
}

const state = {
  probe: undefined,
  phase: 'idle', // idle | recording | paused
  lines: [],
  level: 0,
  peak: 0,
  threshold: 0,
  queue: Promise.resolve(),
  pending: 0,
  session: undefined,
  startedAt: 0,
  accumulated: 0,
  timer: undefined,
}

const pad = (n) => String(n).padStart(2, '0')
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
const elapsedText = (ms) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}`
const fileStamp = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

// ------------------------------------------------------------------ 音频工具

function frameRms(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function resampleTo16k(input, inRate) {
  if (inRate === LIVE.sampleRate) return input
  const ratio = inRate / LIVE.sampleRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio
    const index = Math.floor(position)
    const frac = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    out[i] = a * (1 - frac) + b * frac
  }
  return out
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const put = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  put(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  put(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

function toBase64(bytes) {
  let binary = ''
  const step = 8192
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

function concatFrames(frames) {
  let total = 0
  for (const frame of frames) total += frame.length
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

// ------------------------------------------------------------------ 录音

async function openMicrophone(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const AudioCtor = window.AudioContext ?? window.webkitAudioContext
  const audio = new AudioCtor({ sampleRate: LIVE.sampleRate })
  const source = audio.createMediaStreamSource(stream)
  const processor = audio.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  processor.connect(audio.destination)

  /** 最近若干帧的环形缓冲，只在"没在说话"时维护 */
  const preroll = []
  const prerollMax = Math.max(1, Math.ceil(LIVE.prerollMs / 256))

  const vad = {
    threshold: null,
    noiseFloor: 0,
    trackedMs: 0,
    calibrating: [],
    calibrateMs: 0,
    speaking: false,
    frames: [],
    voicedMs: 0,
    silenceMs: 0,
    chunkMs: 0,
  }

  const flush = () => {
    const frames = vad.frames
    const voiced = vad.voicedMs
    const perFrame = frames.length > 0 ? (frames[0].length / LIVE.sampleRate) * 1000 : 0
    let keep = frames.length
    if (perFrame > 0) {
      const drop = Math.max(0, Math.floor((vad.silenceMs - 200) / perFrame))
      keep = Math.max(1, frames.length - drop)
    }
    const samples = concatFrames(frames.slice(0, keep))
    vad.frames = []
    vad.voicedMs = 0
    vad.silenceMs = 0
    vad.chunkMs = 0
    vad.speaking = false
    if (voiced >= LIVE.minSpeechMs && samples.length > 0) onChunk(samples)
  }

  processor.onaudioprocess = (event) => {
    const raw = event.inputBuffer.getChannelData(0).slice()
    const block = resampleTo16k(raw, audio.sampleRate)
    const ms = (block.length / LIVE.sampleRate) * 1000
    const level = frameRms(block)
    state.level = level
    if (level > state.peak) state.peak = level

    if (vad.threshold === null) {
      vad.calibrating.push(level)
      vad.calibrateMs += ms
      if (vad.calibrateMs >= LIVE.calibrateMs) {
        const sorted = vad.calibrating.slice().sort((a, b) => a - b)
        const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
        vad.threshold = Math.min(LIVE.maxThreshold, Math.max(LIVE.minThreshold, floor * 3.5))
        vad.noiseFloor = Math.max(floor, 0.0005)
        state.threshold = vad.threshold
      }
      return
    }

    const voiced = level >= vad.threshold
    if (!vad.speaking) {
      if (!voiced) {
        // 只在静音帧上估计噪声，所以有人连续说话时阈值不会被抬高
        vad.noiseFloor = vad.noiseFloor * 0.9 + level * 0.1
        vad.trackedMs += ms
        if (vad.trackedMs >= 1000) {
          vad.trackedMs = 0
          const target = Math.min(LIVE.maxThreshold, Math.max(LIVE.minThreshold, vad.noiseFloor * 3.5))
          // 每次最多挪动 20%，避免阈值抖动把句子切断
          vad.threshold += (target - vad.threshold) * 0.2
          state.threshold = vad.threshold
        }
        preroll.push(block)
        if (preroll.length > prerollMax) preroll.shift()
        return
      }
      vad.speaking = true
      vad.frames = [...preroll, block]
      vad.voicedMs = ms
      vad.silenceMs = 0
      vad.chunkMs = ms
      preroll.length = 0
      return
    }

    vad.frames.push(block)
    vad.chunkMs += ms
    if (voiced) {
      vad.voicedMs += ms
      vad.silenceMs = 0
    } else {
      vad.silenceMs += ms
    }

    if (vad.silenceMs >= LIVE.silenceMs && vad.voicedMs >= LIVE.minSpeechMs) flush()
    else if (vad.chunkMs >= LIVE.maxChunkMs) flush()
  }

  return {
    stop() {
      processor.onaudioprocess = null
      try {
        processor.disconnect()
        source.disconnect()
      } catch {
        /* ignore */
      }
      for (const track of stream.getTracks()) track.stop()
      void audio.close().catch(() => {})
      if (vad.speaking) flush()
    },
  }
}

// ------------------------------------------------------------------ 转写

function transcribe(samples) {
  state.pending += 1
  render()
  state.queue = state.queue
    .then(async () => {
      const wav = encodeWav(samples, LIVE.sampleRate)
      const result = await api.transcribe(toBase64(wav), 'auto')
      const text = (result.text ?? '').trim()
      if (text) appendLine(text)
    })
    .catch((error) => {
      appendMessage(`识别失败：${error.message ?? error}`)
    })
    .finally(() => {
      state.pending -= 1
      render()
    })
}

/** 去掉句首的语气词：「嗯，现在是。」→「现在是。」 */
function trimLeadingFiller(text) {
  const stripped = text.replace(/^[嗯啊呃哦噢呀哈额]+[，,、。\s]*/u, '').trim()
  return stripped.length > 0 ? stripped : text
}

function appendLine(text) {
  text = trimLeadingFiller(text)
  state.lines.push({ id: `${Date.now()}-${Math.random()}`, ts: clock(new Date()), text })
  const previous = el.transcript.querySelector('.placeholder')
  if (previous) previous.remove()
  const node = document.createElement('div')
  node.className = 'line'
  const time = document.createElement('time')
  time.textContent = state.lines[state.lines.length - 1].ts
  const body = document.createElement('span')
  body.textContent = text
  node.append(time, body)
  el.transcript.append(node)
  el.transcript.scrollTop = el.transcript.scrollHeight
  render()
}

function appendMessage(text) {
  const node = document.createElement('div')
  node.className = 'line'
  node.style.color = 'var(--danger)'
  node.textContent = text
  el.transcript.append(node)
}

// ------------------------------------------------------------------ 会话

async function start() {
  const modelId = el.model.value
  el.state.textContent = '引擎加载中…'
  render()
  try {
    const info = await api.start(modelId)
    el.state.textContent = `引擎就绪（${info.loadMs}ms）`
    state.session = await openMicrophone((samples) => transcribe(samples))
    state.phase = 'recording'
    state.startedAt = Date.now()
    state.timer = setInterval(render, 500)
    render()
  } catch (error) {
    el.state.textContent = `启动失败：${error.message ?? error}`
    state.phase = state.lines.length > 0 ? 'paused' : 'idle'
    render()
  }
}

function pause() {
  state.session?.stop()
  state.session = undefined
  state.accumulated += Date.now() - state.startedAt
  clearInterval(state.timer)
  state.timer = undefined
  state.phase = state.lines.length > 0 ? 'paused' : 'idle'
  render()
}

function toggle() {
  if (state.phase === 'recording') pause()
  else void start()
}

function clearAll() {
  state.session?.stop()
  state.session = undefined
  clearInterval(state.timer)
  state.timer = undefined
  state.lines = []
  state.accumulated = 0
  state.peak = 0
  state.threshold = 0
  state.phase = 'idle'
  el.transcript.innerHTML = '<p class="placeholder">点右下角的 ▶ 开始说话。说完一句停一下，就会出一行字。</p>'
  render()
}

// ------------------------------------------------------------------ 渲染

function render() {
  const recording = state.phase === 'recording'
  el.toggle.textContent = recording ? '❚❚' : '▶'
  el.toggle.classList.toggle('live', recording)
  el.toggle.title = recording ? '暂停（保留内容）' : '开始 / 继续'

  if (recording) {
    const ms = state.accumulated + (Date.now() - state.startedAt)
    el.state.textContent = `录音中 ${elapsedText(ms)}`
    el.state.classList.add('live')
  } else {
    el.state.classList.remove('live')
    // 暂停后必须改写这行，否则会一直挂着"录音中"
    el.state.textContent =
      state.lines.length > 0 ? `已暂停 ${elapsedText(state.accumulated)}` : '就绪'
  }

  const chars = state.lines.reduce((sum, line) => sum + line.text.length, 0)
  el.stats.textContent = `${chars} 字 · ${state.lines.length} 句${state.pending > 0 ? ` · 识别中 ${state.pending}` : ''}`
  el.diag.textContent =
    `电平 ${state.level.toFixed(4)} · 峰值 ${state.peak.toFixed(4)} · ` +
    `阈值 ${state.threshold > 0 ? state.threshold.toFixed(4) : '校准中'}`

  for (const button of [el.copy, el.save, el.clear]) button.disabled = state.lines.length === 0
}

// ------------------------------------------------------------------ 初始化

function downloadCommand(model) {
  return [
    '# 国内（魔搭，约 2–3 分钟）',
    `git clone https://www.modelscope.cn/${model.repo}.git ~/models/${model.repo.split('/').pop()}`,
    '',
    '# 海外',
    `HF_ENDPOINT=https://hf-mirror.com ~/.local/venvs/mlx-audio/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('${model.repo}', local_dir='$HOME/models/${model.repo.split('/').pop()}')"`,
  ].join('\n')
}

let downloading = false

/** 把字节数写成人话。 */
function human(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

api.onProgress((progress) => {
  if (progress.phase === 'file') {
    el.dlText.textContent = `(${progress.index}/${progress.files}) ${progress.file}`
    return
  }
  if (progress.phase === 'bytes') {
    const pct = progress.totalBytes > 0 ? (progress.doneBytes / progress.totalBytes) * 100 : 0
    el.barFill.style.width = `${pct.toFixed(1)}%`
    const speed = progress.bytesPerSecond ? ` · ${human(progress.bytesPerSecond)}/s` : ''
    el.dlText.textContent =
      `${human(progress.doneBytes)} / ${human(progress.totalBytes)} · ${pct.toFixed(0)}%${speed}`
    return
  }
  if (progress.phase === 'done') {
    el.barFill.style.width = '100%'
    el.dlText.textContent = `完成 · ${human(progress.totalBytes)}`
  }
})

async function startDownload() {
  if (downloading) return
  const modelId = el.model.value
  downloading = true
  el.download.disabled = true
  el.download.textContent = '下载中…'
  el.bar.classList.remove('hidden')
  el.barFill.style.width = '0%'
  el.dlText.textContent = '正在连接魔搭…'
  try {
    await api.download(modelId)
    el.dlText.textContent = '下载完成，正在校验…'
    await new Promise((resolve) => setTimeout(resolve, 600))
    await init()
    el.state.textContent = '模型已就绪'
  } catch (error) {
    el.dlText.textContent = `下载失败：${error.message ?? error}`
    el.download.textContent = '重试下载'
  } finally {
    downloading = false
    el.download.disabled = false
    if (el.download.textContent === '下载中…') el.download.textContent = '下载并安装'
  }
}

async function init() {
  state.probe = await api.probe()
  document.body.classList.add(`platform-${state.probe.platform}`)
  const { options, recommended, installed, backend, totalRamGb, gpuName } = state.probe

  el.model.innerHTML = ''
  for (const model of options) {
    const option = document.createElement('option')
    option.value = model.id
    const installedMark = installed.includes(model.id) ? '✓ ' : ''
    option.textContent = `${installedMark}${model.label}（${model.sizeGb} GB）`
    if (model.id === recommended) option.selected = true
    el.model.append(option)
  }

  const missing = options.length > 0 && !installed.includes(el.model.value)
  el.setup.classList.toggle('hidden', !missing)
  if (missing) {
    const pick = options.find((m) => m.id === recommended) ?? options[0]
    el.recommend.innerHTML =
      `后端 <b>${backend}</b> · 内存 ${totalRamGb} GB${gpuName ? ` · ${gpuName}` : ''}<br>` +
      `建议先装 <span class="pick">${pick.label}</span>（${pick.sizeGb} GB）—— ${pick.note}`
    el.cmd.textContent = downloadCommand(pick)
  }

  render()
}

el.toggle.addEventListener('click', toggle)
el.clear.addEventListener('click', clearAll)
el.copy.addEventListener('click', () => {
  const text = state.lines.map((line) => line.text).join('\n')
  void api.copy(text)
  el.state.textContent = `已复制 ${text.length} 字`
})
el.save.addEventListener('click', async () => {
  const header = `# 实时转写 ${new Date().toLocaleString('zh-CN')}\n\n- 模型：${el.model.selectedOptions[0]?.textContent ?? ''}\n\n`
  const body = state.lines.map((line) => `[${line.ts}] ${line.text}`).join('\n')
  const result = await api.saveMarkdown(`${header}${body}\n`, `localvoice-${fileStamp()}.md`)
  if (result.saved) el.state.textContent = `已保存 ${result.filePath}`
})
el.copyCmd.addEventListener('click', () => {
  void api.copy(el.cmd.textContent)
  el.copyCmd.textContent = '已复制'
  setTimeout(() => (el.copyCmd.textContent = '复制下载命令'), 1500)
})
el.openModels.addEventListener('click', () => void api.openModelsFolder())
el.download.addEventListener('click', () => void startDownload())
el.model.addEventListener('change', async () => {
  el.setup.classList.add('hidden')
  const missing = !state.probe.installed.includes(el.model.value)
  el.setup.classList.toggle('hidden', !missing)
  if (missing) {
    const model = state.probe.options.find((m) => m.id === el.model.value)
    el.cmd.textContent = downloadCommand(model)
    el.bar.classList.add('hidden')
    el.barFill.style.width = '0%'
    el.dlText.textContent = ''
  }
})

init().catch((error) => {
  el.state.textContent = `初始化失败：${error.message ?? error}`
})
