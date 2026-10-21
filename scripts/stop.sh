#!/usr/bin/env bash
# Stop the adapter, the battle service, Arena Setup, Mission Control (if started by start.sh) and Hermes.
#   scripts/stop.sh           stop everything
#   scripts/stop.sh --keep-hermes
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for name in adapter battle arena-setup mc-open mission-control; do
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

# Mission Control's server can outlive its launcher shell: stop whatever of ours still holds its port.
for pid in $(lsof -tiTCP:"${MC_INTERNAL_PORT:-3011}" -sTCP:LISTEN 2>/dev/null); do
  if [[ "$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | tail -1)" == "n$ROOT/vendor/mission-control"* ]]; then
    kill "$pid" 2>/dev/null && echo "stopped mission-control server"
  fi
done

if [[ "${1:-}" != "--keep-hermes" && -d vendor/hermes-synapse ]]; then
  docker compose -p outpostzero -f vendor/hermes-synapse/docker-compose.yml -f infra/hermes.override.yml stop >/dev/null 2>&1 && echo "stopped Hermes"
fi
