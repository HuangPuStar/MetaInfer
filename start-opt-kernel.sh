#!/usr/bin/env bash
# opt-kernel 一键启动脚本（后台运行）
# 用法:
#   bash /tmp/MetaInfer/start-opt-kernel.sh          # 启动（后台）
#   bash /tmp/MetaInfer/start-opt-kernel.sh status   # 查看状态
#   bash /tmp/MetaInfer/start-opt-kernel.sh stop      # 停止
#   bash /tmp/MetaInfer/start-opt-kernel.sh logs      # 查看最近日志
#
# 服务以 nohup 后台运行，SSH 断开不会停。
# PID 文件: /tmp/MetaInfer/logs/webui.pid
# 日志文件: /tmp/MetaInfer/logs/webui.log

set -e
cd /tmp/MetaInfer

LOG_DIR=/tmp/MetaInfer/logs
PID_FILE=$LOG_DIR/webui.pid
LOG_FILE=$LOG_DIR/webui.log
PORT=${METAINFER_PORT:-8765}
HOST=${METAINFER_HOST:-0.0.0.0}
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# 子命令: stop / status / logs（不跑 pip install / GPU 检测，直接处理）
# ---------------------------------------------------------------------------
case "${1:-start}" in
  stop)
    if [[ -f "$PID_FILE" ]]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" && echo "已停止 WebUI (pid=$PID)"
        pkill -f "metainfer-web" 2>/dev/null || true
        pkill -f "uvicorn.*metainfer" 2>/dev/null || true
      else
        echo "PID $PID 已不在运行"
      fi
      rm -f "$PID_FILE"
    else
      echo "未发现 PID 文件，尝试按进程名清理"
      pkill -f "metainfer-web" 2>/dev/null && echo "已清理 metainfer-web 进程" || true
    fi
    exit 0
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "WebUI 运行中 (pid=$(cat "$PID_FILE"), 端口=$PORT)"
      echo "  本机访问: http://localhost:$PORT"
      echo "  日志:     tail -f $LOG_FILE"
      exit 0
    else
      rm -f "$PID_FILE" 2>/dev/null || true
      echo "WebUI 未运行"
      exit 1
    fi
    ;;
  logs)
    tail -n 100 -f "$LOG_FILE" 2>/dev/null || echo "无日志文件 $LOG_FILE"
    exit 0
    ;;
  start)
    : ;;  # 继续往下走启动流程
  *)
    echo "用法: $0 {start|stop|status|logs}" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# 启动流程（仅 start 走这里）
# ---------------------------------------------------------------------------
# 若已在运行，直接退出
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "WebUI 已在运行 (pid=$(cat "$PID_FILE"), 端口=$PORT)"
  echo "如需重启: $0 stop && $0 start"
  exit 0
fi

echo "=== 1. 安装 MetaInfer ==="
pip install -e . --quiet 2>&1 | tail -2

echo ""
echo "=== 2. 设置 pi backend ==="
export METAINFER_AGENT_BACKEND=pi
export METAINFER_PI_BIN=pi
echo "  METAINFER_AGENT_BACKEND=$METAINFER_AGENT_BACKEND"
echo "  METAINFER_PI_BIN=$METAINFER_PI_BIN"

echo ""
echo "=== 3. 验证 GPU 可用性 ==="
# import torch 在海光 DTK 环境首次加载需 40-60s，给足时间；-s KILL 防止 cuda 初始化 hang
timeout -s KILL 120 python3 -c "
import torch
print('  torch:', torch.__version__, 'hip:', torch.version.hip)
print('  device count:', torch.cuda.device_count())
for i in range(min(2, torch.cuda.device_count())):
    print(f'  device {i}:', torch.cuda.get_device_name(i))
" 2>&1 || echo "  ⚠ GPU 检测超时（import torch 加载 DTK 库超 120s），perf oracle 可能无法运行 benchmark"

echo ""
echo "=== 4. 验证 baseline (lmslim) 可用 ==="
timeout -s KILL 120 python3 -c "
import torch
from lmslim.layers.gemm.int8_utils import matmul_int8
x_q = torch.randint(-127,127,(1,2048),dtype=torch.int8,device='cuda')
w = torch.randint(-127,127,(2048,12288),dtype=torch.int8,device='cuda')
xs = torch.rand(1,1,dtype=torch.float32,device='cuda')*0.01+0.001
ws = torch.rand(12288,1,dtype=torch.float32,device='cuda')*0.01+0.001
out = matmul_int8(x_q, xs, w, ws, torch.bfloat16, None)
torch.cuda.synchronize()
print('  lmslim matmul_int8: OK', out.shape, out.dtype)
" 2>&1 || echo "  ⚠ lmslim 不可用或运行失败"

echo ""
echo "=== 5. 后台启动 WebUI ==="
# nohup + setsid: 脱离 SSH 会话，断开连接不会杀进程
METAINFER_HOST="$HOST" METAINFER_PORT="$PORT" \
  METAINFER_AGENT_BACKEND=pi METAINFER_PI_BIN=pi \
  setsid nohup metainfer-web >"$LOG_FILE" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" > "$PID_FILE"

# 等待端口就绪（最多 15 秒）
for i in $(seq 1 15); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "  WebUI 已就绪 (pid=$WEB_PID)"
    break
  fi
  sleep 1
  if [[ $i -eq 15 ]]; then
    echo "  ⚠ 启动超时，查看日志: tail -f $LOG_FILE"
    exit 1
  fi
done

echo ""
echo "=== 启动完成 ==="
echo "  本机访问:   http://localhost:$PORT"
echo "  服务器访问: http://<服务器IP>:$PORT"
echo "  日志:       tail -f $LOG_FILE"
echo "  停止:       bash $0 stop"
echo "  状态:       bash $0 status"
echo ""
echo "在本地电脑执行 SSH 端口转发后访问 http://localhost:$PORT ："
echo "  ssh -L $PORT:localhost:$PORT <user>@<server>"
echo "  （如有跳板机: ssh -L $PORT:localhost:$PORT -J <user>@<跳板机> <user>@<server>）"
