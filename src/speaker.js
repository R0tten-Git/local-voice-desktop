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


/**
 * 裁掉首尾静音。声纹模型对整段取平均，前后静音会拉低同一人的相似度。
 * @param {Float32Array} audio
 * @param {number} frame 一个能量帧的采样数（默认 160 = 10ms）
 * @returns {{audio: Float32Array, voicedSeconds: number}}
 */
function trimSilence(audio, frame = 160) {
  const frames = Math.floor(audio.length / frame)
  if (frames === 0) return { audio, voicedSeconds: 0 }

  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    for (let i = 0; i < frame; i += 1) {
      const v = audio[f * frame + i]
      sum += v * v
    }
    energy[f] = Math.sqrt(sum / frame)
  }

  // 用中位数估底噪，超过 2 倍底噪且高于绝对阈值才算有声
  const sorted = Array.from(energy).sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const threshold = Math.max(floor * 2, 0.004)

  let first = 0
  while (first < frames && energy[first] < threshold) first += 1
  let last = frames - 1
  while (last > first && energy[last] < threshold) last -= 1
  if (first >= last) return { audio: audio.slice(0, 0), voicedSeconds: 0 }

  let voiced = 0
  for (let f = first; f <= last; f += 1) if (energy[f] >= threshold) voiced += 1

  // 前后各留 50ms，避免把字头字尾削掉
  const pad = 5
  const start = Math.max(0, first - pad) * frame
  const end = Math.min(audio.length, (last + 1 + pad) * frame)
  return { audio: audio.slice(start, end), voicedSeconds: voiced * (frame / SAMPLE_RATE) }
}

/**
 * ��集式聚类（average linkage）。
 *
 * 不依赖绝对阈值：把最近的两个类不断合并，直到满足停止条件。
 * 真实录音里"同一个人的相似度"和"不同人的相似度"分布会重叠，
 * 绝对阈值必然失败，相对距离才稳。
 *
 * @param {Float32Array[]} embeddings 归一化向量
 * @param {{k?: number, minSimilarity?: number}} options
 *        k 指定人数时按 k 合并；不指定则合并到类间相似度低于 minSimilarity
 * @returns {{labels: number[], k: number}}
 */
function clusterEmbeddings(embeddings, options = {}) {
  const n = embeddings.length
  if (n === 0) return { labels: [], k: 0 }
  if (n === 1) return { labels: [1], k: 1 }

  const maxK = options.maxK ?? 8
  /**
   * 合并下限：两个类的相似度还这么高，就说明是同一个人。
   * 实测同一人的窗口两两相似度多在 0.65–0.9，不同人 0.2–0.5，
   * 0.55 落在中间的空档里。
   */
  const floorSimilarity = options.floorSimilarity ?? 0.55

  let clusters = embeddings.map((embedding, index) => ({
    members: [index],
    centroid: Float32Array.from(embedding),
  }))

  const target = options.k === undefined ? undefined : Math.max(1, Math.min(Number(options.k), n))

  while (clusters.length > 1) {
    if (target !== undefined && clusters.length <= target) break
    let bi = 0
    let bj = 1
    let bs = -1
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = SpeakerTracker.cosine(clusters[i].centroid, clusters[j].centroid)
        if (score > bs) {
          bs = score
          bi = i
          bj = j
        }
      }
    }
    // 自动模式：已经不像同一个人了就停；指定人数时按人数来
    if (target === undefined && bs < floorSimilarity) break
    if (target !== undefined && target === 1) break
    const a = clusters[bi]
    const b = clusters[bj]
    const total = a.members.length + b.members.length
    const centroid = new Float32Array(a.centroid.length)
    for (let i = 0; i < centroid.length; i += 1) {
      centroid[i] = (a.centroid[i] * a.members.length + b.centroid[i] * b.members.length) / total
    }
    clusters[bi] = { members: [...a.members, ...b.members], centroid }
    clusters.splice(bj, 1)
  }

  const labels = new Array(n).fill(0)
  clusters.sort((a, b) => b.members.length - a.members.length)
  clusters.forEach((cluster, index) => {
    for (const member of cluster.members) labels[member] = index + 1
  })
  return { labels, k: clusters.length }
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
    this.threshold = options.threshold ?? 0.62
    /** 只有这么高的相似度才允许改动质心，防止插话把质心拉偏 */
    this.updateMargin = options.updateMargin ?? 0.75
    this.mergeThreshold = options.mergeThreshold ?? 0.86
    /** 每个说话人保留的样本向量数：匹配时取最大值，比只比平均质心稳 */
    this.exemplars = options.exemplars ?? 12
    this.maxSpeakers = options.maxSpeakers ?? 8
    /**
     * 单个窗口的声纹不够稳，一次不匹配不能立刻建新说话人：
     * 先放进"待定"，等第二个窗口也指向它才转正，否则同一个人会被拆成好几个。
     */
    this.promoteCount = options.promoteCount ?? 2
    this.pendingThreshold = options.pendingThreshold ?? 0.58
    /** @type {Array<{id: number, centroid: Float32Array, count: number}>} */
    this.speakers = []
    /** @type {Array<{id: number, centroid: Float32Array, count: number}>} */
    this.pending = []
    this.nextId = 1
    this.nextPendingId = -1
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
    this.merges = []
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
      best.count += 1
      // 样本记忆：保留最近若干个，跨插话时靠它认出同一个人
      best.exemplars = best.exemplars ?? []
      best.exemplars.push(Float32Array.from(embedding))
      if (best.exemplars.length > this.exemplars) best.exemplars.shift()
      // 只有足够像才挪质心，勉强及格的不动，避免被插话带偏
      if (bestScore >= this.updateMargin) {
        for (let i = 0; i < best.centroid.length; i += 1) {
          best.centroid[i] = (best.centroid[i] * (best.count - 1) + embedding[i]) / best.count
        }
      }
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

    // 先看有没有"待定"的候选，像它就累计证据
    let pendingBest
    let pendingScore = -1
    for (const item of this.pending) {
      const score = SpeakerTracker.cosine(embedding, item.centroid)
      if (score > pendingScore) {
        pendingScore = score
        pendingBest = item
      }
    }

    if (pendingBest !== undefined && pendingScore >= this.pendingThreshold) {
      const count = pendingBest.count + 1
      for (let i = 0; i < pendingBest.centroid.length; i += 1) {
        pendingBest.centroid[i] = (pendingBest.centroid[i] * pendingBest.count + embedding[i]) / count
      }
      pendingBest.count = count
      if (count >= this.promoteCount) {
        // 证据够了：转正，并把之前挂在临时编号上的行一起改过来
        this.pending = this.pending.filter((item) => item !== pendingBest)
        const speaker = {
          id: this.nextId,
          centroid: pendingBest.centroid,
          exemplars: [Float32Array.from(pendingBest.centroid)],
          count,
        }
        this.nextId += 1
        this.speakers.push(speaker)
        this.merges.push({ from: pendingBest.id, into: speaker.id })
        this.mergeSimilar()
        return { id: speaker.id, similarity: pendingScore, created: true, promotedFrom: pendingBest.id }
      }
      return { id: pendingBest.id, similarity: pendingScore, created: false, pending: true }
    }

    // 完全没见过的声音：挂到新的临时编号下，不占用正式编号
    const candidate = { id: this.nextPendingId, centroid: Float32Array.from(embedding), count: 1 }
    this.nextPendingId -= 1
    this.pending.push(candidate)
    return { id: candidate.id, similarity: bestScore, created: false, pending: true }
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
        if (this.merges !== undefined) this.merges.push({ from: b.id, into: a.id })
        j -= 1
      }
    }
  }

  reset() {
    this.speakers = []
    this.pending = []
    this.nextId = 1
    this.nextPendingId = -1
    this.lastMerged = undefined
  }

  get count() {
    return this.speakers.length
  }
}

module.exports = { fbank, trimSilence, decodeWav, SpeakerTracker, clusterEmbeddings, NUM_BINS }
