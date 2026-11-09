#!/usr/bin/env bash
# X5 spike: pass SSE streams from tenant servers through a Next.js 16 front door.
# Usage: bash run.sh <repo>   (after `npm run build && node scripts/build-server.mjs` in <repo>)
# Builds a throwaway front door in <repo>/.spike-x5, runs the tests, then removes it.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$1" && pwd)"
APP="$REPO/.spike-x5"
WORK="$(mktemp -d)"
rm -rf "$APP"; mkdir -p "$APP/app/rh/[...path]"
cp "$SRC/fd-server.mjs" "$APP/server.mjs"
cp "$SRC/fd-proxy.js" "$APP/proxy.js"
cp "$SRC/fd-route.js" "$APP/app/rh/[...path]/route.js"
cp "$SRC/fd-layout.jsx" "$APP/app/layout.jsx"
cp "$SRC/fd-page.jsx" "$APP/app/page.jsx"
echo 'export default {};' > "$APP/next.config.mjs"
( cd "$APP" && NEXT_TELEMETRY_DISABLED=1 "$REPO/node_modules/.bin/next" build > "$WORK/fd-build.log" 2>&1 ) || { echo "front door build failed"; tail -30 "$WORK/fd-build.log"; exit 1; }

wait_for() { for _ in $(seq 1 100); do curl -s -o /dev/null --noproxy '*' "$1" && return 0; sleep 0.1; done; echo "not ready: $1"; return 1; }

mkdir -p "$WORK/t1"; echo '{}' > "$WORK/t1-auth.json"; chmod 600 "$WORK/t1-auth.json"
( cd "$REPO/.next/standalone" && NODE_ENV=production PORT=4201 HOSTNAME=127.0.0.1 NEXT_TELEMETRY_DISABLED=1 \
    LH_DATA_DIR="$WORK/t1" LH_AUTH_FILE="$WORK/t1-auth.json" LH_IGNORE_ENV_KEYS=1 exec node server.js > "$WORK/t1.log" 2>&1 ) &
P1=$!
node "$SRC/tenant-synthetic.mjs" 4202 & P2=$!
( cd "$APP" && NODE_ENV=production PORT=4100 NEXT_TELEMETRY_DISABLED=1 exec node server.mjs > "$WORK/fd.log" 2>&1 ) &
P3=$!
wait_for http://127.0.0.1:4201/ && wait_for http://127.0.0.1:4100/ || { tail "$WORK"/*.log; kill $P1 $P2 $P3; exit 1; }
sleep 0.5

echo "== Synthetic tenant: 25 frames, one every 200 ms"
for q in "" "?plain=1"; do
  node "$SRC/client-sse.mjs" "http://127.0.0.1:4202/sse$q" "direct$q"
  node "$SRC/client-sse.mjs" "http://127.0.0.1:4100/t/4202/sse$q" "custom-server$q"
  node "$SRC/client-sse.mjs" "http://127.0.0.1:4100/rh/4202/sse$q" "route-handler$q"
  node "$SRC/client-sse.mjs" "http://127.0.0.1:4100/px/4202/sse$q" "proxy-rewrite$q"
done
echo "== LearnHarness tenant: GET /api/events, 10 session creates"
node "$SRC/client-events.mjs" "http://127.0.0.1:4201/api/events" http://127.0.0.1:4201 10 direct
node "$SRC/client-events.mjs" "http://127.0.0.1:4100/t/4201/api/events" http://127.0.0.1:4201 10 custom-server
node "$SRC/client-events.mjs" "http://127.0.0.1:4100/rh/4201/api/events" http://127.0.0.1:4201 10 route-handler
node "$SRC/client-events.mjs" "http://127.0.0.1:4100/px/4201/api/events" http://127.0.0.1:4201 10 proxy-rewrite
echo "== LearnHarness page and POST through the custom server"
curl -s -o /dev/null --noproxy '*' -w 'GET / via custom server: HTTP %{http_code}, %{size_download} bytes, %{time_total} s\n' http://127.0.0.1:4100/t/4201/
curl -s -o /dev/null --noproxy '*' -X POST -H 'Content-Type: application/json' -d '{"title":"via front door"}' \
  -w 'POST /api/chats via custom server: HTTP %{http_code}, %{time_total} s\n' http://127.0.0.1:4100/t/4201/api/chats
echo "front door memory (RSS) after the run: $(( $(awk '/VmRSS/{print $2}' /proc/$P3/status) / 1024 )) MB"

kill $P1 $P2 $P3 2>/dev/null; wait 2>/dev/null
rm -rf "$APP" "$WORK"
