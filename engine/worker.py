#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen3-ASR worker —— DSH 语音输入 Provider 的 Python 半边。

协议：stdin/stdout 各一行一个 JSON（ndjson），模型进程常驻。

  启动完成 → {"type":"ready","loadMs":1234,"model":"..."}
  请求     → {"id":1,"wav":"<base64 WAV 16k mono pcm16>","language":"auto"}
  应答     → {"id":1,"text":"……","ms":620}
  出错     → {"id":1,"error":"ValueError: ..."}

关键：模型只在启动时 load 一次，之后每条请求直接推理。任何日志都走 stderr，
stdout 只留给协议本身 —— 否则 mlx / transformers 的 import 输出会污染协议流。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import wave

DEFAULT_MODEL = os.path.expanduser("~/models/Qwen3-ASR-1.7B-8bit")

# DSH 侧传短码，Qwen3-ASR 认英文语言名（config.json 的 support_languages）
LANG_MAP = {
    "auto": None,
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ja": "Japanese",
    "ko": "Korean",
}


AUDIT = os.path.expanduser("~/Library/Logs/dsh-qwen3-asr.log")


# 领域词表：Qwen3-ASR 会把它们折进 system prompt，用来给相似音的词做偏置。
# 这是"根据上下文纠正"的正确做法——在解码阶段就压低同音误识，而不是事后硬替换。
HOTWORDS = [
    "调优", "转写", "实时转写", "字幕", "纪要", "阈值", "校准",
    "识别器", "打断", "上下文", "推理", "延迟", "缓存", "面板",
    # 实测高频同音误识：浮窗→浮床/服装，窗口→仓位
    "浮窗", "窗口", "麦克风", "会议", "段落", "纠错", "词表",
]

# 事后兜底：只放"确定错、且不会误伤"的词，宁少勿多。
# 只保留"在正常中文里几乎不可能出现"的错形。
# 教训：曾经把「调右」也放进表里，结果你念引号里的错词时被改成了正确词——
# 事后硬替换一定会误伤，所以词表偏置才是主力，这里只做兜底。
FIXES = [
    ("挑右", "调优"),
    ("条右", "调优"),
]


def apply_fixes(text: str):
    """返回 (纠正后文本, 命中的原始片段列表)。"""
    hits = []
    for wrong, right in FIXES:
        if wrong in text:
            hits.append(wrong)
            text = text.replace(wrong, right)
    return text, hits


def log(msg: str) -> None:
    print(f"[qwen3-worker] {msg}", file=sys.stderr, flush=True)


def audit(msg: str) -> None:
    """落盘一行审计日志：谁在什么时候送进来多大的音频、出了多少字。

    Host 会把进程的 stderr 收进自己的 logger，我从外面看不到；但推理到底发生在
    哪一步、返回了几个字，是排查"面板没字"的唯一直接证据。
    """
    try:
        os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
        stamp = time.strftime("%H:%M:%S")
        with open(AUDIT, "a", encoding="utf-8") as f:
            f.write(f"{stamp} {msg}\n")
    except Exception:
        pass


def wav_to_float32(raw: bytes):
    """WAV 字节 → 16kHz 单声道 float32（不依赖 ffmpeg / soundfile）。"""
    import numpy as np

    with wave.open(io.BytesIO(raw), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())

    if width == 2:
        x = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        x = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        x = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported sample width: {width * 8}bit")

    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)

    # DSH 保证送 16kHz；万一不是，用 scaler 兜一层
    if rate != 16000:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(16000, rate)
        x = resample_poly(x, 16000 // g, rate // g).astype(np.float32)
        log(f"resampled {rate}Hz → 16000Hz")

    import numpy as np

    return np.ascontiguousarray(x, dtype=np.float32)


def main() -> int:
    model_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    model_path = os.path.expanduser(model_path)
    if not os.path.isdir(model_path):
        log(f"模型目录不存在：{model_path}")
        return 2

    # 把 import / 模型加载期间的一切 stdout 赶到 stderr，保住协议通道干净
    proto = sys.stdout
    sys.stdout = sys.stderr

    t0 = time.time()
    log(f"加载模型 {os.path.basename(model_path)} …")
    from mlx_audio.stt import load as load_model
    import numpy as np

    model = load_model(model_path)
    # 预热：Metal kernel 只编译一次，别让第一条语音多等
    try:
        model.generate(np.zeros(16000, dtype=np.float32), language="Chinese", verbose=False)
    except Exception as e:  # 预热失败不影响后续请求
        log(f"预热失败（忽略）：{type(e).__name__}: {e}")
    load_ms = int((time.time() - t0) * 1000)

    sys.stdout = proto
    print(json.dumps({"type": "ready", "loadMs": load_ms, "model": model_path}), flush=True)
    log(f"就绪（{load_ms}ms）")
    audit(f"=== worker ready pid={os.getpid()} model={model_path} load={load_ms}ms ===")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            log(f"请求不是合法 JSON：{e}")
            continue

        rid = req.get("id")
        if req.get("type") == "ping":
            print(json.dumps({"id": rid, "text": "", "pong": True}), flush=True)
            continue

        try:
            language = LANG_MAP.get(req.get("language") or "auto", req.get("language") or None)
            if language == "auto":
                language = None
            raw_wav = base64.b64decode(req["wav"])
            audio = wav_to_float32(raw_wav)
            if audio.size == 0:
                raise ValueError("empty audio")
            import numpy as _np
            level = float(_np.sqrt(_np.mean(audio.astype(_np.float64) ** 2)))
            peak = float(_np.abs(audio).max())
            hotwords = req.get("hotwords")
            if not isinstance(hotwords, list) or not hotwords:
                hotwords = HOTWORDS
            t1 = time.time()
            res = model.generate(
                audio,
                language=language,
                verbose=False,
                hotwords=list(hotwords),
            )
            raw_text = (getattr(res, "text", "") or "").strip()
            text, hits = apply_fixes(raw_text)
            # 纯语气词当噪声丢掉：实测呼吸/空调会被识别成「嗯。」「啊。」
            core = "".join(ch for ch in text if ch not in "，。、；：！？… ")
            if core and len(core) <= 2 and all(ch in "嗯哦啊呃唉额噢呀哈" for ch in core):
                audit(f"drop-filler {text!r}")
                print(json.dumps({"id": rid, "text": "", "ms": 0, "audioSec": round(audio.size / 16000.0, 3)}, ensure_ascii=False), flush=True)
                continue
            audit(
                f"wav={len(raw_wav)}B dur={audio.size / 16000:.2f}s "
                f"rms={level:.4f} peak={peak:.3f} lang={language} "
                f"-> {len(text)}chars {(time.time() - t1):.2f}s | {text[:30]!r}"
                + (f" | fixed={hits}" if hits else "")
            )
            print(json.dumps(
                {
                    "id": rid,
                    "text": text,
                    "ms": int((time.time() - t1) * 1000),
                    "audioSec": round(audio.size / 16000.0, 3),
                },
                ensure_ascii=False,
            ), flush=True)
        except Exception as e:
            audit(f"ERROR {type(e).__name__}: {e}")
            print(json.dumps(
                {"id": rid, "error": f"{type(e).__name__}: {e}"},
                ensure_ascii=False,
            ), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
