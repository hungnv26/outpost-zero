#!/usr/bin/env bash
# Start Outpost Zero: Hermes (Docker), Mission Control, the adapter, then the game.
#   scripts/start.sh            full stack with real agents
#   scripts/start.sh --fake     scripted demo missions (no Hermes, no LLM); Mission Control optional
#   scripts/start.sh --no-game  services only (open the game yourself: godot --path game)
#   scripts/start.sh --war      Outpost War: the battle service, Arena Setup and the game (no agents)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p .data/logs

FAKE=0
GAME=1
WAR=0
for arg in "$@"; do
  case "$arg" in
    --fake) FAKE=1 ;;
    --no-game) GAME=0 ;;
    --war|--classic) WAR=1 ;;
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

# Mission Control runs on an internal port; tools/mc_open.mjs serves $MC_URL in front of it and
# signs in for you, so the web UI has no sign-in screen (docs/settings.md). API keys pass through.
MC_INTERNAL_PORT=${MC_INTERNAL_PORT:-3011}
start_mission_control() {
  echo "==> Mission Control"
  if listening "$MC_INTERNAL_PORT"; then
    echo "  already running on 127.0.0.1:$MC_INTERNAL_PORT"
  elif listening "$(port_of "$MC_URL")"; then
    echo "  an older Mission Control holds $MC_URL; run scripts/stop.sh first for the no-sign-in front"
    return 0
  elif [[ $FAKE == 1 && ! -f vendor/mission-control/.next/standalone/server.js ]]; then
    echo "  not built; skipped in demo mode (run scripts/setup.sh to add it)"
    return 0
  else
    # Production build (dev mode shows React/CSP debug overlays); build once if missing.
    if [[ ! -f vendor/mission-control/.next/standalone/server.js ]]; then
      echo "  building Mission Control (first run, a few minutes)…"
      (cd vendor/mission-control && pnpm build > "$ROOT/.data/logs/mc-build.log" 2>&1) || { echo "  build failed, see .data/logs/mc-build.log"; exit 1; }
    fi
    # Mission Control's own .env sets its port (and wins over PORT=); keep it on the internal one.
    if [[ -f vendor/mission-control/.env ]] && ! grep -qx "PORT=$MC_INTERNAL_PORT" vendor/mission-control/.env; then
      sed -i '' -E "s/^PORT=.*/PORT=$MC_INTERNAL_PORT/" vendor/mission-control/.env
    fi
    (cd vendor/mission-control || exit 1; HOSTNAME=127.0.0.1 PORT="$MC_INTERNAL_PORT" nohup bash scripts/start-standalone.sh \
      < /dev/null > "$ROOT/.data/logs/mission-control.log" 2>&1 & echo $! > "$ROOT/.data/mission-control.pid"; disown)
    wait_http "http://127.0.0.1:$MC_INTERNAL_PORT/api/agents" "Mission Control" 120 "x-api-key: $MC_API_KEY" || true
  fi
  if ! listening "$(port_of "$MC_URL")"; then
    (MC_INTERNAL_PORT="$MC_INTERNAL_PORT" MC_PUBLIC_PORT="$(port_of "$MC_URL")" nohup node tools/mc_open.mjs \
      < /dev/null > .data/logs/mc-open.log 2>&1 & echo $! > .data/mc-open.pid; disown)
    wait_http "$MC_URL/api/agents" "Mission Control (no sign-in) on $MC_URL" 20 "x-api-key: $MC_API_KEY" || true
  fi
}

# Outpost War (docs/outpost-war.md): battles are set up in Mission Control and run by the battle
# service; no Hermes, adapter or model. The game window waits for a battle.
# The battle service (Outpost War's Mission Control lobby, and the settings card for Outpost War
# windows). The full stack starts it too, so the settings card can switch the window either way.
start_battle_service() {
  echo "==> Battle service"
  for pid in $(lsof -tiTCP:8796 -sTCP:LISTEN 2>/dev/null); do
    [[ "$(ps -o command= -p "$pid" 2>/dev/null)" == *battle-main.ts* ]] && kill "$pid" 2>/dev/null
  done
  sleep 0.5
  (cd adapter || exit 1; nohup node src/battle-main.ts < /dev/null > "$ROOT/.data/logs/battle.log" 2>&1 & echo $! > "$ROOT/.data/battle.pid"; disown)
  wait_http "http://127.0.0.1:8796/health" "Battle service" 20
}

if [[ $WAR == 1 ]]; then
  start_battle_service
  echo "==> Arena Setup"
  if listening 8790; then
    echo "  already running on http://127.0.0.1:8790"
  else
    (nohup node tools/arena_setup.mjs < /dev/null > .data/logs/arena-setup.log 2>&1 & echo $! > .data/arena-setup.pid; disown)
    wait_http "http://127.0.0.1:8790/api/state" "Arena Setup" 20 || true
  fi
  if [[ $GAME == 1 ]]; then
    nohup godot --path game -- --mode=outpost-war < /dev/null > .data/logs/game.log 2>&1 &
    disown
  fi
  echo
  echo "  Outpost War is waiting for a battle. Set one up on Arena Setup, Outpost War tab:"
  echo "  http://127.0.0.1:8790/#war   (docs/outpost-war.md)"
  exit 0
fi

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

start_mission_control

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
start_battle_service

echo
echo "  Mission Control  $MC_URL   (login: $MC_ADMIN_USER / see MC_ADMIN_PASS in .env)"
echo "  Adapter          http://127.0.0.1:$ADAPTER_PORT/state"
[[ $FAKE == 0 ]] && echo "  Hermes API       $HERMES_URL"

if [[ $GAME == 1 ]]; then
  echo "==> Game"
  # No --mode: the Mission Control settings card (docs/settings.md) decides which game it shows.
  nohup godot --path game < /dev/null > .data/logs/game.log 2>&1 &
  disown
  echo "  launched (close the window to quit; scripts/stop.sh stops the services)"
fi
