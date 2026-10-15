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

## State of the build (2026-10-15)

Phases 0–6 of `docs/master-plan.md` are done: economy, buildings and colonists on the map, real
work feeding the economy, the Arena (referee, Governor, colony tools, Mission Control lobby,
teams, director, Elo), story Chapters I–IV with events, factions, MOTHER's shutdown, the four
endings and MOTHER's voice; match maps. Pending: a frontier-model Arena team (needs
`infra/providers.env`), Contest mode, the side-by-side replay.

## Run

- `scripts/setup.sh` once (clones the pinned foundations into `vendor/`, builds Hermes images, installs
  Mission Control and the adapter). `vendor/`, `.data/`, `.env`, `infra/hermes.env` are gitignored.
- `scripts/start.sh` (`--fake` for no LLM, `--no-game` for services only), `scripts/stop.sh`.
- Adapter checks: `cd adapter && npm test && npm run typecheck` (37 tests, the balance check among them).
- Fast clock for play-testing: `COLONY_SECONDS_PER_HOUR=0.3`; `node tools/play_default.mjs 12` plays the default order over HTTP.
- Arena: `scripts/arena.sh up B=ollama:agentrts-qwen3` (Hermes 8102, adapter 8781, Arena API 8782), `tools/match_director.mjs start --teams A,B --map duel ...`.
  Every team's adapter must run the same `COLONY_SECONDS_PER_HOUR` (export it before `arena.sh up`; the director refuses uneven clocks). A team's window: `OUTPOST_ZERO_WS=ws://127.0.0.1:8781/world godot --path game`.
- Screenshots: `godot --path game -- --capture-dir=DIR --capture-at=8 --quit-after-capture` (the CLI godot is not visible to desktop automation);
  `--camera-at=62,20 --camera-size=110` frames both bases of a duel.
- Stop processes by their pid files (`.data/adapter.pid`, `.data/teams/<T>.pid`); a broad `pkill -f "node src/main.ts"` also kills Agent RTS's adapter.
- Never start Mission Control from the app's preview pane. Never QA against the user's other stacks.

## Conventions carried over

- HUD shows only real, working data. No neon, strong glow or moving lights. Static scenery is welcome.
- The base stays organised in sectors (on screen: Command, Science, Industry, Life Support, Quarters;
  in the code the departments keep their Hermes capability keys command/research/code/knowledge/meeting) on the
  3x3 district grid. Every unit is a real Hermes agent; custom characters get web_search or reasoning only.
- Hermes never creates approvals; the adapter owns the Oversight Post (human approval) checkpoint.
- Renamed 2026-10-15 at the user's request: no Agent RTS era terms on screen (agents → machines, departments → sectors, Knowledge → Life Support, Research → Science, Engineering → Industry, Commons → Quarters, Human Approval → Oversight Post, Deploy → Dispatch, skills → specialties). Ids and capability keys are unchanged.

## Design docs

- `docs/master-plan.md`: the authority on phases, scope and decisions. Read it before any build work.
- `docs/story.md`: the storyline (Odyssey-7, MOTHER, the ruins, four endings).
- `docs/arena.md`: match mode where teams of Hermes agents on different frontier models play the same colony.
- `docs/economy.md`: the economy system; numbers in `design/economy.json`; balance check
  `node tools/economy_sim.mjs 80` (fails on starvation, thirst or life-support brownout).
