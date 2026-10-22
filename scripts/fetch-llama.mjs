#!/usr/bin/env node
/**
 * 构建前抓 llama.cpp 的 llama-server，打进安装包。
 *
 * 为什么打包：Windows 用户不需要自己下 37 MB 的二进制，也不需要 Python 环境。
 * 只保留 llama-server 和它依赖的库，其余 CLI 工具都删掉（39 MB → 30 MB）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD = 'b11804'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'vendor', 'llama')
const isWin = process.platform === 'win32'

// Windows 用 Vulkan 构建：有显卡走 GPU，没有则自动回落 CPU
const asset = isWin
  ? `llama-${BUILD}-bin-win-vulkan-x64.zip`
  : `llama-${BUILD}-bin-macos-arm64.tar.gz`

const mirrors = [
  `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${asset}`,
  `https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${asset}`,
]

const serverName = isWin ? 'llama-server.exe' : 'llama-server'
if (existsSync(join(outDir, serverName))) {
  console.log('llama-server 已存在，跳过')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const archive = join(outDir, asset)

let ok = false
for (const url of mirrors) {
  try {
    console.log('下载', url)
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    ok = true
    break
  } catch (error) {
    console.log('  失败:', error.message)
  }
}
if (!ok) {
  console.error('× 拿不到 llama.cpp 二进制')
  process.exit(1)
}

const tmp = join(outDir, 'tmp')
mkdirSync(tmp, { recursive: true })
if (isWin) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${tmp}'`])
} else {
  execFileSync('tar', ['-xzf', archive, '-C', tmp])
}

// 把可执行文件和库平铺到 outDir，其余工具删掉
// Windows：保留 llama-server.exe 和**全部** DLL。
// 之前只留了几个，漏掉 llama-server-impl.dll 导致进程秒退。
const keep = isWin
  ? /^(llama-server\.exe|.*\.dll)$/i
  : /^(llama-server|libggml.*\.dylib|libllama.*\.dylib|libmtmd.*\.dylib)$/

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full)
    else if (keep.test(name)) cpSync(full, join(outDir, name))
  }
}
walk(tmp)
rmSync(tmp, { recursive: true, force: true })
rmSync(archive, { force: true })

if (!existsSync(join(outDir, serverName))) {
  console.error('× 解压后没找到 llama-server')
  process.exit(1)
}
console.log('✓ vendor/llama/ 就绪')
