#!/bin/bash
# Sweep shared_down_proj (hy3_tp8_shared_down_proj_m16, M16 N4096 K192) on idle GPUs.
# Goal: check whether the recorded 8.671us (worker accepted median) is credible.
set -u
WS=/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718
OUT=/root/zth_agent/MetaInfer/nodes/worker29/workspaces/hy3-dsh-tp8-m16-9-8-0161e718/diag_down_proj_sweep.log
: > "$OUT"

bench_once () {  # $1=root $2=gpu
  local root=$1 gpu=$2
  cd "$root/source" || return 1
  env HIP_VISIBLE_DEVICES="$gpu" MAX_JOBS=2 PYTHONDONTWRITEBYTECODE=1 \
      PYTORCH_ROCM_ARCH=gfx928 \
      TORCH_EXTENSIONS_DIR="$root/cache/torch" TRITON_CACHE_DIR="$root/cache/triton" \
      XDG_CACHE_HOME="$root/cache/xdg" TMPDIR="$root/cache/tmp" \
      python3 "$root/source/w8a8_bench.py" --source "$root/source" \
        --m 16 --n 4096 --k 192 --reference-cache-dir "$root/cache/references" 2>&1 \
    | python3 -c '
import sys,json
for line in sys.stdin:
    line=line.strip()
    if line.startswith("{"):
        d=json.loads(line)
        print("%.3f %.3f %.3f %s" % (d["median_us"], d["min_us"], d["p90_us"], d.get("passed")))
'
}

for gpu in 0 1; do
  for spec in "workers/worker_3:worker" "final:final"; do
    root="$WS/${spec%%:*}"; label="${spec##*:}"
    for i in 1 2 3 4; do
      res=$(bench_once "$root" "$gpu")
      echo "gpu$gpu $label run$i : $res" | tee -a "$OUT"
    done
  done
done

echo | tee -a "$OUT"
python3 - "$OUT" <<'EOF' | tee -a "$OUT"
import sys,collections,statistics
groups=collections.defaultdict(list); groupsP=collections.defaultdict(list)
for line in open(sys.argv[1]):
    parts=line.split()
    if len(parts)<6 or not parts[0].startswith('gpu'): continue
    key=(parts[0],parts[1]); groups[key].append(float(parts[3])); groupsP[key].append(float(parts[4]))
print(f"{'group':22s} {'n':>2s} {'median_of_medians':>17s} {'best_median':>12s} {'worst':>8s} {'best_min':>9s}")
for k in sorted(groups):
    v=groups[k]
    print(f"{k[0]+' '+k[1]:22s} {len(v):>2d} {statistics.median(v):>17.3f} {min(v):>12.3f} {max(v):>8.3f} {min(groupsP[k]):>9.3f}")
EOF
echo "RECORDED worker accepted: median 8.671us / min 7.484us / p90 9.144us ; Triton baseline 17.312us"
