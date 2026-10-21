#!/usr/bin/env bash
# Checks Outpost War (docs/outpost-war.md) end to end on this Godot: unattended matches of
# computer players that must finish with a winner, and upstream's manual test scenes, all without
# script errors (a stalled match where one side holds 80% of the value counts as decided). Run it after any change to the original Open RTS files (game/source outside agent/).
#   tools/war_smoke.sh           both maps (about 5 minutes)
#   tools/war_smoke.sh --quick   Plain & Simple and the test scenes only (about 2 minutes)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
LOG=.data/logs/war-smoke
mkdir -p "$LOG"
QUICK=0; [[ ${1:-} == --quick ]] && QUICK=1
fail=0

match() { # map players timeout_s
  local out="$LOG/match-$1.log"
  timeout $(( $3 + 60 )) godot --headless --path game -- --mode=outpost-war --war-autoplay="$1" \
    --war-players="$2" --war-speed=4 --war-timeout="$3" > "$out" 2>&1
  local code=$? errors; errors=$(grep -c "SCRIPT ERROR" "$out")
  local result; result=$(grep "WAR_SMOKE result" "$out" | tail -1)
  if [[ $code -eq 0 && $errors -eq 0 && ( $result == *result=finished* || $result == *result=decided* ) ]]; then echo "PASS  $1 ($2 players): ${result#*map=}"
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
[[ $fail == 0 ]] && echo "Outpost War: all checks passed" || echo "Outpost War: FAILED"
exit $fail
