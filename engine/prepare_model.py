#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按镜像源下载 Qwen3-ASR 模型。

插件本身不打包模型，这一步由用户自己跑；脚本只负责"按你选的源、用正确的仓库 id、
下到正确的位置"。

用法：
    # 国内默认：魔搭（CSDN 系 CDN，实测 17 MB/s）
    python3 prepare_model.py

    # 其他源
    python3 prepare_model.py --source hf-mirror
    python3 prepare_model.py --source hf

    # 只下某几个文件（自检/补文件）
    python3 prepare_model.py --include config.json --include tokenizer_config.json

    # Windows 的 CUDA 后端要用 HF 原始格式（4.1GB），不是 MLX 量化版
    python3 prepare_model.py --flavor hf
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

# 各镜像上的仓库 id 是一样的（魔搭完整镜像了 HF 的社区仓库）
REPOS = {
    # MLX 8bit 量化版：macOS Apple Silicon，2.47GB
    "mlx": "mlx-community/Qwen3-ASR-1.7B-8bit",
    # HF 原始格式：Windows/Linux 的 torch / transformers 后端，4.09GB
    "hf": "Qwen/Qwen3-ASR-1.7B-hf",
}

SOURCES = {
    "modelscope": {
        "label": "魔搭 ModelScope（国内推荐）",
        "endpoint": None,  # 用 modelscope 自己的 SDK
        "hint": "无需额外安装（走魔搭直链）",
    },
    "hf-mirror": {
        "label": "hf-mirror.com（海外站点的国内镜像）",
        "endpoint": "https://hf-mirror.com",
        "hint": "pip install huggingface_hub",
    },
    "hf": {
        "label": "HuggingFace 官方（海外）",
        "endpoint": "https://huggingface.co",
        "hint": "pip install huggingface_hub",
    },
}


def default_dest(repo_id: str) -> str:
    return os.path.expanduser(os.path.join("~", "models", repo_id.split("/")[-1]))


MODELSCOPE_API = "https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master&Recursive=true"
MODELSCOPE_FILE = "https://modelscope.cn/models/{repo}/resolve/master/{path}"


def modelscope_list(repo_id: str) -> list[tuple[str, int]]:
    """列出仓库里的文件（魔搭的公开 API，不需要 token）。"""
    with urllib.request.urlopen(MODELSCOPE_API.format(repo=repo_id), timeout=30) as response:
        payload = json.load(response)
    files = (payload.get("Data") or {}).get("Files") or []
    out = []
    for item in files:
        path = item.get("Path")
        size = int(item.get("Size") or 0)
        if path and item.get("Type", "blob") != "tree":
            out.append((path, size))
    return out


def download_modelscope(repo_id: str, dest: str, include: list[str] | None) -> str:
    """纯 HTTP 下载，不需要 modelscope SDK。

    优先用官方 SDK（有断点续传和完整性校验），没装就自己走 resolve 直链——
    实测国内 17 MB/s，装个 SDK 反而是多余依赖。
    """
    try:
        from modelscope import snapshot_download  # type: ignore
        print("· 使用 modelscope SDK")
        return snapshot_download(repo_id, local_dir=dest, allow_file_pattern=include or None)
    except ImportError:
        pass

    print("· 使用魔搭直链（无需安装 modelscope）")
    entries = modelscope_list(repo_id)
    if include:
        import fnmatch
        entries = [
            (p, n) for p, n in entries
            if any(fnmatch.fnmatch(os.path.basename(p), token) for token in include)
        ]
    if not entries:
        raise RuntimeError("仓库里没匹配到文件")

    os.makedirs(dest, exist_ok=True)
    total = sum(size for _p, size in entries)
    done = 0
    for path, size in entries:
        target = os.path.join(dest, path)
        os.makedirs(os.path.dirname(target) or dest, exist_ok=True)
        if os.path.exists(target) and os.path.getsize(target) == size:
            done += size
            print(f"  = {path}（已存在）")
            continue
        url = MODELSCOPE_FILE.format(repo=repo_id, path=path)
        with urllib.request.urlopen(url, timeout=60) as response, open(target, "wb") as handle:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                handle.write(chunk)
                done += len(chunk)
                if size > 50_000_000:
                    pct = done / max(1, total) * 100
                    print(f"\r  {pct:5.1f}%  {done / 1e6:8.1f} / {total / 1e6:.1f} MB  {path}", end="", file=sys.stderr)
        if size > 50_000_000:
            print("", file=sys.stderr)
        print(f"  + {path}（{size / 1e6:.1f} MB）")
    return dest


def download_hf(repo_id: str, dest: str, include: list[str] | None, endpoint: str) -> str:
    os.environ["HF_ENDPOINT"] = endpoint
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # 镜像站常常不支持 xet 传输
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except ImportError:
        print("× 没装 huggingface_hub。先执行：", file=sys.stderr)
        print("    pip install huggingface_hub", file=sys.stderr)
        raise SystemExit(3)
    return snapshot_download(repo_id, local_dir=dest, allow_patterns=include or None)


def main() -> int:
    parser = argparse.ArgumentParser(description="按镜像源下载 Qwen3-ASR 模型")
    parser.add_argument("--source", choices=sorted(SOURCES), default="modelscope",
                        help="模型来源（默认魔搭）")
    parser.add_argument("--flavor", choices=sorted(REPOS), default="mlx",
                        help="mlx=Apple Silicon 量化版；hf=torch/onnx 用的原始格式")
    parser.add_argument("--dest", default=None, help="目标目录（默认 ~/models/<仓库名>）")
    parser.add_argument("--include", action="append", default=None,
                        help="只下匹配的文件（可重复）")
    args = parser.parse_args()

    repo_id = REPOS[args.flavor]
    dest = os.path.abspath(os.path.expanduser(args.dest or default_dest(repo_id)))
    source = SOURCES[args.source]

    print(f"仓库   {repo_id}")
    print(f"来源   {source['label']}")
    print(f"目标   {dest}")
    if args.include:
        print(f"仅下载 {args.include}")
    print()

    try:
        if args.source == "modelscope":
            path = download_modelscope(repo_id, dest, args.include)
        else:
            path = download_hf(repo_id, dest, args.include, source["endpoint"] or "https://huggingface.co")
    except SystemExit:
        raise
    except Exception as error:  # 网络/鉴权/磁盘
        print(f"× 下载失败：{type(error).__name__}: {error}", file=sys.stderr)
        print(f"  可以换一个源再试：--source {', '.join(s for s in SOURCES if s != args.source)}", file=sys.stderr)
        return 4

    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    print(f"\n✓ 完成：{path}（{total / 1e9:.2f} GB）")
    print("  插件默认读 ~/models/ 下的同名目录；放在别处就用 LIVE_STT_MODEL 指定。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
