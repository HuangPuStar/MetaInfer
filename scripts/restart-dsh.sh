#!/usr/bin/env bash
# Maintained copy of the operational restart helper.
# The deployed copy lives at /workspace/bin/restart-dsh.sh; keep them in sync.
# Restart the DSH web server so the patched lab plugin is loaded.
# Launched detached (setsid+nohup): it must outlive the agent session it is
# started from, because killing the server also kills that session.
set -u

LOG=/workspace/logs/dsh-restart.log
mkdir -p /workspace/logs
log() { echo "[$(date +%F_%T)] $*" >>"$LOG"; }

# Let the caller's reply reach the browser before the connection drops.
sleep "${RESTART_DELAY:-20}"

# WAIT_IDLE=1: don't kill a running experiment node. Wait (max 20 min) for the
# node worktrees to go quiet, then restart, so a code change never eats work.
if [ "${WAIT_IDLE:-0}" = "1" ]; then
  # Count node processes without pgrep matching this script's own command line
  # (the bracket keeps grep from matching itself, which made the wait hang).
  node_procs() { ps -eo args= | grep -c "[w]orktrees/prj-.*/n-[0-9]" || true; }
  for _ in $(seq 1 240); do
    [ "$(node_procs)" = "0" ] && break
    sleep 5
  done
  log "idle wait done (running node procs: $(node_procs))"
fi

OLD=$(pgrep -f "/usr/local/bin/dsh web" | head -1)
if [ -z "${OLD:-}" ]; then
  log "no running dsh web found; nothing to restart"
  exit 0
fi
CMDLINE=$(tr '\0' ' ' <"/proc/$OLD/cmdline")
log "old pid=$OLD cmd=$CMDLINE"
ENVF=/tmp/dsh-env.$$
tr '\0' '\n' <"/proc/$OLD/environ" >"$ENVF" || { log "cannot read environ"; exit 1; }

kill "$OLD" 2>>"$LOG"
for _ in $(seq 1 20); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.5; done
kill -9 "$OLD" 2>>"$LOG" || true

# A killed dsh can leave a child holding the port; starting before it is released
# makes the new process die with EADDRINUSE, which leaves the operator staring at
# "task stopped" while nothing is listening. Clear stale listeners and wait for the
# port to be actually free before the first start attempt.
if command -v ss >/dev/null 2>&1; then
  for pid in $(ss -ltnp 2>/dev/null | grep ':3081' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    [ "$pid" = "$$" ] && continue
    log "killing stale listener pid=$pid on :3081"
    kill -9 "$pid" 2>>"$LOG" || true
  done
fi
for _ in $(seq 1 40); do
  if timeout 1 bash -c 'exec 3<>/dev/tcp/172.17.0.5/3081' 2>/dev/null; then
    sleep 0.5
  else
    break
  fi
done
sleep 1

cd /
set -a
# shellcheck disable=SC1090
. "$ENVF" 2>>"$LOG"
set +a

for attempt in 1 2; do
  log "start attempt $attempt"
  setsid nohup node /usr/local/bin/dsh web --host 172.17.0.5 --port 3081 --no-open \
    --trusted-host 10.8.160.18:3081 --trusted-host 127.0.0.1:3081 \
    >>/workspace/logs/dsh-web.log 2>&1 &
  sleep 10
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://10.8.160.18:3081/ 2>/dev/null || echo 000)
  log "health check http=$CODE"
  # 401 is the expected answer for an unauthenticated root: the server is up,
  # auth is just required. Treat it as success and continue to the token probe.
  if [ "$CODE" = "200" ] || [ "$CODE" = "303" ] || [ "$CODE" = "302" ] || [ "$CODE" = "401" ]; then
    # The log keeps every historical URL; take the newest token that authenticates.
    TOK=""
    for cand in $(grep -aoE 'token=[A-Za-z0-9_-]+' /workspace/logs/dsh-web.log | tail -4 | cut -d= -f2 | tac); do
      code=$(curl -s -c /tmp/dsh-cj "http://10.8.160.18:3081/?token=$cand" -o /dev/null -w '%{http_code}')
      if [ "$code" = "303" ] || [ "$code" = "302" ] || [ "$code" = "200" ]; then TOK="$cand"; break; fi
    done
    # The plugin API authenticates with the operator token the Host injects into
    # index.html; the cookie alone answers 401. Read it from the page we just
    # authenticated with, then send it as a header on every API call below.
    OPTOK=""
    # The plugin registers its index-inject handler asynchronously, so the token can
    # be absent for a few seconds after boot. Retry instead of failing the resume.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      OPTOK=$(curl -s -b /tmp/dsh-cj "http://10.8.160.18:3081/" \
        | grep -o 'mir-operator\.[A-Za-z0-9._-]*' | head -1)
      [ -n "$OPTOK" ] && break
      sleep 3
    done
    log "operator token ${OPTOK:0:16}..."
    PLUG=$(curl -s -b /tmp/dsh-cj -H "x-metainfer-operator: $OPTOK" -o /dev/null -w '%{http_code}' "http://10.8.160.18:3081/api/metainfer-research-lab/health")
    PBODY=$(curl -s -b /tmp/dsh-cj "http://10.8.160.18:3081/api/metainfer-research-lab/health" -o /tmp/plugin-health.json -w '%{http_code}')
    log "plugin health http=$PBODY body=$(head -c 200 /tmp/plugin-health.json 2>/dev/null)"
    # The driver is never resumed automatically: a restart must not kick off
    # experiments on its own. The plugin pauses auto after a host restart by
    # design, and resuming is an explicit operator action.
    TR=$(curl -s -b /tmp/dsh-cj -H "x-metainfer-operator: $OPTOK" "http://10.8.160.18:3081/api/metainfer-research-lab/traces" -o /tmp/traces.json -w '%{http_code}')
    log "profiler traces http=$TR body=$(head -c 120 /tmp/traces.json 2>/dev/null)"
    PTR=$(curl -s -b /tmp/dsh-cj -H "x-metainfer-operator: $OPTOK" -o /tmp/trace-index.json -w '%{http_code}' \
      "http://10.8.160.18:3081/api/metainfer-research-lab/trace?view=nodes&projectId=${PROJECT_ID:-prj-eb229127}")
    log "trace index http=$PTR body=$(head -c 200 /tmp/trace-index.json 2>/dev/null)"
    log "restart OK (token=${TOK:0:8}...)"; rm -f "$ENVF"; exit 0
  fi
  sleep 3
done
log "restart FAILED — see /workspace/logs/dsh-web.log"
rm -f "$ENVF"
