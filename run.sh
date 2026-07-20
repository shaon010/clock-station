#!/usr/bin/env bash
# Clock Dock — restart the server: force-kill any running instance, then start fresh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8080}"
LOG_FILE="server.log"

echo "Stopping any running Clock Dock instance..."

# Kill whatever is bound to the port.
PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill -9 $PIDS 2>/dev/null || true
  echo "  killed pid(s) on port $PORT: $PIDS"
fi

# Belt-and-suspenders: kill by process name too.
pkill -9 -f "node server/server.js" 2>/dev/null || true

sleep 1

echo "Starting Clock Dock..."
nohup node server/server.js >"$LOG_FILE" 2>&1 &
disown

echo "  started with pid $!"
echo "  logs: $LOG_FILE"
sleep 1
tail -n 20 "$LOG_FILE" || true
