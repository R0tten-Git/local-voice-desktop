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
const VENV = process.env.LOCAL_VOICE_VENV ?? path.join(HOME, '.local/venvs/mlx-audio')
const VENV_PYTHON = path.join(VENV, 'bin/python')
const UV = path.join(HOME, '.local/bin/uv')

const PACKAGES = ['mlx-audio==0.5.5', 'sounddevice', 'numpy', 'huggingface_hub']

/** 找系统 python3（用来引导 uv）。 */
function systemPython() {
  const candidates = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
  return candidates.find((p) => fs.existsSync(p))
}

/** 当前环境是否可用。 */
function status() {
  if (!fs.existsSync(VENV_PYTHON)) {
    return { ready: false, reason: 'missing-venv', python: VENV_PYTHON }
  }
  try {
    const { spawnSync } = require('node:child_process')
    const probe = spawnSync(VENV_PYTHON, ['-c', 'import mlx_audio, numpy, sounddevice'], {
      timeout: 60_000,
      encoding: 'utf8',
    })
    if (probe.status === 0) return { ready: true, python: VENV_PYTHON }
    return {
      ready: false,
      reason: 'missing-packages',
      python: VENV_PYTHON,
      detail: (probe.stderr || '').trim().split('\n').pop(),
    }
  } catch (error) {
    return { ready: false, reason: 'probe-failed', python: VENV_PYTHON, detail: String(error) }
  }
}

/** 跑一个命令，把输出逐行回传。 */
function run(command, args, onLog, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PATH: `${path.join(HOME, '.local/bin')}:${process.env.PATH ?? ''}` },
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

  const python = systemPython()
  if (!python) throw new Error('找不到系统 python3，无法开始安装')

  // 1. uv：用系统 python 装到用户目录，不需要 sudo
  if (!fs.existsSync(UV)) {
    onLog('① 安装 uv（Python 工具链管理器）…')
    await run(python, ['-m', 'pip', 'install', '--user', '--upgrade', '--quiet', 'uv'], onLog)
  } else {
    onLog('① uv 已存在，跳过')
  }
  if (!fs.existsSync(UV)) throw new Error('uv 安装失败')

  // 2. 独立 CPython 3.12（不动系统 Python）
  onLog('② 准备 Python 3.12…')
  await run(UV, ['python', 'install', '3.12'], onLog)

  // 3. venv
  if (!fs.existsSync(VENV_PYTHON)) {
    onLog('③ 创建虚拟环境…')
    await run(UV, ['venv', '--python', '3.12', '--seed', VENV], onLog)
  } else {
    onLog('③ 虚拟环境已存在，跳过')
  }

  // 4. 依赖（约 300MB）
  onLog(`④ 安装依赖：${PACKAGES.join(' ')}（约 300MB，几分钟）…`)
  await run(UV, ['pip', 'install', '--python', VENV_PYTHON, ...PACKAGES], onLog)

  onLog('⑤ 校验…')
  await run(VENV_PYTHON, ['-c', 'import mlx_audio, numpy, sounddevice; print("ok")'], onLog)
  onLog('环境就绪')

  return status()
}

module.exports = { status, install, VENV_PYTHON, UV }
