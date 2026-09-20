#!/bin/bash
# Verify the recorded 8.67us for hy3_tp8_shared_down_proj_m16 (shape M16 N4096 K192).
# Same protocol as the worker acceptance bench: warmups=100 samples=30 replays=100,
# correctness checked against the cached exact int64 reference.
set -u
WS=/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718
GPU=${GPU:-1}
REPEAT=${REPEAT:-2}

bench () {
  local root=$1 label=$2
  cd "$root/source" || return 1
  env HIP_VISIBLE_DEVICES="$GPU" MAX_JOBS=2 PYTHONDONTWRITEBYTECODE=1 \
      PYTORCH_ROCM_ARCH=gfx928 \
      TORCH_EXTENSIONS_DIR="$root/cache/torch" \
      TRITON_CACHE_DIR="$root/cache/triton" \
      XDG_CACHE_HOME="$root/cache/xdg" \
      TMPDIR="$root/cache/tmp" \
      python3 "$root/source/w8a8_bench.py" --source "$root/source" \
        --m 16 --n 4096 --k 192 \
        --reference-cache-dir "$root/cache/references" 2>&1 | tail -3
}

for i in $(seq 1 "$REPEAT"); do
  echo "########## run $i on GPU$GPU ##########"
  for spec in "workers/worker_3:WORKER_3-accepted-build" "final:FINAL-synthesized-build"; do
    root="$WS/${spec%%:*}"; label="${spec##*:}"
    echo "=== $label (run $i) ==="
    bench "$root" "$label" | python3 -c '
import sys,json
for line in sys.stdin:
    line=line.strip()
    if not line.startswith("{"): continue
    d=json.loads(line)
    print("median_us=%.3f min_us=%.3f p90_us=%.3f samples=%s passed=%s ref_cache_hit=%s tops=%.2f bw=%.1f GB/s" % (
        d["median_us"], d["min_us"], d["p90_us"], d.get("samples"), d.get("passed"),
        d.get("reference_cache_hit"), d["logical_tops"], d["algorithmic_bandwidth_gb_s"]))
'
  done
done
