/**
 * 说话人分离：CAM++ 声纹模型 + 在线聚类。
 *
 * 模型要 80 维 Kaldi fbank 特征（不是原始波形），所以这里包含一套最小化的
 * 特征提取：预加重 → 25ms 分帧 → Hamming 窗 → 512 点 FFT → 80 组 Mel 滤波器
 * → 取对数。参数对齐 Kaldi 默认值，模型才能拿到它训练时见过的分布。
 */

const SAMPLE_RATE = 16000
const FRAME_LEN = 400 // 25ms
const FRAME_SHIFT = 160 // 10ms
const FFT_SIZE = 512
const NUM_BINS = 80
const LOW_FREQ = 20
const HIGH_FREQ = 8000
const PREEMPH = 0.97

/** 原地 radix-2 复数 FFT。 */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const hzToMel = (hz) => 1127 * Math.log(1 + hz / 700)
const melToHz = (mel) => 700 * (Math.exp(mel / 1127) - 1)

/** 构造 80 组三角 Mel 滤波器（Kaldi 风格：等 Mel 间隔）。 */
function melFilters() {
  const lowMel = hzToMel(LOW_FREQ)
  const highMel = hzToMel(HIGH_FREQ)
  const binHz = SAMPLE_RATE / FFT_SIZE
  const filters = []
  for (let b = 0; b < NUM_BINS; b += 1) {
    const left = lowMel + ((highMel - lowMel) * b) / (NUM_BINS + 1)
    const center = lowMel + ((highMel - lowMel) * (b + 1)) / (NUM_BINS + 1)
    const right = lowMel + ((highMel - lowMel) * (b + 2)) / (NUM_BINS + 1)
    const weights = []
    for (let k = 0; k <= FFT_SIZE / 2; k += 1) {
      const mel = hzToMel(k * binHz)
      let w = 0
      if (mel >= left && mel <= center) w = (mel - left) / (center - left)
      else if (mel > center && mel <= right) w = (right - mel) / (right - center)
      weights.push(w)
    }
    filters.push(Float32Array.from(weights))
  }
  return filters
}

const MEL = melFilters()
const WINDOW = Float32Array.from({ length: FRAME_LEN }, (_, i) =>
  0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)),
)

/**
 * 计算 fbank 特征。
 * @param {Float32Array} audio 16kHz 单声道 [-1,1]
 * @returns {{data: Float32Array, frames: number}} 展平的 [frames, 80]
 */
function fbank(audio) {
  // 预加重
  const pre = new Float32Array(audio.length)
  pre[0] = audio[0]
  for (let i = 1; i < audio.length; i += 1) pre[i] = audio[i] - PREEMPH * audio[i - 1]

  const frames = Math.max(1, Math.floor((audio.length - FRAME_LEN) / FRAME_SHIFT) + 1)
  const data = new Float32Array(frames * NUM_BINS)
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  const power = new Float32Array(FFT_SIZE / 2 + 1)

  for (let f = 0; f < frames; f += 1) {
    const start = f * FRAME_SHIFT
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = i < FRAME_LEN ? pre[start + i] * WINDOW[i] : 0
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k <= FFT_SIZE / 2; k += 1) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let b = 0; b < NUM_BINS; b += 1) {
      const w = MEL[b]
      let sum = 0
      for (let k = 0; k <= FFT_SIZE / 2; k += 1) sum += w[k] * power[k]
      data[f * NUM_BINS + b] = Math.log(Math.max(sum, 1e-10))
    }
  }
  return { data, frames }
}


/** 从 16k 单声道 PCM16 WAV 取出 Float32 采样。 */
function decodeWav(buf) {
  const rate = buf.readUInt32LE(24)
  if (rate !== SAMPLE_RATE) throw new Error(`WAV 采样率 ${rate}，需要 ${SAMPLE_RATE}`)
  const n = Math.floor((buf.length - 44) / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(44 + i * 2) / 32768
  return out
}

/**
 * 说话人跟踪：把每句话的声纹向量归到某个说话人上。
 *
 * 用"与现有说话人质心的最大余弦相似度"判定；超过阈值就归入，否则新建一个。
 * 两个质心过分相似时合并，避免同一个人的话被拆成两个编号。
 */
class SpeakerTracker {
  /**
   * @param {{threshold?: number, mergeThreshold?: number, maxSpeakers?: number}} options
   */
  constructor(options = {}) {
    this.threshold = options.threshold ?? 0.68
    this.mergeThreshold = options.mergeThreshold ?? 0.8
    this.maxSpeakers = options.maxSpeakers ?? 8
    /** @type {Array<{id: number, centroid: Float32Array, count: number}>} */
    this.speakers = []
    this.nextId = 1
  }

  static cosine(a, b) {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
  }

  /**
   * 归一化后的向量才能直接用点积当余弦。
   * @param {Float32Array} embedding
   */
  static normalize(embedding) {
    let norm = 0
    for (let i = 0; i < embedding.length; i += 1) norm += embedding[i] * embedding[i]
    norm = Math.sqrt(norm) || 1
    const out = new Float32Array(embedding.length)
    for (let i = 0; i < embedding.length; i += 1) out[i] = embedding[i] / norm
    return out
  }

  /**
   * @param {Float32Array} embedding 归一化后的声纹向量
   * @returns {{id: number, similarity: number, created: boolean}}
   */
  assign(embedding) {
    let best = undefined
    let bestScore = -1
    for (const speaker of this.speakers) {
      const score = SpeakerTracker.cosine(embedding, speaker.centroid)
      if (score > bestScore) {
        bestScore = score
        best = speaker
      }
    }

    if (best !== undefined && bestScore >= this.threshold) {
      // 滑动平均更新质心，让判定随说话内容逐渐稳定
      const count = best.count + 1
      for (let i = 0; i < best.centroid.length; i += 1) {
        best.centroid[i] = (best.centroid[i] * best.count + embedding[i]) / count
      }
      best.count = count
      return { id: best.id, similarity: bestScore, created: false }
    }

    if (this.speakers.length >= this.maxSpeakers) {
      // 满了就并入最像的那个，不再新增编号
      if (best !== undefined) {
        const count = best.count + 1
        for (let i = 0; i < best.centroid.length; i += 1) {
          best.centroid[i] = (best.centroid[i] * best.count + embedding[i]) / count
        }
        best.count = count
        return { id: best.id, similarity: bestScore, created: false }
      }
    }

    const speaker = { id: this.nextId, centroid: Float32Array.from(embedding), count: 1 }
    this.nextId += 1
    this.speakers.push(speaker)
    this.mergeSimilar()
    return { id: speaker.id, similarity: bestScore, created: true }
  }

  /** 合并过于相似的两个说话人（把小编号保留，大编号并入）。 */
  mergeSimilar() {
    for (let i = 0; i < this.speakers.length; i += 1) {
      for (let j = i + 1; j < this.speakers.length; j += 1) {
        const a = this.speakers[i]
        const b = this.speakers[j]
        if (SpeakerTracker.cosine(a.centroid, b.centroid) < this.mergeThreshold) continue
        const total = a.count + b.count
        for (let k = 0; k < a.centroid.length; k += 1) {
          a.centroid[k] = (a.centroid[k] * a.count + b.centroid[k] * b.count) / total
        }
        a.count = total
        this.speakers.splice(j, 1)
        this.lastMerged = { from: b.id, into: a.id }
        j -= 1
      }
    }
  }

  reset() {
    this.speakers = []
    this.nextId = 1
    this.lastMerged = undefined
  }

  get count() {
    return this.speakers.length
  }
}

module.exports = { fbank, decodeWav, SpeakerTracker, NUM_BINS }
