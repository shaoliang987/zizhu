#!/usr/bin/env bash
# Pair stats loop — runs report every STATS_INTERVAL_SEC (default 2h).
# Usage:
#   ./scripts/stats-loop.sh start   # start background loop
#   ./scripts/stats-loop.sh stop    # stop loop
#   ./scripts/stats-loop.sh status  # show status
#   ./scripts/stats-loop.sh once    # run one report now

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/logs/stats-loop.pid"
LOG_FILE="$ROOT/logs/stats-loop.log"
INTERVAL="${STATS_INTERVAL_SEC:-7200}"

# Guard against empty/non-numeric interval (was flooding the log with sleep errors).
if ! [[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid STATS_INTERVAL_SEC='$INTERVAL' (need positive integer); using 7200" >&2
  INTERVAL=7200
fi

run_once() {
  cd "$ROOT"
  node scripts/pair-stats-report.js >> "$LOG_FILE" 2>&1
}

loop_body() {
  echo "[$(date -Iseconds)] stats loop started interval=${INTERVAL}s root=${ROOT}" >> "$LOG_FILE"
  while true; do
    sleep "$INTERVAL"
    echo "[$(date -Iseconds)] stats loop tick" >> "$LOG_FILE"
    run_once || echo "[$(date -Iseconds)] stats loop error" >> "$LOG_FILE"
  done
}

rotate_log_if_huge() {
  # Cap runaway logs from older broken loops (~>50MB).
  if [[ -f "$LOG_FILE" ]]; then
    local bytes
    bytes=$(wc -c < "$LOG_FILE" | tr -d ' ')
    if [[ "$bytes" -gt 52428800 ]]; then
      mv "$LOG_FILE" "${LOG_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
      echo "[$(date -Iseconds)] rotated oversized stats-loop.log (${bytes} bytes)" > "$LOG_FILE"
    fi
  fi
}

case "${1:-status}" in
  _loop)
    # Internal: background entry (vars must already be in env).
    ROOT="${ROOT:?}"
    LOG_FILE="${LOG_FILE:?}"
    INTERVAL="${INTERVAL:?}"
    loop_body
    ;;
  start)
    mkdir -p "$ROOT/logs" "$ROOT/data/reports/history"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "stats loop already running pid=$(cat "$PID_FILE")"
      exit 0
    fi
    rotate_log_if_huge
    run_once
    # Re-exec this script so ROOT/LOG_FILE/INTERVAL are real env vars (not lost via declare -f).
    nohup env ROOT="$ROOT" LOG_FILE="$LOG_FILE" INTERVAL="$INTERVAL" \
      bash "$ROOT/scripts/stats-loop.sh" _loop >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "stats loop started pid=$(cat "$PID_FILE") interval=${INTERVAL}s"
    echo "report: $ROOT/data/reports/pair-stats-latest.md"
    ;;
  stop)
    if [[ -f "$PID_FILE" ]]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stats loop stopped"
    else
      echo "not running"
    fi
    # Also kill any orphaned broken loop that still sleeps with empty interval.
    pkill -f "stats-loop.sh _loop" 2>/dev/null || true
    ;;
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PID_FILE") interval=${INTERVAL}s"
      [[ -f "$ROOT/data/reports/pair-stats-latest.md" ]] && tail -n 12 "$ROOT/data/reports/pair-stats-latest.md"
    else
      echo "not running"
    fi
    ;;
  once)
    mkdir -p "$ROOT/logs" "$ROOT/data/reports/history"
    run_once
    cat "$ROOT/data/reports/pair-stats-latest.md"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|once}"
    exit 1
    ;;
esac
