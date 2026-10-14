#!/usr/bin/env bash
# Drive one mission through the adapter's HTTP API and print agent states until it ends.
#   scripts/run-mission.sh "Research the Australian EV market" [--approve|--reject]
set -euo pipefail
ADAPTER=${ADAPTER:-http://127.0.0.1:8771}
TITLE=${1:?mission title}
DECISION=${2:---approve}
LIMIT=${LIMIT:-900}
APPROVE_DELAY=${APPROVE_DELAY:-0} # seconds to leave the approval pending (demo/screenshots)

body=$(python3 -c 'import json,sys; print(json.dumps({"type":"mission.create","title":sys.argv[1]}))' "$TITLE")
curl -sf -X POST "$ADAPTER/command" -H "content-type: application/json" -d "$body" >/dev/null
start=$(date +%s)
while true; do
  line=$(curl -sf "$ADAPTER/state" | python3 -c '
import json, sys
w = json.load(sys.stdin)["world"]
m = w["mission"] or {}
pending = [a["id"] for a in w["approvals"] if a["status"] == "pending"]
agents = " ".join("%s=%s@%s" % (a["id"], a["state"], a["location"]) for a in w["agents"])
print(m.get("status", "none"), pending[0] if pending else "-", agents)')
  read -r status pending agents <<<"$line"
  echo "$(( $(date +%s) - start ))s $status $agents"
  if [[ "$pending" != "-" ]]; then
    sleep "$APPROVE_DELAY"
    approved=true; [[ "$DECISION" == "--reject" ]] && approved=false
    curl -sf -X POST "$ADAPTER/command" -H "content-type: application/json" -d "{\"type\":\"approval.resolve\",\"id\":\"$pending\",\"approved\":$approved}" >/dev/null
    echo "approval resolved: approved=$approved"
  fi
  case "$status" in completed|failed|cancelled) break ;; esac
  (( $(date +%s) - start > LIMIT )) && { echo "timeout"; exit 1; }
  sleep 5
done
curl -sf "$ADAPTER/state" | python3 -c '
import json, sys
w = json.load(sys.stdin)["world"]
print("status:", w["mission"]["status"], "| resources:", w["resources"])
for t in w["tasks"]: print(" -", t["status"], t["title"][:80])
print("\n" + (w["mission"]["result"] or "")[:2500])'
