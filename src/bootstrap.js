/**
 * 运行时环境：在应用内准备 Python + mlx-audio。
 *
 * 顺序刻意和手工安装保持一致（uv → 独立 CPython 3.12 → venv → 依赖），
 * 因为系统自带的 python3 是 3.9，而 mlx-audio 要求 3.10+。
 *
 * 所有步骤都是幂等的：已经装好的部分会跳过，失败可以重试。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = os.homedir()
const IS_WIN = process.platform === 'win32'
/** Apple Silicon 用 MLX；其余平台用 torch + transformers */
const BACKEND = process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'torch'

const VENV = process.env.LOCAL_VOICE_VENV ?? path.join(HOME, '.local/venvs/mlx-audio')
const VENV_PYTHON = IS_WIN
  ? path.join(VENV, 'Scripts/python.exe')
  : path.join(VENV, 'bin/python')
const UV_NAME = IS_WIN ? 'uv.exe' : 'uv'
/** 优先用安装包里自带的 uv（用户不用下载、也不依赖网络） */
const BUNDLED_UV = path.join(process.resourcesPath ?? '', 'uv', UV_NAME)
const UV = fs.existsSync(BUNDLED_UV) ? BUNDLED_UV : path.join(HOME, '.local/bin', UV_NAME)
const UV_DIR = path.join(HOME, '.local/bin')

/** 两个后端的依赖完全不同：MLX 只认 Apple Silicon，torch 全平台通用。 */
/**
 * 依赖从国内 PyPI 镜像拉。官方 pypi.org 在国内经常几十 KB/s，
 * 清华镜像实测快一个数量级，且完整同步 PyPI。
 */
const PYPI_MIRROR = process.env.LOCAL_VOICE_PYPI ?? 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** Python 本体来自 python-build-standalone（GitHub），备用走代理。 */
const PYTHON_MIRROR =
  'https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download'

const PACKAGES = BACKEND === 'mlx'
  ? ['mlx-audio==0.5.5', 'sounddevice', 'numpy', 'huggingface_hub']
  : ['torch', 'transformers', 'numpy', 'huggingface_hub', 'scipy']

/** 校验用的 import 也要跟着后端走。 */
const IMPORT_CHECK = BACKEND === 'mlx'
  ? 'import mlx_audio, numpy, sounddevice'
  : 'import torch, transformers, numpy, scipy'

/** 找系统 python3（用来引导 uv）。 */
/**
 * 找系统 Python。
 *
 * Windows 上不能假设 `python` 存在：常见情况是只有 `py` 启动器，或者只有
 * 微软商店的占位符（执行返回 9009）。所以逐个真的跑一次 `--version`。
 *
 * @returns {Promise<{cmd: string, prefix: string[]} | undefined>}
 */
async function detectPython(onLog = () => {}) {
  /** @type {Array<{cmd: string, prefix: string[]}>} */
  const candidates = IS_WIN
    ? [
        { cmd: 'py', prefix: ['-3'] },
        { cmd: 'python', prefix: [] },
        { cmd: 'python3', prefix: [] },
      ]
    : [
        { cmd: '/usr/bin/python3', prefix: [] },
        { cmd: '/opt/homebrew/bin/python3', prefix: [] },
        { cmd: '/usr/local/bin/python3', prefix: [] },
        { cmd: 'python3', prefix: [] },
      ]

  for (const candidate of candidates) {
    try {
      await run(candidate.cmd, [...candidate.prefix, '--version'], () => {}, 20_000)
      onLog(`找到 Python：${candidate.cmd} ${candidate.prefix.join(' ')}`.trim())
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return undefined
}

/** 直接下载 uv 的独立二进制（不依赖系统 Python）。 */
async function downloadUvStandalone(onLog = () => {}) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const file = IS_WIN
    ? `uv-${arch}-pc-windows-msvc.zip`
    : `uv-${arch}-apple-darwin.tar.gz`
  // ghproxy.net 实测会 302 后挂住，换成 gh-proxy.com
  const mirrors = [
    `https://github.com/astral-sh/uv/releases/latest/download/${file}`,
    `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/${file}`,
  ]
  const target = path.join(HOME, '.local', file)
  fs.mkdirSync(path.join(HOME, '.local'), { recursive: true })

  let lastError
  for (const url of mirrors) {
    try {
      onLog(`下载 uv：${url}`)
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()))
      lastError = undefined
      break
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError

  if (IS_WIN) {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -Path '${target}' -DestinationPath '${UV_DIR}'`,
    ], onLog)
  } else {
    await run('tar', ['-xzf', target, '-C', UV_DIR, '--strip-components=1'], onLog)
    fs.chmodSync(UV, 0o755)
  }
  fs.rmSync(target, { force: true })
}

/** 当前环境是否可用。 */
function status() {
  if (!fs.existsSync(VENV_PYTHON)) {
    return { ready: false, reason: 'missing-venv', python: VENV_PYTHON, venv: VENV }
  }
  try {
    const { spawnSync } = require('node:child_process')
    const probe = spawnSync(VENV_PYTHON, ['-c', IMPORT_CHECK], {
      timeout: 60_000,
      encoding: 'utf8',
    })
    if (probe.status === 0) return { ready: true, python: VENV_PYTHON, venv: VENV }
    return {
      ready: false,
      reason: 'missing-packages',
      python: VENV_PYTHON,
      venv: VENV,
      detail: (probe.stderr || '').trim().split('\n').pop(),
    }
  } catch (error) {
    return { ready: false, reason: 'probe-failed', python: VENV_PYTHON, venv: VENV, detail: String(error) }
  }
}

/** 有没有 NVIDIA 显卡（决定要不要提示 CUDA）。 */
async function hasNvidia() {
  try {
    await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], () => {}, 8_000)
    return true
  } catch {
    return false
  }
}

/** 跑一个命令，把输出逐行回传。 */
function run(command, args, onLog, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        PATH: `${UV_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${path.basename(command)} 超时`))
    }, timeoutMs)

    const relay = (chunk) => {
      const text = String(chunk)
      output += text
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) onLog(trimmed)
      }
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${path.basename(command)} 退出码 ${code}`))
    })
  })
}

/**
 * 准备环境。已是可用状态时直接返回。
 * @param {(line: string) => void} onLog - 逐行日志（会显示在界面上）
 */
async function install(onLog = () => {}) {
  const current = status()
  if (current.ready) return { ...current, skipped: true }

  // 1. uv：有系统 Python 就走 pip，没有就下独立二进制
  if (fs.existsSync(UV)) {
    onLog('① uv 已存在，跳过')
  } else {
    onLog('① 安装 uv（Python 工具链管理器）…')
    const python = await detectPython(onLog)
    if (python) {
      try {
        await run(python.cmd, [...python.prefix, '-m', 'pip', 'install', '--user', '--upgrade', '--quiet', 'uv'], onLog)
      } catch (error) {
        onLog(`pip 安装失败（${error.message}），改用独立二进制`)
      }
    } else {
      onLog('系统没有可用的 Python，改为直接下载 uv')
    }
    if (!fs.existsSync(UV)) await downloadUvStandalone(onLog)
  }
  if (!fs.existsSync(UV)) throw new Error('uv 安装失败')

  // 2. 独立 CPython 3.12（不动系统 Python）
  onLog('② 准备 Python 3.12…')
  try {
    await run(UV, ['python', 'install', '3.12'], onLog)
  } catch (error) {
    onLog(`默认源失败（${error.message}），改用国内代理重试`)
    await run(UV, ['python', 'install', '3.12', '--mirror', PYTHON_MIRROR], onLog)
  }

  // 3. venv
  if (!fs.existsSync(VENV_PYTHON)) {
    onLog('③ 创建虚拟环境…')
    await run(UV, ['venv', '--python', '3.12', '--seed', VENV], onLog)
  } else {
    onLog('③ 虚拟环境已存在，跳过')
  }

  // 4. 依赖（约 300MB）
  onLog(`④ 安装依赖：${PACKAGES.join(' ')}（约 ${BACKEND === 'mlx' ? 300 : 900}MB，几分钟）…`)
  onLog(`依赖源：${PYPI_MIRROR}`)
  await run(
    UV,
    ['pip', 'install', '--python', VENV_PYTHON, '--index-url', PYPI_MIRROR, ...PACKAGES],
    onLog,
  )

  if (BACKEND === 'torch' && (await hasNvidia().catch(() => false))) {
    onLog('提示：检测到 NVIDIA 显卡，当前装的是 CPU 版 torch')
    onLog(`  想用 GPU 加速可执行：${UV} pip install --python "${VENV_PYTHON}" --force-reinstall --index-url https://download.pytorch.org/whl/cu124 torch`)
  }

  onLog('⑤ 校验…')
  await run(VENV_PYTHON, ['-c', `${IMPORT_CHECK}; print("ok")`], onLog)
  onLog('环境就绪')

  return status()
}

module.exports = { status, install, VENV_PYTHON, UV, BACKEND, detectPython }
