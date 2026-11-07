#!/usr/bin/env bash
# Measure memory and cold start of N LearnHarness standalone servers, each with its own data folder.
# Usage: measure.sh <repo> <count> <base_port>
set -u
REPO="$1"; COUNT="$2"; BASE="$3"
WORK="$(dirname "$0")/tenants-$COUNT"
rm -rf "$WORK"; mkdir -p "$WORK"
SA="$REPO/.next/standalone"
cp -r "$REPO/.next/static" "$SA/.next/static" 2>/dev/null || true
cp -r "$REPO/public" "$SA/public" 2>/dev/null || true

rss_tree_kb() { # sum RSS of a pid and its children
  local pid=$1; local total=0
  for p in $pid $(pgrep -P "$pid"); do
    local r; r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null || echo 0); total=$((total + ${r:-0}))
  done; echo $total
}

PIDS=()
for i in $(seq 1 "$COUNT"); do
  PORT=$((BASE + i)); mkdir -p "$WORK/t$i"; echo '{}' > "$WORK/t$i-auth.json"; chmod 600 "$WORK/t$i-auth.json"
  start=$(date +%s%N)
  ( cd "$SA" && NODE_ENV=production PORT=$PORT HOSTNAME=127.0.0.1 NEXT_TELEMETRY_DISABLED=1 \
      LH_DATA_DIR="$WORK/t$i" LH_AUTH_FILE="$WORK/t$i-auth.json" LH_IGNORE_ENV_KEYS=1 \
      exec node server.js > "$WORK/t$i.log" 2>&1 ) &
  PIDS+=($!)
  for _ in $(seq 1 300); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/" || true)
    [ "$code" = "200" ] && break; sleep 0.1
  done
  end=$(date +%s%N)
  echo "tenant $i: first page HTTP $code after $(( (end - start) / 1000000 )) ms"
done

sleep 3
total=0
for idx in "${!PIDS[@]}"; do r=$(rss_tree_kb "${PIDS[$idx]}"); total=$((total + r)); echo "tenant $((idx+1)) idle RSS: $((r/1024)) MB"; done
echo "TOTAL idle RSS for $COUNT: $((total/1024)) MB"

# Warm each server: pages and read-only API routes a student session touches.
for i in $(seq 1 "$COUNT"); do
  PORT=$((BASE + i))
  for path in / /settings /api/graph /api/chats /api/settings /api/models /api/graph/status /api/jobs /api/graph/costs; do
    curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$PORT$path" || true
  done
done
sleep 3
total=0
for idx in "${!PIDS[@]}"; do r=$(rss_tree_kb "${PIDS[$idx]}"); total=$((total + r)); echo "tenant $((idx+1)) warm RSS: $((r/1024)) MB"; done
echo "TOTAL warm RSS for $COUNT: $((total/1024)) MB"

# Isolation sanity check: each server wrote only into its own folder.
for i in $(seq 1 "$COUNT"); do echo "t$i files: $(find "$WORK/t$i" -type f | wc -l)"; done | head -3

for p in "${PIDS[@]}"; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done
wait 2>/dev/null
