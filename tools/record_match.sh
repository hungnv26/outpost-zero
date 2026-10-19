#!/usr/bin/env bash
# Records a short Arena match to an MP4 (docs/arena.md §9): starts the match through the director,
# renders team A's window with Godot's movie writer (off screen, nothing else on the desktop is
# captured) framed on both bases, closes when the match is over and converts to H.264.
#   tools/record_match.sh [sols] [map] [objective]   e.g. tools/record_match.sh 12 random lifeline
# A race to the objective (default lifeline: the five production buildings running; sprint is
# first to 44 awake); if nobody gets there in time the
# highest colony value wins. RECORD_MODE=timed plays the sols out instead.
# Needs the teams up (scripts/arena.sh up ...), ffmpeg, and godot on PATH. Output: recordings/.
# The movie writer renders at its own pace, so the colony clock (real time) runs faster in the
# video than the units' animations: a long match comes out as a time-lapse.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SOLS=${1:-12}
MAP=${2:-random}
OBJECTIVE=${3:-lifeline}
MODE=${RECORD_MODE:-race}
FPS=${RECORD_FPS:-24}
mkdir -p recordings .data/rec .data/logs

# A running director owns the scoreboard; end it without a result, then stop the old match.
[[ -f .data/director.pid ]] && kill "$(cat .data/director.pid)" 2>/dev/null || true
node tools/match_director.mjs stop > /dev/null 2>&1 || true
sleep 2

stamp=$(date +%Y%m%d-%H%M)
nohup node tools/match_director.mjs start --teams A,B --map "$MAP" --mode "$MODE" --objective "$OBJECTIVE" --sols "$SOLS" --budget 400000 --seed "$RANDOM" --poll 3000 > .data/logs/director.log 2>&1 &
echo $! > .data/director.pid
for _ in $(seq 1 30); do grep -q "started on" .data/logs/director.log 2>/dev/null && break; sleep 1; done
head -1 .data/logs/director.log
map_id=$(sed -n 's/.* on map .*\[\([a-z-]*\),.*/\1/p' .data/logs/director.log | head -1)
map_id=${map_id:-$MAP}

# Frame both bases: the midpoint between A and B, wide enough for both.
read -r cam size < <(node -e '
const m = JSON.parse(require("fs").readFileSync("design/maps.json", "utf8"));
const b = m.battlefields?.[process.argv[1]] ?? m[process.argv[1]] ?? m.duel;
const [bx, bz] = b.bases.B;
console.log(`${(bx + 44) / 2},${(bz + 44) / 2} ${Math.round(Math.hypot(bx, bz) * 0.85 + 34)}`);' "$map_id")

avi="$ROOT/.data/rec/match-$stamp.avi"
echo "Recording $map_id from team A's window (camera $cam, size $size) ..."
godot --path game --write-movie "$avi" --fixed-fps "$FPS" --resolution 1920x1080 --windowed -- --mode=outpost-zero \
  --camera-at="$cam" --camera-size="$size" --quit-when-match-over > .data/logs/record.log 2>&1 || true

out="recordings/outpost-zero-$stamp-$map_id.mp4"
ffmpeg -loglevel error -y -i "$avi" -an -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart "$out"
rm -f "$avi"
tail -1 .data/logs/director.log | tr '\r' '\n' | tail -2
echo "Saved $out ($(du -h "$out" | cut -f1))"
