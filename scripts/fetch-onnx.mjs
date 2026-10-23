#!/usr/bin/env node
/** 下载 CAM++ 声纹模型（28MB）到 vendor/onnx，随安装包分发。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'vendor', 'onnx')
const dest = join(outDir, 'campplus.onnx')
if (existsSync(dest)) {
  console.log('声纹模型已存在，跳过')
  process.exit(0)
}

const mirrors = [
  'https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
]

mkdirSync(outDir, { recursive: true })
let ok = false
for (const url of mirrors) {
  try {
    console.log('下载', url)
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 20_000_000) throw new Error(`文件只有 ${bytes.length} 字节，可能不完整`)
    writeFileSync(dest, bytes)
    console.log(`✓ campplus.onnx ${(bytes.length / 1e6).toFixed(1)} MB`)
    ok = true
    break
  } catch (error) {
    console.log('  失败:', error.message)
  }
}
process.exit(ok ? 0 : 1)
