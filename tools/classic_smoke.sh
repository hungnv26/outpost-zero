#!/usr/bin/env bash
# Checks Open RTS mode (docs/open-rts-mode.md) end to end on this Godot: unattended matches of
# computer players that must finish with a winner, and upstream's manual test scenes, all without
# script errors. Run it after any change to Open RTS's own files (game/source outside agent/).
#   tools/classic_smoke.sh           both maps (about 5 minutes)
#   tools/classic_smoke.sh --quick   Plain & Simple and the test scenes only (about 2 minutes)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
LOG=.data/logs/classic-smoke
mkdir -p "$LOG"
QUICK=0; [[ ${1:-} == --quick ]] && QUICK=1
fail=0

match() { # map players timeout_s
  local out="$LOG/match-$1.log"
  timeout $(( $3 + 60 )) godot --headless --path game -- --mode=open-rts --classic-autoplay="$1" \
    --classic-players="$2" --classic-speed=4 --classic-timeout="$3" > "$out" 2>&1
  local code=$? errors; errors=$(grep -c "SCRIPT ERROR" "$out")
  local result; result=$(grep "CLASSIC_SMOKE result" "$out" | tail -1)
  if [[ $code -eq 0 && $errors -eq 0 && $result == *result=finished* ]]; then echo "PASS  $1 ($2 players): ${result#*map=}"
  else echo "FAIL  $1 ($2 players): exit $code, $errors script errors, ${result:-no result} (see $out)"; fail=1; fi
}

scene() { # name
  local out="$LOG/scene-$1.log"
  timeout 90 godot --headless --path game "res://tests/manual/$1.tscn" --quit-after 1200 > "$out" 2>&1
  local code=$? errors; errors=$(grep -c "SCRIPT ERROR" "$out")
  if [[ $code -eq 0 && $errors -eq 0 ]]; then echo "PASS  scene $1"; else echo "FAIL  scene $1: exit $code, $errors script errors (see $out)"; fail=1; fi
}

match PlainAndSimple 2 400
[[ $QUICK == 1 ]] || match BigArena 4 600
for s in TestPlayerVsAI TestUnitsFightingEachOther TestAllUnits TestOneUnit TestNonQuadraticMap; do scene "$s"; done
[[ $fail == 0 ]] && echo "Open RTS mode: all checks passed" || echo "Open RTS mode: FAILED"
exit $fail
