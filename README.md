# LocalVoice

本机实时语音转写：点一下开始说话，说完一句停一下，就出一行字。**音频不出机器**，不需要账号，不需要联网。

> 这是独立桌面应用（Electron），与 DSH 插件版是两套东西：
> 插件版见 [dsh-plugin-local-voice](https://github.com/R0tten-Git/dsh-plugin-local-voice)。

## 它做什么

- 右下角/置顶的小窗口，边说边出字，可暂停、可复制、可存 markdown
- 识别引擎 **Qwen3-ASR**（0.6B / 1.7B，4bit / 8bit）跑在本地
- 启动时探测你的硬件，推荐该装哪个模型
- macOS 走 MLX，Windows / Intel Mac 走 llama.cpp（GGUF）

## 硬件与模型

实测数据（12 句 / 261 字，macOS M4）：

| 模型 | 体积 | 每句 | 峰值内存 | 准确率 |
|---|---|---|---|---|
| 1.7B-4bit | 1.6 GB | 548 ms | 1.7 GB | 99.62% |
| 1.7B-8bit | 2.5 GB | 738 ms | 2.5 GB | 100.00% |
| 0.6B-4bit | 0.7 GB | 240 ms | 0.85 GB | 98.47% |

默认推荐 **1.7B-4bit**：比 8bit 只差 0.38%，但快 26%、省 800MB。

## 开发

```bash
npm install
npm run dev          # 启动应用
npm run probe        # 只看硬件探测与推荐结果（不开窗口）
```

引擎（macOS Apple Silicon）：

```bash
uv venv ~/.local/venvs/mlx-audio --python 3.12
~/.local/venvs/mlx-audio/bin/pip install "mlx-audio==0.5.5" sounddevice numpy huggingface_hub
```

**模型不用手动下**：应用启动会探测硬件并推荐一个模型，点「下载并安装」直接从魔搭拉取（带进度条、断点续传、大小校验），下完自动可用。

模型存放在 `~/models/<仓库名>`，应用启动时自动发现。

## 打包

```bash
npm run build:mac    # 出 dmg（Apple Silicon）
npm run build:win    # 出 nsis 安装包（需在 Windows 或 CI 上跑）
```

未签名的 macOS 应用首次打开会被 Gatekeeper 拦，运行一次即可：

```bash
xattr -dr com.apple.quarantine /Applications/LocalVoice.app
```

## 排障

**启动后没有窗口，报 `Cannot read properties of undefined (reading 'whenReady')`**
说明进程里带了 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成了纯 Node：

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

**首次录音没有声音**
macOS 会弹系统授权；如果误点了拒绝，去 系统设置 → 隐私与安全性 → 麦克风，把 LocalVoice 勾上。

**一直不出字**
界面上会显示实时电平：说话时应在 0.02 以上。一直是 0.00x 就是没采到声音（权限或设备）。

## 结构

```
src/main.js        主进程：窗口、麦克风权限、IPC
src/preload.js     只暴露必要的 IPC 接口
src/engine.js      管理常驻的 python 推理进程（ndjson over stdio）
src/renderer/      界面：录音、能量切句、上屏
engine/worker.py   推理进程：模型只加载一次
scripts/probe.js   硬件探测与模型推荐
```

## 许可

MIT
