#!/usr/bin/env bash
# Arena teams (docs/arena.md §7): one Hermes project and one adapter per team, each on its
# own ports, all playing the same match from the same seed.
#   scripts/arena.sh up A=ollama:agentrts-qwen3 B=ollama:agentrts-qwen3      start two teams
#   scripts/arena.sh up A=anthropic:claude-opus-4-1 B=openai:gpt-5           frontier models (keys in infra/providers.env)
#   scripts/arena.sh start --mode race --objective awakening --sols 60 --budget 2000000 --seed 4217
#   scripts/arena.sh status | stop | down
# Team N (A=0, B=1, ...) uses Hermes 8101+N, adapter 8771+10*N... see TEAM_PORTS below.
# The main game stack (scripts/start.sh) is team A when it is running; `up` reuses it.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p .data/teams .data/logs

[[ -f .env ]] || scripts/gen-env.sh
grep -q '^ARENA_TOKEN=' .env || echo "ARENA_TOKEN=$(openssl rand -hex 16)" >> .env
set -a; source .env; set +a
PROVIDERS=infra/providers.env
[[ -f $PROVIDERS ]] && { set -a; source "$PROVIDERS"; set +a; }

# Per-team ports: Hermes 8101.., Arena API 8772, 8782.., adapter 8771, 8781.. (the game talks to 8771).
team_index() { local t; t=$(echo "$1" | tr 'a-z' 'A-Z'); echo $(( $(printf '%d' "'${t:0:1}") - 65 )); }  # bash 3.2 on macOS: no ${1^^}
hermes_port() { echo $((8101 + $(team_index "$1"))); }
adapter_port() { echo $((8771 + 10 * $(team_index "$1"))); }
arena_port() { echo $((8772 + 10 * $(team_index "$1"))); }
# Team A is the main stack's Hermes (project outpostzero, port 8101); B, C, D get their own.
prefix() { [[ $(echo "$1" | tr 'a-z' 'A-Z') == A ]] && echo outpostzero || echo "outpostzero-$(echo "$1" | tr 'A-Z' 'a-z')"; }
GATEWAY_PORT=${GATEWAY_PORT:-8795}

listening() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_http() { local i; for ((i = 0; i < $3; i++)); do curl -sf -m 3 "$1" >/dev/null 2>&1 && { echo "  $2 ready"; return 0; }; sleep 1; done; echo "  $2 did not come up"; return 1; }

# Writes infra/teams/<T>/hermes.env from infra/hermes.env.example and the provider:model spec.
# A cloud team's Hermes talks to the key gateway (tools/arena_setup.mjs, port 8795) with a team
# token; the gateway adds the real key, so no provider key is ever written into a container.
team_env() { # team provider:model
  local team=$1 spec=$2 provider=${2%%:*} model=${2#*:}
  local dir=infra/teams/$team
  mkdir -p "$dir"
  local env=$dir/hermes.env
  cp infra/hermes.env.example "$env"
  [[ -s $dir/gateway.token ]] || { (umask 077; openssl rand -hex 16 > "$dir/gateway.token"); }
  python3 - "$env" "$provider" "$model" "$team" "$dir" "$GATEWAY_PORT" <<'PY'
import os, re, sys
path, provider, model, team, folder, gport = sys.argv[1:7]
s = open(path).read()
def setk(k, v):
    global s
    s = re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s + f"\n{k}={v}"
for k in ["LLM_MODEL", "LLM_FALLBACK_MODEL", "AGENT_MODEL_RESEARCH", "AGENT_MODEL_CODE", "AGENT_MODEL_ANALYST", "AGENT_MODEL_PLANNER"]:
    setk(k, model)
if provider == "ollama":
    pass  # the example already points at host.docker.internal:11434
else:
    # Hermes speaks the OpenAI chat API to LLM_API_BASE with OPENROUTER_API_KEY (its name for any
    # key). Both point at the gateway; the real key lives in infra/teams/<T>/api.key or
    # infra/providers.env and only the gateway reads it.
    has_key = os.path.exists(os.path.join(folder, "api.key")) or os.environ.get(f"{provider.upper()}_API_KEY")
    if not has_key:
        sys.exit(f"team {team}: no API key (enter it in the Arena Setup page, or {provider.upper()}_API_KEY in infra/providers.env)")
    setk("LLM_API_BASE", f"http://host.docker.internal:{gport}/llm/{team}/v1")
    setk("OPENROUTER_API_KEY", open(os.path.join(folder, "gateway.token")).read().strip())
open(path, "w").write(s)
PY
  echo "$spec" > "$dir/model"
}

compose() { # team, args...
  local team=$1; shift
  # Upstream's compose sets OPENROUTER_API_KEY, LLM_API_BASE and LLM_MODEL from variables that
  # Docker otherwise fills from vendor/hermes-synapse/.env (the main stack's local model). Pass the
  # team's own values (gateway token and endpoint for a cloud team) so they win.
  local f="$ROOT/infra/teams/$team/hermes.env"
  val() { sed -n "s/^$1=//p" "$f" 2>/dev/null | tail -1; }
  mkdir -p "$ROOT/.data/hermes/$team"
  HERMES_DATA_DIR="$ROOT/.data/hermes/$team" \
  OPENROUTER_API_KEY=$(val OPENROUTER_API_KEY) LLM_API_BASE=$(val LLM_API_BASE) LLM_MODEL=$(val LLM_MODEL) HERMES_PREFIX=$(prefix "$team") HERMES_PORT=$(hermes_port "$team") HERMES_DASHBOARD_PORT=$((9120 + $(team_index "$team"))) \
  HERMES_ENV_FILE="$ROOT/infra/teams/$team/hermes.env" \
  ARENA_URL="http://host.docker.internal:$(arena_port "$team")" ARENA_TEAM=$team \
  OUTPOST_ZERO_ROOT="$ROOT" docker compose -p "$(prefix "$team")" -f vendor/hermes-synapse/docker-compose.yml -f infra/hermes.override.yml "$@"
}

cmd=${1:-status}; shift || true
case "$cmd" in
  up)
    [[ $# -ge 1 ]] || { echo "usage: scripts/arena.sh up A=provider:model [B=provider:model ...]"; exit 1; }
    for spec in "$@"; do
      team=${spec%%=*}; pm=${spec#*=}
      echo "==> Team $team: $pm"
      team_env "$team" "$pm"
      compose "$team" up -d > ".data/logs/compose-$team.log" 2>&1 || { cat ".data/logs/compose-$team.log"; exit 1; }
      # hermes.env is mounted, not baked in: a running backend only reads a new model or key on restart.
      compose "$team" restart backend >> ".data/logs/compose-$team.log" 2>&1
      wait_http "http://127.0.0.1:$(hermes_port "$team")/api/status" "Hermes $team" 180
      port=$(adapter_port "$team")
      # Restart the adapter so its clock, model label and turn-taking match this spec.
      for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        [[ "$(ps -o command= -p "$pid" 2>/dev/null)" == *src/main.ts* ]] && kill "$pid"
      done
      for _ in $(seq 1 20); do listening "$port" || break; sleep 0.5; done
      if listening "$port"; then echo "  port $port is held by another program"; exit 1; else
        (cd adapter || exit 1; MOTHER_VOICE=0 ADAPTER_SOURCE=hermes HERMES_URL="http://127.0.0.1:$(hermes_port "$team")" ADAPTER_PORT=$port ARENA_PORT=$(arena_port "$team") \
          LAYOUT_PATH="$ROOT/.data/teams/$team/base.json" MC_SYNC=${MC_SYNC_TEAMS:-0} ADAPTER_MODEL_LABEL="$pm" ARENA_TEAM=$team ARENA_LLM_LOCK=$([[ $pm == ollama:* ]] && echo "$ROOT/.data/teams/ollama.lock") \
          nohup node src/main.ts < /dev/null > "$ROOT/.data/logs/adapter-$team.log" 2>&1 & echo $! > "$ROOT/.data/teams/$team.pid")
        wait_http "http://127.0.0.1:$port/health" "Adapter $team" 20
      fi
    done
    echo "Teams up. Start a match with: scripts/arena.sh start --sols 30"
    ;;
  start)
    node tools/match_director.mjs start "$@"
    ;;
  status)
    node tools/match_director.mjs status
    ;;
  stop)
    node tools/match_director.mjs stop
    ;;
  down)
    for d in .data/teams/*.pid; do [[ -f $d ]] || continue; pid=$(cat "$d"); pkill -TERM -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; rm -f "$d"; done
    for t in infra/teams/*/; do [[ -d $t ]] || continue; team=$(basename "$t"); compose "$team" stop >/dev/null 2>&1 && echo "stopped Hermes $team"; done
    ;;
  *) echo "unknown command $cmd"; exit 1 ;;
esac
