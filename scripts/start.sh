#!/usr/bin/env bash
# Start Outpost Zero: Hermes (Docker), Mission Control, the adapter, then the game.
#   scripts/start.sh            full stack with real agents
#   scripts/start.sh --fake     scripted demo missions (no Hermes, no LLM); Mission Control optional
#   scripts/start.sh --no-game  services only (open the game yourself: godot --path game)
#   scripts/start.sh --classic  Open RTS, the original deathmatch: no services, just the game
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p .data/logs

FAKE=0
GAME=1
for arg in "$@"; do
  case "$arg" in
    --fake) FAKE=1 ;;
    --no-game) GAME=0 ;;
    --classic)
      # Open RTS needs no agents, adapter or model (docs/open-rts-mode.md).
      mkdir -p .data/logs
      nohup godot --path game -- --mode=open-rts < /dev/null > .data/logs/game.log 2>&1 &
      disown
      echo "Open RTS launched (the original deathmatch; switch back from its main menu)."
      exit 0 ;;
    *) echo "unknown option $arg"; exit 1 ;;
  esac
done

[[ -f .env ]] || scripts/gen-env.sh
# infra/hermes.env holds your Hermes settings (and any API key); it is created from the
# tracked example and stays out of git.
[[ -f infra/hermes.env ]] || cp infra/hermes.env.example infra/hermes.env
grep -q '^ARENA_TOKEN=' .env || { echo "ARENA_TOKEN=$(openssl rand -hex 16)" >> .env; echo "  added ARENA_TOKEN to .env"; }
set -a; source .env; set +a
HERMES_URL=${HERMES_URL:-http://127.0.0.1:8101}
MC_URL=${MC_URL:-http://127.0.0.1:3001}
ADAPTER_PORT=${ADAPTER_PORT:-8771}

listening() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_of() { echo "$1" | sed -E 's#.*:([0-9]+).*#\1#'; }
wait_http() { # url, name, seconds, [header]
  local i
  for ((i = 0; i < $3; i++)); do
    if curl -sf -m 3 ${4:+-H "$4"} "$1" >/dev/null 2>&1; then echo "  $2 ready"; return 0; fi
    sleep 1
  done
  echo "  $2 did not come up (see .data/logs)"; return 1
}

if [[ $FAKE == 0 ]]; then
  echo "==> Hermes Synapse"
  cp infra/hermes.env vendor/hermes-synapse/.env
  docker compose -p outpostzero -f vendor/hermes-synapse/docker-compose.yml -f infra/hermes.override.yml up -d \
    > .data/logs/compose.log 2>&1 || { cat .data/logs/compose.log; exit 1; }
  wait_http "$HERMES_URL/api/status" "Hermes" 120
  if grep -vE '^\s*(#|$)' infra/hermes.env | grep -q 'host.docker.internal:11434'; then
    models=$(ollama list 2>/dev/null || true)
    [[ "$models" == *agentrts-qwen3* ]] || echo "  warning: Ollama model agentrts-qwen3 missing (run scripts/setup.sh)"
  fi
fi

echo "==> Mission Control"
if listening "$(port_of "$MC_URL")"; then
  echo "  already running on $MC_URL"
elif [[ $FAKE == 1 && ! -f vendor/mission-control/.next/standalone/server.js ]]; then
  echo "  not built; skipped in demo mode (run scripts/setup.sh to add it)"
else
  # Production build (dev mode shows React/CSP debug overlays); build once if missing.
  if [[ ! -f vendor/mission-control/.next/standalone/server.js ]]; then
    echo "  building Mission Control (first run, a few minutes)…"
    (cd vendor/mission-control && pnpm build > "$ROOT/.data/logs/mc-build.log" 2>&1) || { echo "  build failed, see .data/logs/mc-build.log"; exit 1; }
  fi
  (cd vendor/mission-control && HOSTNAME=127.0.0.1 PORT="$(port_of "$MC_URL")" nohup bash scripts/start-standalone.sh \
    < /dev/null > "$ROOT/.data/logs/mission-control.log" 2>&1 & echo $! > "$ROOT/.data/mission-control.pid"; disown)
  wait_http "$MC_URL/api/agents" "Mission Control" 120 "x-api-key: $MC_API_KEY" || true
fi

echo "==> Adapter"
if listening "$ADAPTER_PORT"; then
  echo "  port $ADAPTER_PORT busy; stopping the old adapter"
  for pid in $(lsof -tiTCP:"$ADAPTER_PORT" -sTCP:LISTEN); do
    [[ "$(ps -o command= -p "$pid" 2>/dev/null)" == *src/main.ts* ]] && kill "$pid" 2>/dev/null
  done
  for _ in $(seq 1 20); do listening "$ADAPTER_PORT" || break; sleep 0.5; done
  if listening "$ADAPTER_PORT"; then echo "  port $ADAPTER_PORT is held by another program; stop it first"; exit 1; fi
fi
SOURCE=hermes
[[ $FAKE == 1 ]] && SOURCE=fake
(cd adapter || exit 1; ADAPTER_SOURCE=$SOURCE HERMES_URL=$HERMES_URL nohup node src/main.ts < /dev/null > "$ROOT/.data/logs/adapter.log" 2>&1 & echo $! > "$ROOT/.data/adapter.pid"; disown)
wait_http "http://127.0.0.1:$ADAPTER_PORT/health" "Adapter ($SOURCE)" 20

echo
echo "  Mission Control  $MC_URL   (login: $MC_ADMIN_USER / see MC_ADMIN_PASS in .env)"
echo "  Adapter          http://127.0.0.1:$ADAPTER_PORT/state"
[[ $FAKE == 0 ]] && echo "  Hermes API       $HERMES_URL"

if [[ $GAME == 1 ]]; then
  echo "==> Game"
  nohup godot --path game -- --mode=outpost-zero < /dev/null > .data/logs/game.log 2>&1 &
  disown
  echo "  launched (close the window to quit; scripts/stop.sh stops the services)"
fi
