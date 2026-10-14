#!/usr/bin/env bash
# Stop the adapter, Mission Control (if started by start.sh) and the Hermes containers.
#   scripts/stop.sh           stop everything
#   scripts/stop.sh --keep-hermes
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for name in adapter mission-control; do
  pidfile=".data/$name.pid"
  if [[ -f $pidfile ]]; then
    pid=$(cat "$pidfile")
    # Only if that pid is still one of ours (pids are reused after a reboot or crash).
    if [[ "$(ps -o command= -p "$pid" 2>/dev/null)" == *"$ROOT"* || "$(ps -o command= -p "$pid" 2>/dev/null)" == *node* ]]; then
      pkill -TERM -P "$pid" 2>/dev/null  # the saved pid is a launcher shell; stop its children
      kill "$pid" 2>/dev/null
      echo "stopped $name"
    fi
    rm -f "$pidfile"
  fi
done

if [[ "${1:-}" != "--keep-hermes" && -d vendor/hermes-synapse ]]; then
  docker compose -p outpostzero -f vendor/hermes-synapse/docker-compose.yml -f infra/hermes.override.yml stop >/dev/null 2>&1 && echo "stopped Hermes"
fi
