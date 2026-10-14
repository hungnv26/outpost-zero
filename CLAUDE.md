# Outpost Zero

Game-style AI agent orchestration: a Godot 4 RTS scene (Open RTS fork) where every unit is a real
Hermes Synapse agent, mirrored into Mission Control. Started 2026-10-14 as a new project from the
Agent RTS foundation (`~/Projects/agent-rts`, github.com/hungnv26/agent-rts); same architecture,
own identity. Read `README.md` and `docs/architecture.md` first.

## Ports and names (differ from Agent RTS so both can run at once)

| Part | Outpost Zero | Agent RTS |
|---|---|---|
| Hermes Synapse (Docker project) | 127.0.0.1:8101 (`outpostzero`) | 8100 (`agentrts`) |
| Mission Control | 127.0.0.1:3001 | 3000 |
| Adapter | 127.0.0.1:8771 | 8770 |
| Hermes dashboard (optional profile) | 9120 | 9119 |
| Godot user data | `app_userdata/Outpost Zero/outpost_zero_*` | `app_userdata/Agent RTS/agent_rts_*` |
| Ollama model | `agentrts-qwen3` (shared, pulled once) | same |

Env override for the game's world feed: `OUTPOST_ZERO_WS`. Compose root override: `OUTPOST_ZERO_ROOT`.

## Run

- `scripts/setup.sh` once (clones the pinned foundations into `vendor/`, builds Hermes images, installs
  Mission Control and the adapter). `vendor/`, `.data/`, `.env`, `infra/hermes.env` are gitignored.
- `scripts/start.sh` (`--fake` for no LLM, `--no-game` for services only), `scripts/stop.sh`.
- Adapter checks: `cd adapter && npm test && npm run typecheck`.
- Never start Mission Control from the app's preview pane. Never QA against the user's other stacks.

## Conventions carried over

- HUD shows only real, working data. No neon, strong glow or moving lights. Static scenery is welcome.
- The base stays organised in departments (Command, Research, Engineering, Knowledge, Commons) on the
  3x3 district grid. Every unit is a real Hermes agent; custom characters get web_search or reasoning only.
- Hermes never creates approvals; the adapter owns the Human Approval checkpoint.
