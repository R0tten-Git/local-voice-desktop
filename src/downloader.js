/**
 * 模型下载器：直接从魔搭拉权重，带进度、断点续传和大小校验。
 *
 * 为什么不用 huggingface_hub：那是 Python 侧的依赖，而"新用户第一次打开 App"
 * 这一层必须零依赖。魔搭的公开 API 不需要 token，直链实测 17 MB/s。
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { createHash } = require('node:crypto')

const API = 'https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=true'
const FILE = 'https://modelscope.cn/models/{repo}/resolve/master/{path}'

/** 一个文件下载多久汇报一次进度 */
const PROGRESS_INTERVAL_MS = 250

/** 列出仓库文件（路径 + 字节数）。 */
async function listFiles(repo) {
  const response = await fetch(API.replace('{repo}', repo), {
    headers: { 'user-agent': 'local-voice-desktop' },
  })
  if (!response.ok) throw new Error(`列目录失败 HTTP ${response.status}`)
  const payload = await response.json()
  const entries = payload?.Data?.Files ?? []
  return entries
    .filter((item) => item.Path && item.Type !== 'tree')
    .map((item) => ({
      path: item.Path,
      size: Number(item.Size ?? 0),
      sha256: String(item.Sha256 ?? '').toLowerCase(),
    }))
}

/** 计算文件 sha256（流式，避免把大文件读进内存）。 */
async function fileSha256(filePath) {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

/** 单个文件：支持续传，返回实际写入的字节数。 */
async function downloadFile(repo, file, destRoot, onBytes) {
  const target = path.join(destRoot, file.path)
  await fsp.mkdir(path.dirname(target), { recursive: true })

  if (fs.existsSync(target) && fs.statSync(target).size === file.size) {
    // 大小对不代表内容对：之前的版本只比大小，结果把损坏的模型当成了已下载
    if (file.sha256) {
      const actual = await fileSha256(target)
      if (actual !== file.sha256) {
        await fsp.rm(target, { force: true }) // 内容不对，删掉重下
      } else {
        return 0
      }
    } else {
      return 0
    }
  }

  const part = `${target}.part`
  let offset = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (offset > file.size) {
    await fsp.rm(part, { force: true })
    offset = 0
  }

  const headers = { 'user-agent': 'local-voice-desktop' }
  if (offset > 0) headers.Range = `bytes=${offset}-`

  const response = await fetch(FILE.replace('{repo}', repo).replace('{path}', file.path), { headers })
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载 ${file.path} 失败 HTTP ${response.status}`)
  }
  if (!response.body) throw new Error(`下载 ${file.path} 没有响应体`)

  const handle = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
  let written = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    written += chunk.length
    onBytes(chunk.length)
  })
  await pipeline(source, handle)

  const total = offset + written
  if (file.size > 0 && total !== file.size) {
    throw new Error(`${file.path} 大小不符：期望 ${file.size}，实际 ${total}`)
  }
  await fsp.rename(part, target)

  if (file.sha256) {
    const actual = await fileSha256(target)
    if (actual !== file.sha256) {
      onBytes?.(-1)
      await fsp.rm(target, { force: true })
      throw new Error(
        `${file.path} 内容校验失败（期望 ${file.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
      )
    }
  }
  return written
}

/**
 * 下载整个模型仓库。
 * @param {string} repo - 例如 mlx-community/Qwen3-ASR-1.7B-4bit
 * @param {string} destRoot - 目标目录（通常 ~/models/<名字>）
 * @param {(progress: object) => void} onProgress - 进度回调
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function downloadModel(repo, destRoot, onProgress = () => {}, include) {
  let files = await listFiles(repo)
  if (files.length === 0) throw new Error('仓库里没有文件')
  if (Array.isArray(include) && include.length > 0) {
    files = files.filter((file) => include.includes(path.basename(file.path)))
    if (files.length === 0) throw new Error('没有匹配到要下载的文件')
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let doneBytes = 0
  let lastEmit = 0

  /** 带进度回调的下载。 */
  const fetchFile = async (file, index, started) =>
    downloadFile(repo, file, destRoot, (bytes) => {
      doneBytes += bytes
      const now = Date.now()
      if (now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      const seconds = (now - started) / 1000
      onProgress({
        phase: 'bytes',
        file: file.path,
        index: index + 1,
        files: files.length,
        doneBytes,
        totalBytes,
        bytesPerSecond: seconds > 0 ? Math.round(doneBytes / seconds) : undefined,
      })
    })

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    onProgress({
      phase: 'file',
      file: file.path,
      index: index + 1,
      files: files.length,
      doneBytes,
      totalBytes,
    })
    const started = Date.now()
    try {
      await fetchFile(file, index, started)
    } catch (error) {
      if (!String(error.message).includes('内容校验失败')) throw error
      // 续传拼出来的文件内容不对：丢掉残片，从头再下一遍
      onProgress({
        phase: 'file',
        file: `${file.path}（校验失败，重新下载）`,
        index: index + 1,
        files: files.length,
        doneBytes,
        totalBytes,
      })
      await fsp.rm(`${path.join(destRoot, file.path)}.part`, { force: true })
      await fetchFile(file, index, Date.now())
    }
  }

  onProgress({ phase: 'done', doneBytes, totalBytes, files: files.length })
  return { path: destRoot, bytes: doneBytes }
}

module.exports = { downloadModel, listFiles, downloadFile, downloadUrl }
