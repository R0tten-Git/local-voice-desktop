#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen3-ASR worker（torch / transformers 后端）——Windows 与 Intel Mac 用。

和 MLX 版 worker.py 保持完全相同的 ndjson 协议，所以主进程的引擎桥一行都不用改：

  启动完成 → {"type":"ready","loadMs":1234}
  请求     → {"id":1,"wav":"<base64 WAV 16k mono pcm16>","language":"auto"}
  应答     → {"id":1,"text":"…","ms":620,"audioSec":3.1}

模型用 HuggingFace 原始格式（Qwen/Qwen3-ASR-1.7B-hf），有 NVIDIA 显卡时走 CUDA，
否则 CPU。MLX 那份 8bit 量化权重在这里用不了，这是两条独立的部署路径。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import wave

DEFAULT_MODEL = os.path.expanduser("~/models/Qwen3-ASR-1.7B-hf")

LANG_MAP = {
    "auto": None,
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ja": "Japanese",
    "ko": "Korean",
}

HOTWORDS = [
    "调优", "转写", "实时转写", "字幕", "纪要", "阈值", "校准",
    "识别器", "打断", "上下文", "推理", "延迟", "缓存", "面板",
    "浮窗", "窗口", "麦克风", "会议", "段落", "纠错", "词表",
    "会话", "录音", "转写面板",
]

FIXES = [("挑右", "调优"), ("条右", "调优")]


def force_utf8() -> None:
    """Windows 上 stdout 默认是 GBK，必须显式切到 UTF-8 才能让父进程正确解码。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def log(msg: str) -> None:
    print(f"[qwen3-torch-worker] {msg}", file=sys.stderr, flush=True)


HOTWORD_DUMP = "、".join(HOTWORDS)


def strip_hotword_dump(text: str) -> str:
    """去掉模型复述出来的热词表。"""
    if not text:
        return text
    if HOTWORD_DUMP in text:
        text = text.replace(HOTWORD_DUMP, "")
    # 也处理部分复述：连续出现 6 个以上热词就认为是在念词表
    hits = sum(1 for word in HOTWORDS if word in text)
    if hits >= 6:
        for word in HOTWORDS:
            text = text.replace(f"{word}、", "").replace(word, "")
    return text.strip()


def clean_text(text: str) -> str:
    """去掉模型回显的对话模板痕迹。"""
    text = (text or "").strip()
    # 正常情况下 extract_transcription 已经处理好了，这里是兜底
    if "<asr_text>" in text:
        text = text.split("<asr_text>", 1)[1]
    if "assistant" in text:
        text = text.split("assistant", 1)[1]
    for marker in ("system", "<|im_start|>", "<|im_end|>", "user"):
        text = text.replace(marker, "")
    text = strip_hotword_dump(text)
    return text.strip()


def apply_fixes(text: str):
    hits = []
    for wrong, right in FIXES:
        if wrong in text:
            hits.append(wrong)
            text = text.replace(wrong, right)
    return text, hits


def wav_to_float32(raw: bytes):
    """WAV 字节 → 16kHz 单声道 float32（标准库，无第三方依赖）。"""
    import numpy as np

    with wave.open(io.BytesIO(raw), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width == 2:
        data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        data = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported sample width: {width * 8}bit")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)

    if rate != 16000:
        from math import gcd

        from scipy.signal import resample_poly

        step = gcd(16000, rate)
        data = resample_poly(data, 16000 // step, rate // step).astype(np.float32)

    return np.ascontiguousarray(data, dtype=np.float32)


def main() -> int:
    force_utf8()
    model_path = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL)
    if not os.path.isdir(model_path):
        log(f"模型目录不存在：{model_path}")
        return 2

    proto = sys.stdout
    sys.stdout = sys.stderr  # import/加载期间的输出不能污染协议

    t0 = time.time()
    log(f"加载模型 {os.path.basename(model_path)} …")

    import torch
    from transformers import Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"

    if device == "cpu":
        import shutil as _shutil

        if _shutil.which("nvidia-smi"):
            log("检测到 NVIDIA 显卡，但当前 torch 是 CPU 版，正在用 CPU 推理")
            log("装 CUDA 版可提速 10 倍以上（约 2.5GB，走阿里云镜像）：")
            log('  uv pip install --force-reinstall "https://mirrors.aliyun.com/pytorch-wheels/cu124/torch-2.6.0%2Bcu124-cp312-cp312-win_amd64.whl"')
    if device == "cpu":
        # 默认线程数在 Windows 上常常只给一半，显式用满
        threads = os.cpu_count() or 4
        torch.set_num_threads(threads)
        log(f"CPU 线程数 {threads}")
    if device == "cuda":
        major, minor = torch.cuda.get_device_capability(0)
        # bf16 从 Ampere（8.0）开始原生支持；Turing（7.x）用 fp16；
        # Pascal（6.x，如 GTX 1060）fp16 只有 1/64 吞吐，用 fp32 最快。
        if major >= 8:
            dtype = torch.bfloat16
        elif major == 7:
            dtype = torch.float16
        else:
            dtype = torch.float32
        log(f"显卡算力 {major}.{minor} → dtype {dtype}")
    else:
        dtype = torch.float32
    log(f"设备 {device} · dtype {dtype}")

    processor = Qwen3ASRProcessor.from_pretrained(model_path)

    def load(precision):
        """low_cpu_mem_usage 避免加载时复制一份完整权重，Windows 上很关键。"""
        return Qwen3ASRForConditionalGeneration.from_pretrained(
            model_path, dtype=precision, low_cpu_mem_usage=True
        )

    try:
        model = load(dtype)
    except OSError as error:
        text = str(error)
        low_memory = "1455" in text or "paging file" in text.lower() or "页面文件" in text
        if not low_memory:
            raise
        # Windows 分页文件太小时，float32 的峰值撑不住；换半精度只要一半内存
        log("内存不足（页面文件太小），改用半精度重试 …")
        try:
            model = load(torch.bfloat16)
        except OSError:
            log("半精度也失败。请在 Windows「系统属性 → 高级 → 性能设置 → 高级 → 虚拟内存」")
            log("把分页文件调到 8GB 以上，或关闭其他占用内存的程序后重试。")
            raise
    model.to(device)
    model.eval()

    if device == "cpu":
        # CPU 上 float32 太慢（实测每段 9 秒）。动态量化只作用于 Linear 层，
        # 精度损失很小但速度通常提升 2–3 倍。
        try:
            log("CPU 动态量化（int8）…")
            model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
            # 走一遍完整前向，确认量化没破坏多模态结构
            import numpy as _np

            probe = processor.apply_transcription_request(
                audio=_np.zeros(8000, dtype=_np.float32), language=None, return_tensors="pt"
            )
            with torch.no_grad():
                model.generate(**probe, max_new_tokens=2)
            log("量化完成（自检通过）")
        except Exception as error:
            log(f"量化不可用（{type(error).__name__}），回退 float32")
            import gc

            del model
            gc.collect()
            model = load(dtype)

    # 这里刻意不传 prompt（热词表）：0.6B 这类小模型会把 system prompt
    # 当成待转写内容原样吐出来，用户会看到"调优、转写、实时转写…"整行。
    # MLX 后端用的是解码期偏置，没有这个问题。
    prompt = None

    if device == "cuda":
        total = torch.cuda.get_device_properties(0).total_memory / 1e9
        log(f"显存 {total:.1f} GB（1.7B 模型约需 4.5 GB，0.6B 约需 2 GB）")

    load_ms = int((time.time() - t0) * 1000)
    sys.stdout = proto
    print(json.dumps({"type": "ready", "loadMs": load_ms, "model": model_path, "device": device}), flush=True)
    log(f"就绪（{load_ms}ms）")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            log(f"请求不是合法 JSON：{error}")
            continue

        rid = request.get("id")
        if request.get("type") == "ping":
            print(json.dumps({"id": rid, "text": "", "pong": True}), flush=True)
            continue

        try:
            language = LANG_MAP.get(request.get("language") or "auto", request.get("language"))
            if language == "auto":
                language = None
            raw_wav = base64.b64decode(request["wav"])
            audio = wav_to_float32(raw_wav)
            if audio.size == 0:
                raise ValueError("empty audio")

            inputs = processor.apply_transcription_request(
                audio=audio,
                language=language,
                prompt=prompt,
                return_tensors="pt",
            ).to(device)

            started = time.time()
            with torch.no_grad():
                generated = model.generate(**inputs, max_new_tokens=256)
            raw = processor.batch_decode(generated, skip_special_tokens=True)[0]
            text = processor.extract_transcription(raw) or ""
            text = clean_text(text)
            text, _hits = apply_fixes(text)
            elapsed = int((time.time() - started) * 1000)

            print(
                json.dumps(
                    {
                        "id": rid,
                        "text": text,
                        "ms": elapsed,
                        "audioSec": round(audio.size / 16000.0, 3),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as error:
            print(
                json.dumps({"id": rid, "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False),
                flush=True,
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
