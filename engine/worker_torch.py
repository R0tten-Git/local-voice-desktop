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
        # 默认线程数在 Windows 上常常只给一半，显式用满
        threads = os.cpu_count() or 4
        torch.set_num_threads(threads)
        log(f"CPU 线程数 {threads}")
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    log(f"设备 {device} · dtype {dtype}")

    processor = Qwen3ASRProcessor.from_pretrained(model_path)
    model = Qwen3ASRForConditionalGeneration.from_pretrained(model_path, dtype=dtype)
    model.to(device)
    model.eval()

    # 这里刻意不传 prompt（热词表）：0.6B 这类小模型会把 system prompt
    # 当成待转写内容原样吐出来，用户会看到"调优、转写、实时转写…"整行。
    # MLX 后端用的是解码期偏置，没有这个问题。
    prompt = None

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
