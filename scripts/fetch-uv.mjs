#!/usr/bin/env node
/**
 * 构建前抓一个 uv 二进制放进安装包。
 *
 * 为什么打包而不是让用户下：中国网络访问 GitHub Releases 经常卡住，
 * 而 uv 只有 15 MB —— 直接塞进安装包最省事，用户永远不需要等这个下载。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'vendor', 'uv')
const isWin = process.platform === 'win32'
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

const file = isWin
  ? `uv-${arch}-pc-windows-msvc.zip`
  : process.platform === 'darwin'
    ? `uv-${arch}-apple-darwin.tar.gz`
    : `uv-${arch}-unknown-linux-gnu.tar.gz`

const mirrors = [
  `https://github.com/astral-sh/uv/releases/latest/download/${file}`,
  `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/${file}`,
]

mkdirSync(outDir, { recursive: true })
const archive = join(outDir, file)

if (existsSync(join(outDir, isWin ? 'uv.exe' : 'uv'))) {
  console.log('uv 已存在，跳过')
  process.exit(0)
}

let ok = false
for (const url of mirrors) {
  try {
    console.log('下载', url)
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    ok = true
    break
  } catch (error) {
    console.log('  失败:', error.message)
  }
}
if (!ok) {
  console.error('× 拿不到 uv，构建会缺这个文件')
  process.exit(1)
}

if (isWin) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${outDir}'`])
} else {
  execFileSync('tar', ['-xzf', archive, '-C', outDir, '--strip-components=1'])
  chmodSync(join(outDir, 'uv'), 0o755)
}
rmSync(archive, { force: true })
console.log('✓ vendor/uv/', isWin ? 'uv.exe' : 'uv')
