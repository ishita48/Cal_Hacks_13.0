#!/usr/bin/env bash
# Start HAVEN for development on macOS/Linux: the world-state service on :8000 and the Vite app on :5173.
# Usage: scripts/dev.sh   (Ctrl+C stops both)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$root/backend/.venv" ] || (cd "$root/backend" && uv sync)
[ -d "$root/frontend/node_modules" ] || (cd "$root/frontend" && npm install)
(cd "$root/backend" && uv run uvicorn haven.api.app:create_app --factory --port 8000) &
backend=$!
(cd "$root/frontend" && npm run dev) &
frontend=$!
trap 'kill $backend $frontend 2>/dev/null' EXIT INT TERM
echo "HAVEN: backend http://localhost:8000/api/health · dashboard http://localhost:5173 · phone /phone · story /story"
echo "Keys (all optional) go in backend/.env; see backend/.env.example and the README."
wait
