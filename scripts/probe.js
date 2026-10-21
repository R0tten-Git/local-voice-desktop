/**
 * 硬件探测与模型推荐。
 *
 * 应用启动时跑一次，决定"这台机器能跑哪个模型"。探测项刻意保持保守：
 * 拿不到的信息一律当作"不知道"，而不是猜一个乐观值。
 *
 * 推荐阈值来自实测（scripts/bench_models.py，12 句 / 261 字）：
 *   1.7B-8bit  738ms/句  2521MB  100.00%
 *   1.7B-4bit  548ms/句  1701MB   99.62%
 *   0.6B-4bit  240ms/句   845MB   98.47%
 */
const os = require('node:os')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)

/** 候选模型台账：体积是 download 大小，rss 是实测峰值内存。 */
const MODELS = [
  {
    id: 'qwen3-asr-1.7b-8bit',
    repo: 'mlx-community/Qwen3-ASR-1.7B-8bit',
    label: 'Qwen3-ASR 1.7B · 8bit',
    sizeGb: 2.47,
    rssGb: 2.52,
    accuracy: 100.0,
    latencyMs: 738,
    backends: ['mlx'],
    tier: 'max',
    note: '最准（实测 100%），代价是慢 26%、多占 800MB',
  },
  {
    id: 'qwen3-asr-1.7b-4bit',
    repo: 'mlx-community/Qwen3-ASR-1.7B-4bit',
    label: 'Qwen3-ASR 1.7B · 4bit',
    sizeGb: 1.61,
    rssGb: 1.70,
    accuracy: 99.62,
    latencyMs: 548,
    backends: ['mlx'],
    tier: 'balanced',
    note: '推荐：几乎一样准（99.6%），快 26%，省 800MB',
  },
  {
    id: 'qwen3-asr-0.6b-4bit',
    repo: 'mlx-community/Qwen3-ASR-0.6B-4bit',
    label: 'Qwen3-ASR 0.6B · 4bit',
    sizeGb: 0.71,
    rssGb: 0.85,
    accuracy: 98.47,
    latencyMs: 240,
    backends: ['mlx'],
    tier: 'fallback',
    note: '小内存兜底；偶发整句听错',
  },
  {
    id: 'qwen3-asr-1.7b-gguf-q8',
    repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF',
    label: 'Qwen3-ASR 1.7B · GGUF Q8',
    sizeGb: 2.53,
    rssGb: 2.8,
    accuracy: 100.0,
    latencyMs: 700,
    backends: ['llama.cpp'],
    tier: 'balanced',
    note: 'Windows / Intel Mac：走 llama.cpp + CUDA 或 CPU',
  },
  {
    id: 'qwen3-asr-1.7b-hf',
    repo: 'Qwen/Qwen3-ASR-1.7B-hf',
    label: 'Qwen3-ASR 1.7B · HF 格式',
    sizeGb: 4.09,
    rssGb: 7.0,
    accuracy: 100.0,
    latencyMs: 2100,
    backends: ['torch'],
    tier: 'balanced',
    note: 'Windows / Intel Mac：有 NVIDIA 显卡才流畅（CPU 约 2 秒/句）',
  },
  {
    id: 'qwen3-asr-0.6b-hf',
    repo: 'Qwen/Qwen3-ASR-0.6B-hf',
    label: 'Qwen3-ASR 0.6B · HF 格式',
    sizeGb: 1.58,
    rssGb: 3.0,
    accuracy: 98.4,
    latencyMs: 700,
    backends: ['torch'],
    tier: 'fallback',
    note: '没有独立显卡时用这个，内存占用小一半',
  },
  {
    id: 'qwen3-asr-0.6b-gguf-q8',
    repo: 'unslothai/Qwen3-ASR-0.6B-GGUF',
    label: 'Qwen3-ASR 0.6B · GGUF Q8',
    sizeGb: 1.01,
    rssGb: 1.1,
    accuracy: 98.4,
    latencyMs: 300,
    backends: ['llama.cpp'],
    tier: 'fallback',
    note: 'Windows 无独显时的兜底',
  },
]

/** 读取 macOS 的芯片与显存信息。 */
async function probeMac() {
  try {
    const { stdout } = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 8000 })
    const parsed = JSON.parse(stdout)
    const items = parsed.SPDisplaysDataType ?? []
    const chip = items[0]?.sppci_model ?? ''
    return { gpuName: chip, gpuVendor: /apple/i.test(chip) ? 'apple' : undefined, unified: true }
  } catch {
    return {}
  }
}

/** 读取 Windows 的显卡名称（有 N 卡就看显存）。 */
async function probeWindows() {
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
      { timeout: 10000 },
    )
    const names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const nvidia = names.find((n) => /nvidia/i.test(n))
    return {
      gpuName: nvidia ?? names[0] ?? '',
      gpuVendor: nvidia ? 'nvidia' : names.some((n) => /amd|radeon/i.test(n)) ? 'amd' : 'other',
    }
  } catch {
    return {}
  }
}

/** 查询 NVIDIA 显存（MB）。拿不到返回 undefined。 */
async function probeNvidiaVram() {
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 6000 },
    )
    const first = parseInt(stdout.trim().split(/\r?\n/)[0], 10)
    return Number.isFinite(first) ? first : undefined
  } catch {
    return undefined
  }
}

/** 可用磁盘（GB），以用户目录所在卷为准。 */
function freeDiskGb() {
  try {
    const stats = fs.statfsSync(os.homedir())
    return (stats.bavail * stats.bsize) / 1e9
  } catch {
    return undefined
  }
}

/**
 * 一次完整探测。
 * @returns {Promise<object>} 平台、内存、显卡、磁盘与推荐模型。
 */
async function probe() {
  const platform = process.platform
  const arch = process.arch
  const totalRamGb = os.totalmem() / 1e9
  const freeRamGb = os.freemem() / 1e9
  const diskGb = freeDiskGb()

  const gpu = platform === 'darwin' ? await probeMac() : platform === 'win32' ? await probeWindows() : {}
  const vram = gpu.gpuVendor === 'nvidia' ? await probeNvidiaVram() : undefined

  /**
   * Apple Silicon 用 MLX（最快、内存最省）；
   * 其他平台（Windows / Intel Mac / Linux）用 torch + transformers，
   * 官方 HF 权重在两个平台是同一套，质量一致。
   */
  const backend = platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'torch'

  const candidates = MODELS.filter((m) => m.backends.includes(backend))
  /** 内存要留一半给系统和应用本身，这是经验值。 */
  const usable = totalRamGb * 0.5
  const fits = candidates.filter((m) => m.rssGb <= usable && (diskGb === undefined || m.sizeGb + 2 < diskGb))

  // 不是"越准越好"：实测 1.7B-4bit 比 8bit 只差 0.38%，却快 26%、省 800MB。
  // 所以默认给 balanced（性价比档），max 档留给用户在界面上手动选。
  const byTier = (tier) => fits.filter((m) => m.tier === tier).sort((a, b) => b.accuracy - a.accuracy)[0]
  const recommended =
    byTier('balanced') ??
    byTier('fallback') ??
    candidates.sort((a, b) => a.rssGb - b.rssGb)[0]

  return {
    platform,
    arch,
    totalRamGb: Number(totalRamGb.toFixed(1)),
    freeRamGb: Number(freeRamGb.toFixed(1)),
    freeDiskGb: diskGb === undefined ? undefined : Number(diskGb.toFixed(1)),
    gpuName: gpu.gpuName ?? '',
    gpuVendor: gpu.gpuVendor ?? '',
    vramMb: vram,
    backend,
    usableRamGb: Number(usable.toFixed(1)),
    recommended: recommended.id,
    options: candidates.map((m) => ({ ...m, fits: fits.includes(m) })),
  }
}

module.exports = { probe, MODELS }

if (require.main === module) {
  probe().then((result) => {
    console.log(`平台      ${result.platform}/${result.arch}`)
    console.log(`内存      ${result.totalRamGb} GB（可用约 ${result.usableRamGb} GB）`)
    console.log(`显卡      ${result.gpuName || '未知'}${result.vramMb ? ` · ${result.vramMb} MB` : ''}`)
    console.log(`磁盘      ${result.freeDiskGb ?? '未知'} GB`)
    console.log(`推理后端  ${result.backend}`)
    console.log('')
    for (const model of result.options) {
      const mark = model.id === result.recommended
        ? '★ 推荐'
        : model.fits
          ? model.tier === 'max' ? '  可选(极致)' : '  可选'
          : '  内存不足'
      console.log(`${mark}  ${model.label.padEnd(26)} ${String(model.sizeGb).padStart(5)} GB  ${model.note}`)
    }
  })
}
