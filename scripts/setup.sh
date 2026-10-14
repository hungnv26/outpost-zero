#!/usr/bin/env bash
# One-time setup for Outpost Zero on macOS (Apple Silicon).
#   scripts/setup.sh
# Needs: Docker (Colima or Docker Desktop), Node >= 23.6, pnpm, Godot 4.4+, Ollama.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }

say "Checking prerequisites"
need docker "brew install colima docker docker-compose && colima start --memory 6"
need node "brew install node"
need pnpm "npm i -g pnpm"
need godot "brew install --cask godot"
need ollama "brew install ollama && brew services start ollama"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<23 || (a===23&&b<6)) { console.error("Node >= 23.6 required (runs TypeScript natively)"); process.exit(1) }'
docker info >/dev/null 2>&1 || { echo "Docker is not running (try: colima start --memory 6)"; exit 1; }

say "Fetching the three foundations at pinned commits"
mkdir -p vendor
grep -vE '^\s*(#|$)' infra/vendor.lock | while read -r name repo commit; do
  if [[ ! -d "vendor/$name/.git" ]]; then
    git clone -q "$repo" "vendor/$name"
  fi
  git -C "vendor/$name" fetch -q origin 2>/dev/null || true
  git -C "vendor/$name" -c advice.detachedHead=false checkout -q "$commit"
  echo "  $name @ $commit"
done

say "Generating local credentials"
scripts/gen-env.sh

say "Preparing the local model (Ollama)"
ollama pull qwen3:4b-instruct
ollama create agentrts-qwen3 -f infra/ollama/Modelfile

say "Building Hermes Synapse images"
docker compose -p outpostzero -f vendor/hermes-synapse/docker-compose.yml -f infra/hermes.override.yml build

say "Installing Mission Control"
(cd vendor/mission-control && pnpm install --frozen-lockfile && pnpm build)

say "Installing the adapter"
(cd adapter && npm install --no-audit --no-fund)

say "Importing the game assets"
godot --headless --path game --import >/dev/null 2>&1 || godot --headless --path game --import >/dev/null 2>&1 || true

say "Done. Start everything with: scripts/start.sh"
