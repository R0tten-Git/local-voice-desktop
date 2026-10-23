/**
 * 渲染进程：录音 → 能量切句 → 交给主进程的引擎 → 上屏。
 *
 * 音频参数与 DSH 插件版保持一致，这样两边的识别效果可以直接对照：
 *   16 kHz 单声道 · 30 ms 一帧 · 静音 950 ms 判句 · 最长 9 s 强切
 */
const api = window.localVoice

const LIVE = {
  sampleRate: 16000,
  silenceMs: 900,
  minSpeechMs: 400,
  /**
   * 硬上限。连续说话时靠它兜底，切得越碎越容易切在句子中间。
   * 实时感由"临时结果"负责，所以这里可以放宽。
   */
  maxChunkMs: 12000,
  /** 一段超过这么久之后，遇到 350ms 的短停顿就切（逗号级停顿，不会劈开词组） */
  midCutAfterMs: 4000,
  midSilenceMs: 300,
  /** 边说边出的临时结果：每隔这么久把当前缓冲送一次识别 */
  partialEveryMs: 1200,
  /** 推理慢的机器（CPU）自动放宽到这个间隔，否则临时结果会占满算力 */
  partialEverySlowMs: 5000,
  /** 单次推理超过这个时间就算"慢机器" */
  slowInferenceMs: 1200,
  /** 临时结果最多用多长的音频（越长越慢，10 秒够覆盖一句话） */
  partialWindowMs: 8000,
  /** 至少要说这么久才值得送一次临时结果 */
  partialMinMs: 900,
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
  envBlock: document.getElementById('envBlock'),
  installEnv: document.getElementById('installEnv'),
  envLog: document.getElementById('envLog'),
  gpuBanner: document.getElementById('gpuBanner'),
  gpuTitle: document.getElementById('gpuTitle'),
  gpuHint: document.getElementById('gpuHint'),
  gpuBar: document.getElementById('gpuBar'),
  gpuFill: document.getElementById('gpuFill'),
  gpuInstall: document.getElementById('gpuInstall'),
  pace: document.getElementById('pace'),
  speakers: document.getElementById('speakers'),
  envSize: document.getElementById('envSize'),
  envPath: document.getElementById('envPath'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  dlText: document.getElementById('dlText'),
  transcript: document.getElementById('transcript'),
  toggle: document.getElementById('toggle'),
  theme: document.getElementById('theme'),
  state: document.getElementById('state'),
  stats: document.getElementById('stats'),
  diag: document.getElementById('diag'),
  wave: document.getElementById('wave'),
  level: document.getElementById('level'),
  levelFill: document.getElementById('levelFill'),
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
  /** 需要一直挂在底部诊断行上的提示（错误等） */
  notice: '',
  /** 麦克风诊断信息（设备名 / 采样率） */
  audioInfo: '',
  /** 临时结果的间隔，按最近的推理耗时动态调整 */
  partialEveryMs: 1200,
  /** 当前是否在一个录音会话里（暂停也算，重新开始才算新会话） */
  sessionActive: false,
  /** 是否区分说话人 */
  speakers: true,
  /** 说话人编号 → 自定义名字 */
  speakerNames: {},
  /** 当前选中的模型 id —— 不依赖 DOM，避免 select 状态异常时取到空值 */
  modelId: '',
  /** 最近几次推理耗时，用来算平均值 */
  inferenceSamples: [],
  lastInferenceMs: 0,
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

/** 空状态：图标 + 一句引导。 */
const EMPTY_STATE = `
  <div class="placeholder">
    <div class="ring">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
      </svg>
    </div>
    <p class="ph-title">按下开始，边听边写</p>
    <p class="ph-hint">文字会实时出现在这里 · 音频不出本机</p>
  </div>`

function showEmptyState() {
  el.transcript.innerHTML = EMPTY_STATE
}

// ---------------------------------------------------------------- 说话人

const SPEAKER_COLORS = ['#5b8dff', '#f0a44a', '#4ec98a', '#c47bff', '#ff6b8a', '#3fc7d6']

function speakerLabel(id) {
  // 负数编号 = 还在"待定"的候选，第二个窗口确认后会转正并整组改名
  if (id < 0) return '说话人 ?'
  return state.speakerNames[id] ?? `说话人 ${id}`
}

function initSpeakers() {
  const saved = localStorage.getItem('localvoice.speakers')
  state.speakers = saved !== 'off'
  try {
    state.speakerNames = JSON.parse(localStorage.getItem('localvoice.speakerNames') ?? '{}')
  } catch {
    state.speakerNames = {}
  }
  const paint = () => {
    el.speakers.dataset.pace = state.speakers ? 'fast' : ''
    el.speakers.textContent = state.speakers ? '说话人' : '单人'
    el.speakers.dataset.tip = state.speakers
      ? '区分说话人已开启（点击关闭，右键清除记录）'
      : '已关闭（点击开启）'
  }
  paint()
  el.speakers.addEventListener('contextmenu', async (event) => {
    event.preventDefault()
    const choice = await api.speakerMenu({ current: -999, ids: [] })
    if (choice === 'reorganize') void reorganizeSpeakers()
    else if (String(choice).startsWith('k:')) void reorganizeSpeakers(Number(String(choice).slice(2)))
    else if (choice === 'clear') clearSpeakerRecords()
  })
  el.speakers.addEventListener('click', () => {
    state.speakers = !state.speakers
    localStorage.setItem('localvoice.speakers', state.speakers ? 'on' : 'off')
    paint()
    if (!state.speakers) {
      void api.resetSpeakers()
      for (const line of state.lines) delete line.speaker
      rebuildTranscript()
      render()
    }
  })
}

/**
 * 清除全部说话人记录：聚类编号、自定义名字、以及行上的标注。
 * 换场景（新的一场会议/新的人）时用，避免新的人被塞进旧编号。
 */
function clearSpeakerRecords(keepLabels = false) {
  void api.resetSpeakers()
  state.speakerNames = {}
  localStorage.removeItem('localvoice.speakerNames')
  if (!keepLabels) {
    for (const line of state.lines) delete line.speaker
    if (state.lines.length > 0) rebuildTranscript()
  }
  state.notice = '说话人记录已清除，下一个人会从「说话人 1」重新开始编'
  render()
}

/** 重新渲染整个转写区（改名后需要重画）。 */
function rebuildTranscript() {
  el.transcript.innerHTML = ''
  if (state.lines.length === 0) {
    showEmptyState()
    return
  }
  for (const line of state.lines) pushLine(line.text, line.ts, line.speaker, line.id)
}

/** 把某个编号的行全部改判成另一个编号。 */
function reassignSpeaker(from, to) {
  let touched = 0
  for (const line of state.lines) {
    if (line.speaker?.id !== from) continue
    line.speaker = { ...line.speaker, id: to }
    touched += 1
  }
  rebuildTranscript()
  render()
  if (touched > 0) state.notice = `已把 ${speakerLabel(from)} 的 ${touched} 句改判为 ${speakerLabel(to)}`
  render()
}

/**
 * 重新整理说话人：整场录音的窗口一起聚类。
 * 这是比逐句判定可靠得多的方式，尤其在两个人对话时。
 */
async function reorganizeSpeakers(k) {
  const { mapping, k: got, windows } = await api.reclusterSpeakers(k)
  if (windows === 0) {
    state.notice = '还没有可整理的说话人数据'
    render()
    return
  }
  let touched = 0
  for (const line of state.lines) {
    const token = line.speaker?.token
    if (token === undefined || mapping[token] === undefined) continue
    line.speaker = { ...line.speaker, id: mapping[token], mixed: false }
    touched += 1
  }
  rebuildTranscript()
  state.notice = `已整理 ${touched} 句（${windows} 个窗口 → ${got} 个说话人）`
  render()
}

/** 应用引擎报告的合并（说话人 2 并入 1）。 */
function applyMerges(merges) {
  if (!Array.isArray(merges) || merges.length === 0) return
  for (const { from, into } of merges) reassignSpeaker(from, into)
}

/** 右键说话人标签 → 改判 / 改名。 */
async function speakerMenu(chip, id) {
  const ids = [...new Set(state.lines.map((line) => line.speaker?.id).filter(Boolean))]
  const choice = await api.speakerMenu({ current: id, ids: ids.length > 0 ? ids : [id] })
  if (choice === 'rename') editSpeakerName(chip, id)
  else if (choice !== undefined) reassignSpeaker(id, Number(choice))
}

/** 点说话人标签 → 变成输入框，改名后所有同编号的行一起更新。 */
function editSpeakerName(node, id) {
  const input = document.createElement('input')
  input.value = state.speakerNames[id] ?? `说话人 ${id}`
  input.maxLength = 12
  node.replaceWith(input)
  input.focus()
  input.select()
  const commit = () => {
    const name = input.value.trim()
    if (name !== '') {
      state.speakerNames[id] = name
      localStorage.setItem('localvoice.speakerNames', JSON.stringify(state.speakerNames))
    }
    rebuildTranscript()
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur()
    if (event.key === 'Escape') {
      input.value = state.speakerNames[id] ?? `说话人 ${id}`
      input.blur()
    }
  })
}

// ------------------------------------------------------------------ 切句节奏

/**
 * 三档切句策略。推理快的机器可以选"灵敏"（更实时），
 * 想要整句完整就选"保守"（切得更少）。
 */
const PACES = {
  fast: { label: '灵敏', silenceMs: 620, midCutAfterMs: 2000, midSilenceMs: 180, maxChunkMs: 6000 },
  balanced: { label: '标准', silenceMs: 900, midCutAfterMs: 4000, midSilenceMs: 300, maxChunkMs: 12000 },
  relaxed: { label: '保守', silenceMs: 1100, midCutAfterMs: 6000, midSilenceMs: 400, maxChunkMs: 18000 },
}

function applyPace(name) {
  const pace = PACES[name] ?? PACES.balanced
  state.pace = PACES[name] ? name : 'balanced'
  LIVE.silenceMs = pace.silenceMs
  LIVE.midCutAfterMs = pace.midCutAfterMs
  LIVE.midSilenceMs = pace.midSilenceMs
  LIVE.maxChunkMs = pace.maxChunkMs
  if (el.pace) {
    el.pace.textContent = pace.label
    el.pace.dataset.pace = state.pace
    el.pace.dataset.tip = `切句节奏：${pace.label}（点击切换）`
  }
  localStorage.setItem('localvoice.pace', state.pace)
}

function initPace() {
  const saved = localStorage.getItem('localvoice.pace')
  state.paceChosen = saved !== null
  applyPace(saved ?? 'balanced')
  el.pace.addEventListener('click', () => {
    const order = ['fast', 'balanced', 'relaxed']
    const next = order[(order.indexOf(state.pace) + 1) % order.length]
    state.paceChosen = true
    applyPace(next)
  })
}

// ------------------------------------------------------------------ 主题

const THEME_KEY = 'localvoice.theme'

/** 应用主题：设置 color-scheme 让 light-dark() 选色，同时给样式切换图标。 */
function applyTheme(theme) {
  document.documentElement.style.colorScheme = theme
  document.documentElement.dataset.theme = theme
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(saved ?? system)

  el.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
  })
}

/** 顶栏波形：把最近的电平画成滚动竖条，让"在收音"这件事一眼可见。 */
const WAVE_BARS = 10
const waveLevels = []

function initWave() {
  if (!el.wave) return
  el.wave.innerHTML = ''
  for (let index = 0; index < WAVE_BARS; index += 1) {
    el.wave.append(document.createElement('i'))
  }
}

function renderWave(recording) {
  if (!el.wave) return
  const bars = el.wave.children
  el.wave.classList.toggle('live', recording)
  for (let index = 0; index < bars.length; index += 1) {
    const value = waveLevels[index] ?? 0
    // 开方压缩：安静时的细小起伏也能看出来，但不会满格乱跳
    // 分母小一点 → 动态范围更宽，安静和大声的差别一眼可见
    const height = 2 + Math.min(12, Math.sqrt(Math.max(0, value) / 0.02) * 12)
    bars[index].style.height = `${height.toFixed(1)}px`
  }
}

function pushWaveLevel(level) {
  waveLevels.push(level)
  while (waveLevels.length > WAVE_BARS) waveLevels.shift()
}

// ------------------------------------------------------------------ 录音

async function openMicrophone(onChunk, onPartial, onError) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const AudioCtor = window.AudioContext ?? window.webkitAudioContext
  // 不要强求 16000：部分 Windows 声卡不支持任意采样率，上下文会一直 suspended，
  // onaudioprocess 永远不触发（表现为权限正常但电平恒为 0）。
  // 用设备原生采样率，后面的 resampleTo16k 会转成 16k。
  const audio = new AudioCtor()
  // 有些平台（尤其 Windows）创建后是 suspended，不 resume 就永远收不到帧，
  // 表现就是阈值一直停在"校准中"。
  if (audio.state !== 'running') {
    try {
      await audio.resume()
    } catch {
      /* 下面用看门狗兜底 */
    }
  }
  const source = audio.createMediaStreamSource(stream)
  const processor = audio.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  processor.connect(audio.destination)

  // 看门狗：6 秒内一帧都没收到才算异常。3 秒太激进——蓝牙耳机、刚插上的
  // USB 麦克风、系统切设备时都可能在 3 秒后才开始出数据，会误报。
  let framesSeen = 0
  /** 看门狗报过警；等音频恢复时用它来决定是否清提示 */
  let stallReported = false
  const watchdog = setInterval(() => {
    if (framesSeen > 0) {
      clearInterval(watchdog)
      return
    }
    if (audio.state === 'running') return // 上下文在跑，再给一点时间
    clearInterval(watchdog)
    stallReported = true
    onError?.(new Error('音频上下文没有启动，没收到麦克风数据'))
  }, 6000)

  /** 最近若干帧的环形缓冲，只在"没在说话"时维护 */
  const preroll = []
  const prerollMax = Math.max(1, Math.ceil(LIVE.prerollMs / 256))

  const vad = {
    threshold: null,
    lastPartialAt: 0,
    /** 强制切分后的冷却截止时间：这期间触发不带回卷，否则会把切开的尾巴重复识别 */
    prerollMuteUntil: 0,
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
    pushWaveLevel(level)

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
      // 刚被强制切过：不要回卷，否则上一段的尾巴会被重新识别一遍
      const carry = Date.now() >= vad.prerollMuteUntil ? [...preroll] : []
      vad.frames = [...carry, block]
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

    const longEnough = vad.voicedMs >= LIVE.minSpeechMs
    // 边说边出：不影响正式切句，只是先把"当前听到的"显示出来
    const now = Date.now()
    if (
      onPartial !== undefined &&
      vad.chunkMs >= LIVE.partialMinMs &&
      now - vad.lastPartialAt >= state.partialEveryMs
    ) {
      vad.lastPartialAt = now
      const windowFrames = Math.min(
        vad.frames.length,
        Math.max(1, Math.floor(LIVE.partialWindowMs / 256)),
      )
      onPartial(concatFrames(vad.frames.slice(-windowFrames)))
    }

    if (vad.silenceMs >= LIVE.silenceMs && longEnough) {
      flush()
    } else if (vad.chunkMs >= LIVE.midCutAfterMs && vad.silenceMs >= LIVE.midSilenceMs && longEnough) {
      // 话说得太长：趁一个换气的短停顿切，别切在词组中间
      vad.prerollMuteUntil = Date.now() + 600
      flush()
    } else if (vad.chunkMs >= LIVE.maxChunkMs) {
      vad.prerollMuteUntil = Date.now() + 600
      flush()
    }
  }

  const track = stream.getAudioTracks()[0]
  return {
    label: track?.label || '默认输入设备',
    sampleRate: audio.sampleRate,
    state: audio.state,
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

/** 当前正在说话时的临时行（灰色，定稿后会被替换）。 */
let partialNode

function clearPartial() {
  partialNode?.remove()
  partialNode = undefined
}

function showPartial(text) {
  if (!text) return
  const placeholder = el.transcript.querySelector('.placeholder')
  if (placeholder) placeholder.remove()
  if (partialNode === undefined) {
    partialNode = document.createElement('div')
    partialNode.className = 'line partial'
    const time = document.createElement('time')
    time.textContent = clock(new Date())
    const body = document.createElement('span')
    partialNode.append(time, body)
    el.transcript.append(partialNode)
  }
  partialNode.querySelector('span').textContent = text
  el.transcript.scrollTop = el.transcript.scrollHeight
}

/** 临时结果的请求：跑得慢就跳过这一轮，绝不拖累定稿。 */
let partialBusy = false

function transcribePartial(samples) {
  if (partialBusy) return
  partialBusy = true
  api
    .transcribe(toBase64(encodeWav(samples, LIVE.sampleRate)), 'auto', true)
    .then((result) => showPartial((result.text ?? '').trim()))
    .catch(() => {})
    .finally(() => {
      partialBusy = false
    })
}

/** 推理跟不上时先把音频攒起来，等队列消化后再一起送，避免无限排队 */
let backlogAudio = []

function transcribe(samples) {
  // 几乎静音的片段不值得送识别：既浪费算力，又会诱出退化输出
  let peak = 0
  for (let i = 0; i < samples.length; i += 16) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  if (peak < Math.max(0.004, state.threshold * 0.8)) return

  if (state.pending >= 2) {
    backlogAudio.push(samples)
    return
  }
  if (backlogAudio.length > 0) {
    samples = concatFrames([...backlogAudio, samples])
    backlogAudio = []
  }

  state.pending += 1
  render()
  state.queue = state.queue
    .then(async () => {
      const wav = encodeWav(samples, LIVE.sampleRate)
      const result = await api.transcribe(toBase64(wav), 'auto', false, state.speakers)
      // 按最近几次推理的平均耗时调整临时稿频率。
      // 注意必须双向：之前写成了单向降频，一次预热就能把间隔永久锁在 5 秒。
      const costMs = Math.round((result.inferenceSeconds ?? 0) * 1000)
      // 第一次用的人不该被迫理解"切句节奏"：按实测速度替他选一档
      if (!state.paceChosen && costMs > 0 && state.inferenceSamples.length >= 3) {
        const avg = state.inferenceSamples.reduce((a, b) => a + b, 0) / state.inferenceSamples.length
        if (avg < 800) applyPace('fast')
        else if (avg > 2000) applyPace('relaxed')
        state.paceChosen = true
      }
      state.lastInferenceMs = costMs
      if (costMs > 0) {
        state.inferenceSamples ??= []
        state.inferenceSamples.push(costMs)
        if (state.inferenceSamples.length > 4) state.inferenceSamples.shift()
        const average =
          state.inferenceSamples.reduce((sum, value) => sum + value, 0) /
          state.inferenceSamples.length
        state.partialEveryMs = Math.min(
          LIVE.partialEverySlowMs,
          Math.max(LIVE.partialEveryMs, Math.round(average * 1.5)),
        )
      }
      const text = (result.text ?? '').trim()
      clearPartial()
      if (text) {
        appendLine(text, result.audioSeconds, result.speaker)
        if (result.speaker?.merges !== undefined) applyMerges(result.speaker.merges)
      }
    })
    .catch((error) => {
      const text = String(error?.message ?? error)
      // 内存不足导致的加载失败要明确告诉用户怎么处理
      if (text.includes('1455') || text.includes('页面文件')) {
        appendMessage(
          '内存不足：Windows 的分页文件太小，模型加载失败。\n' +
            '请在「系统属性 → 高级 → 性能设置 → 高级 → 虚拟内存」把分页文件调到 8GB 以上，然后重新打开应用。',
        )
        return
      }
      // 引擎重启/切换模型时在途请求会被拒，这属于正常流程，不该刷红字
      if (text.includes('引擎已停止') || text.includes('引擎已退出') || text.includes('引擎不可用')) {
        state.notice = '引擎已重启，继续说话即可'
        render()
        return
      }
      appendMessage(`识别失败：${text}`)
    })
    .finally(() => {
      state.pending -= 1
      // 队列腾出位置后，把攒下的音频合并成一段再送
      if (backlogAudio.length > 0 && state.pending < 2) {
        const merged = concatFrames(backlogAudio)
        backlogAudio = []
        transcribe(merged)
      }
      render()
    })
}

/**
 * 明显"话没说完"的句尾。命中就把下一段接上——用来兜住"切早了"的残留。
 * 比 DSH 插件版多收了 在/因/而/使/让/从/向/将 这些单字介词，
 * 它们在中文里几乎不会结束一句话。
 */
const FRAGMENT_TAIL = /(以及|或者|还是|就是|不会|不能|不是|而且|并且|但是|因为|所以|如果|虽然|在|因|而|使|让|从|向|将|由|把|被|对|给|和|跟|与)$/u
const LEADING_FILLER = /^[呃嗯啊唉额哦噢呀哈]+[，,、。.\s]*/u

/**
 * 判断两段是不是同一句被切断的。
 * @returns 拼好的文本；不该合并时返回 undefined。
 */
function mergeFragment(previous, next) {
  const tail = previous.replace(/[。．.！!？?，,；;：:\s]+$/u, '')
  if (!FRAGMENT_TAIL.test(tail)) return undefined
  const head = next.replace(LEADING_FILLER, '').trim()
  if (!head) return undefined
  return `${tail}${head}`
}

/** 去掉句首的语气词：「嗯，现在是。」→「现在是。」 */
function trimLeadingFiller(text) {
  const stripped = text.replace(/^[嗯啊呃哦噢呀哈额]+[，,、。\s]*/u, '').trim()
  return stripped.length > 0 ? stripped : text
}

/**
 * 把一段转写按句号/问号/感叹号拆成多行。
 *
 * 连续说话（视频、讲座、开会）时 VAD 等不到长静音，一个音频块可能有 20 秒、
 * 好几句话。模型自己的标点就是现成的句子边界，用它拆行比在音频上硬切更准。
 */
function splitSentences(text) {
  const parts = text.split(/(?<=[。！？!?])/u).map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 ? parts : [text]
}

/**
 * 上屏。audioSeconds 是这段音频的长度，用来把时间戳按字数分摊到每句上，
 * 否则一段拆出来的几行会显示同一个时间，看起来像批量输出。
 */
function appendLine(text, audioSeconds, speaker) {
  text = trimLeadingFiller(text)
  const sentences = splitSentences(text)
  if (sentences.length === 0) return

  // 先拿第一句去和上一行尝试接力，避免"…九点半睡。" + "睡觉。" 这种断裂
  const head = sentences[0]
  const last = state.lines[state.lines.length - 1]
  if (last !== undefined) {
    const merged = mergeFragment(last.text, head)
    if (merged !== undefined) {
      last.text = merged
      const body = el.transcript.querySelector(`[data-id="${last.id}"] span`)
      if (body) body.textContent = merged
      sentences.shift()
      render()
    }
  }

  const totalChars = sentences.reduce((sum, item) => sum + item.length, 0) || 1
  const endAt = Date.now()
  const spanMs = Math.max(0, (audioSeconds ?? 0) * 1000)
  const startAt = endAt - spanMs
  let consumed = 0
  for (const sentence of sentences) {
    consumed += sentence.length / totalChars
    const at = new Date(startAt + spanMs * consumed)
    pushLine(sentence, clock(at), speaker)
  }
  render()
}

/** 真正往界面里加一行。 */
function pushLine(text, ts, speaker, existingId) {
  let line
  if (existingId === undefined) {
    line = { id: `${Date.now()}-${Math.random()}`, ts: ts ?? clock(new Date()), text, speaker }
    state.lines.push(line)
  } else {
    // 重画已有行（改名后需要），沿用原来的 id / 时间 / 说话人
    line = state.lines.find((item) => item.id === existingId)
    if (line === undefined) return
    line.text = text
  }

  const placeholder = el.transcript.querySelector('.placeholder')
  if (placeholder) placeholder.remove()

  const node = document.createElement('div')
  node.className = 'line'
  node.dataset.id = line.id

  const time = document.createElement('time')
  time.textContent = line.ts

  const body = document.createElement('span')
  const speakerId = line.speaker?.id
  if (speakerId !== undefined) {
    const chip = document.createElement('span')
    chip.className = 'speaker'
    const dot = document.createElement('i')
    dot.style.background = SPEAKER_COLORS[(Math.abs(speakerId) - 1) % SPEAKER_COLORS.length]
    const mixed = line.speaker.mixed === true
    chip.append(
      dot,
      document.createTextNode(`${speakerLabel(speakerId)}${mixed ? ' · 混说' : ''}`),
    )
    if (mixed) chip.style.color = 'var(--fg-3)'
    const similarity =
      line.speaker.similarity === undefined ? '' : ` · 相似度 ${line.speaker.similarity}`
    chip.title = mixed
      ? `${speakerLabel(speakerId)}：这段里有两个以上的人在说（${line.speaker.windows ?? '?'} 个窗口）`
      : `${speakerLabel(speakerId)}${similarity}`
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      if (speakerId < 0) {
        state.notice = '这个说话人还在确认中，等它再说一句就会定下来'
        render()
        return
      }
      editSpeakerName(chip, speakerId)
    })
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void speakerMenu(chip, speakerId)
    })
    chip.title += '（右键改判/改名）'
    body.append(chip)
  }
  body.append(document.createTextNode(line.text))

  node.append(time, body)
  el.transcript.append(node)
  el.transcript.scrollTop = el.transcript.scrollHeight
  render()
}

function appendMessage(text) {
  const node = document.createElement('div')
  node.className = 'line error'
  const body = document.createElement('span')
  body.textContent = text
  node.append(body)
  el.transcript.append(node)
  el.transcript.scrollTop = el.transcript.scrollHeight
}

// ------------------------------------------------------------------ 会话

async function start() {
  state.notice = ''
  const modelId = state.modelId
  if (!modelId) {
    // 探测还没跑完时模型列表是空的，点了也不能开工
    state.notice = '正在读取模型列表，请稍候再点'
    render()
    return
  }
  // 上一段录音已经结束（不是暂停续录）→ 说话人编号从 1 重新开始，
  // 否则新的人会被硬塞进上一场留下的编号里
  if (!state.sessionActive) {
    void api.resetSpeakers()
    state.speakerNames = {}
    localStorage.removeItem('localvoice.speakerNames')
    state.sessionActive = true
    state.autoOrganized = false
    state.autoOrganizeAttempts = 0
  }
  el.state.textContent = '引擎加载中…'
  render()
  try {
    const info = await api.start(modelId)
    el.state.textContent = `引擎就绪（${info.loadMs}ms）`
    state.session = await openMicrophone(
      (samples) => transcribe(samples),
      (samples) => transcribePartial(samples),
      (error) => {
        if (error === null) {
          // 音频恢复了：无条件清掉提示（之前要求必须是 recording 态，
          // 启动瞬间的误报会一直挂在底部）
          if (state.notice.startsWith('麦克风不可用')) {
            state.notice = ''
            render()
          }
          return
        }
        state.notice = `麦克风不可用：${error.message}`
        if (state.phase !== 'recording') render()
      },
    )
    state.audioInfo = `${state.session.label} · ${state.session.sampleRate}Hz`
    state.phase = 'recording'
    state.startedAt = Date.now()
    state.timer = setInterval(render, 500)
    render()
  } catch (error) {
    state.notice = `启动失败：${error.message ?? error}`
    state.phase = state.lines.length > 0 ? 'paused' : 'idle'
    render()
  }
}

function pause() {
  // 暂停后继续仍算同一段会话，说话人编号保持不变
  clearPartial()
  if (state.notice.startsWith('麦克风不可用')) state.notice = ''
  state.session?.stop()
  state.session = undefined
  state.accumulated += Date.now() - state.startedAt
  clearInterval(state.timer)
  state.timer = undefined
  state.phase = state.lines.length > 0 ? 'paused' : 'idle'
  render()
  // 停下来之后自动按全局聚类整理一次，比逐句判定的结果干净得多
  if (state.speakers && state.lines.length >= 4 && !state.autoOrganized) {
    state.autoOrganized = true
    void reorganizeSpeakers()
  }
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
  clearPartial()
  void api.resetSpeakers()
  state.speakerNames = {}
  localStorage.removeItem('localvoice.speakerNames')
  state.sessionActive = false
  state.lines = []
  state.accumulated = 0
  state.peak = 0
  state.threshold = 0
  state.phase = 'idle'
  showEmptyState()
  render()
}

// ------------------------------------------------------------------ 渲染

function render() {
  const recording = state.phase === 'recording'
  // 不能写 textContent：按钮里是 SVG，写文字会把图标整个抹掉。
  // 图形切换交给 .live 类，状态用 aria-label 和 title 表达。
  el.toggle.classList.toggle('live', recording)
  el.toggle.title = recording ? '暂停（保留内容）' : '开始 / 继续'
  el.toggle.setAttribute('aria-label', recording ? '暂停录音' : '开始录音')

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
  const notice = state.notice !== '' ? ` · ${state.notice}` : ''
  el.diag.textContent =
    `电平 ${state.level.toFixed(4)} · 峰值 ${state.peak.toFixed(4)} · ` +
    `阈值 ${state.threshold > 0 ? state.threshold.toFixed(4) : '校准中'}` +
    (state.audioInfo ? ` · ${state.audioInfo}` : '') +
    (state.lastInferenceMs > 0 ? ` · 推理 ${state.lastInferenceMs}ms` : '') +
    notice
  el.diag.classList.toggle('warn', notice !== '')

  if (el.levelFill) {
    const scale = (value) => Math.min(100, Math.sqrt(Math.max(0, value) / 0.06) * 100)
    el.levelFill.style.width = `${scale(state.level)}%`
  }
  renderWave(recording)

  for (const button of [el.copy, el.save, el.clear]) button.disabled = state.lines.length === 0

  // 菜单栏显示录音状态与时长
  const elapsed =
    state.phase === 'recording'
      ? state.accumulated + (Date.now() - state.startedAt)
      : state.accumulated
  api.reportStatus({ phase: state.phase, elapsedMs: elapsed, chars })
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

let installingEnv = false

// 引擎提示（例如"有显卡但 torch 是 CPU 版"）直接显示在底部
api.onEngineLog?.((line) => {
  if (line.includes('检测到 NVIDIA')) {
    state.notice = '检测到显卡但 torch 是 CPU 版，装 CUDA 版可快 10 倍（见日志）'
    render()
  }
})

api.onEnvLog((line) => {
  el.envLog.classList.remove('hidden')
  el.envLog.textContent += `${line}\n`
  el.envLog.scrollTop = el.envLog.scrollHeight
})

let installingCuda = false

api.onCudaProgress((progress) => {
  const pct = progress.totalBytes > 0 ? (progress.doneBytes / progress.totalBytes) * 100 : 0
  el.gpuBar.classList.remove('hidden')
  el.gpuFill.style.width = `${pct.toFixed(1)}%`
  const speed = progress.speed ? ` · ${human(progress.speed)}/s` : ''
  el.gpuHint.textContent = `${human(progress.doneBytes)} / ${human(progress.totalBytes)} · ${pct.toFixed(0)}%${speed}`
})

async function checkCuda() {
  try {
    const info = await api.cudaStatus()
    // 只有真的装了显卡、但 torch 不是 CUDA 版时才提示
    // 探针能认出 N 卡但 nvidia-smi 不存在 → 驱动没装
    const vendor = state.probe?.gpuVendor
    if (vendor === 'nvidia' && info.hasNvidia !== true) {
      el.gpuBanner.classList.remove('hidden')
      el.gpuTitle.textContent = `检测到 ${state.probe.gpuName ?? 'NVIDIA 显卡'}，但显卡驱动没装`
      el.gpuHint.textContent = '先到 nvidia.cn 装对应驱动并重启，之后就能启用 GPU 加速'
      el.gpuInstall.textContent = '打开驱动下载页'
      el.gpuInstall.disabled = false
      el.gpuInstall.dataset.action = 'driver'
      return
    }
    if (info.hasNvidia === true && info.available !== true) {
      el.gpuBanner.classList.remove('hidden')
      el.gpuTitle.textContent = `检测到 ${info.name ?? 'NVIDIA 显卡'}，但正在用 CPU 推理`
      el.gpuHint.textContent = `装 CUDA 版 torch 可快 10 倍以上（约 2.5 GB，按驱动 CUDA ${info.driverCuda ?? '?'} 选择）`
      el.gpuInstall.disabled = false
      el.gpuInstall.dataset.action = 'cuda'
    } else {
      el.gpuBanner.classList.add('hidden')
    }
  } catch {
    /* 检测失败就当没有显卡，不打扰 */
  }
}

async function installCuda() {
  if (installingCuda) return
  installingCuda = true
  el.gpuInstall.disabled = true
  el.gpuInstall.textContent = '安装中…'
  el.gpuBar.classList.remove('hidden')
  try {
    const result = await api.installCuda()
    el.gpuFill.style.width = '100%'
    el.gpuTitle.textContent = result.verified ? 'GPU 加速已启用，请重启应用生效' : '安装完成但 CUDA 不可用'
    el.gpuHint.textContent = result.verified
      ? '重启 LocalVoice 后会自动使用显卡'
      : '驱动可能太旧，运行 nvidia-smi 查看支持的 CUDA 版本'
    el.gpuInstall.textContent = result.verified ? '已启用' : '重试'
  } catch (error) {
    el.gpuHint.textContent = `安装失败：${error.message ?? error}`
    el.gpuInstall.textContent = '重试'
    el.gpuInstall.disabled = false
  } finally {
    installingCuda = false
  }
}

async function installEnvironment() {
  if (installingEnv) return
  installingEnv = true
  el.installEnv.disabled = true
  el.installEnv.textContent = '安装中…'
  el.envLog.classList.remove('hidden')
  el.envLog.textContent = ''
  try {
    await api.installEnv()
    el.envLog.textContent += '\n✓ 环境就绪\n'
    await init()
    el.state.textContent = '环境已就绪'
  } catch (error) {
    el.envLog.textContent += `\n× 失败：${error.message ?? error}\n`
    el.installEnv.textContent = '重试安装'
  } finally {
    installingEnv = false
    el.installEnv.disabled = false
    if (el.installEnv.textContent === '安装中…') el.installEnv.textContent = '安装环境'
  }
}

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
  initPace()
  initSpeakers()
  initTheme()
  initWave()
  if (el.toggle) {
    el.toggle.disabled = true
    el.toggle.title = '正在读取模型列表…'
  }
  if (state.lines.length === 0) showEmptyState()
  void checkCuda()
  state.probe = await api.probe()
  document.body.classList.add(`platform-${state.probe.platform}`)
  const { options, recommended, installed, backend, totalRamGb, gpuName } = state.probe
  // 选定模型：优先推荐项，否则第一个
  const chosen = options.find((m) => m.id === recommended) ?? options[0]
  state.modelId = chosen?.id ?? ''
  if (state.modelId !== '') el.model.value = state.modelId

  el.model.innerHTML = ''
  for (const model of options) {
    const option = document.createElement('option')
    option.value = model.id
    const installedMark = installed.includes(model.id) ? '✓ ' : ''
    option.textContent = `${installedMark}${model.label}（${model.sizeGb} GB）`
    if (model.id === recommended) option.selected = true
    el.model.append(option)
  }

  const env = state.probe.environment
  const envMissing = env !== undefined && env.ready === false
  // 两个后端的依赖体积差很多，别让 Windows 用户以为只下 300MB
  el.envSize.textContent =
    state.probe.backend === 'torch'
      ? 'Python + torch，约 900 MB'
      : 'Python + mlx-audio，约 300 MB'
  if (env?.venv) el.envPath.textContent = env.venv
  el.envBlock.classList.toggle('hidden', !envMissing)

  if (el.toggle) {
    el.toggle.disabled = options.length === 0
    el.toggle.title = options.length > 0 ? '开始 / 暂停' : '没有可用模型'
  }

  const missing = options.length > 0 && !installed.includes(state.modelId)
  // 环境没准备好时也要把面板露出来，否则用户看不到"安装环境"
  el.setup.classList.toggle('hidden', !(missing || envMissing))
  if (envMissing) {
    el.recommend.textContent = ''
  }
  if (missing && !envMissing) {
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
/** 把当前转写存成 markdown。返回是否真的写盘了（用户可能取消）。 */
async function saveTranscript() {
  const header = `# 实时转写 ${new Date().toLocaleString('zh-CN')}\n\n- 模型：${el.model.selectedOptions[0]?.textContent ?? ''}\n\n`
  const body = state.lines
    .map((line) => {
      const who = line.speaker === undefined ? '' : `${speakerLabel(line.speaker.id)}：`
      return `[${line.ts}] ${who}${line.text}`
    })
    .join('\n')
  const result = await api.saveMarkdown(`${header}${body}\n`, `localvoice-${fileStamp()}.md`)
  if (result.saved) {
    state.notice = `已保存 ${result.filePath}`
    render()
  }
  return result.saved === true
}

el.save.addEventListener('click', () => void saveTranscript())

// 主进程问完"要保存吗"之后，走这里：存成功才关窗
api.onCommand(async (command) => {
  if (command === 'command:save-then-close') {
    const saved = await saveTranscript()
    if (saved) api.closeNow()
  }
})
el.copyCmd.addEventListener('click', () => {
  void api.copy(el.cmd.textContent)
  el.copyCmd.textContent = '已复制'
  setTimeout(() => (el.copyCmd.textContent = '复制下载命令'), 1500)
})
el.openModels.addEventListener('click', () => void api.openModelsFolder())
el.download.addEventListener('click', () => void startDownload())
el.installEnv.addEventListener('click', () => void installEnvironment())
el.gpuInstall.addEventListener('click', () => {
  if (el.gpuInstall.dataset.action === 'driver') {
    void api.openExternal('https://www.nvidia.cn/Download/index.aspx')
    return
  }
  void installCuda()
})
el.model.addEventListener('change', async () => {
  state.modelId = el.model.value
  // 切换模型会重建引擎；如果正在录音，先把会话停干净再切，免得在途请求被拒
  if (state.phase === 'recording') {
    pause()
    state.notice = '已切换模型，点 ▶ 继续'
    render()
  }
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

api.onCommand((command) => {
  if (command === 'command:toggle') toggle()
})

init().catch((error) => {
  el.state.textContent = `初始化失败：${error.message ?? error}`
})
