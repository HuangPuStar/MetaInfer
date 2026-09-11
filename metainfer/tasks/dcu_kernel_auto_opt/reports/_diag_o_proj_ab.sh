#!/bin/bash
# A/B diagnostic for the 9.8 run o_proj gate failure (worker build vs final build).
set -u
WS=/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718
GPU=${GPU:-1}

run_bench () {
  local root=$1 label=$2
  echo "=== $label ==="
  echo "root=$root gpu=$GPU"
  cd "$root/source" || return 1
  env HIP_VISIBLE_DEVICES="$GPU" MAX_JOBS=2 PYTHONDONTWRITEBYTECODE=1 \
      PYTORCH_ROCM_ARCH=gfx928 \
      TORCH_EXTENSIONS_DIR="$root/cache/torch" \
      TRITON_CACHE_DIR="$root/cache/triton" \
      XDG_CACHE_HOME="$root/cache/xdg" \
      TMPDIR="$root/cache/tmp" \
      python3 "$root/source/w8a8_bench.py" --source "$root/source" \
        --m 16 --n 4096 --k 1024 \
        --reference-cache-dir "$root/cache/references" 2>&1 | tail -20
}

run_bench "$WS/workers/worker_1" "WORKER_1 explore-time build (bench target of 11.044us)"
run_bench "$WS/final" "FINAL synthesized prebuilt-object build (gate measured 11.745us)"
