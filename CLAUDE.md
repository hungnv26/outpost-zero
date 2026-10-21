# Outpost Zero

Game-style AI agent orchestration: a Godot 4 RTS scene (Open RTS fork) where every unit is a real
Hermes Synapse agent, mirrored into Mission Control. Started 2026-10-14 as a new project from the
Agent RTS foundation (`~/Projects/agent-rts`, github.com/hungnv26/agent-rts); same architecture,
own identity. Read `README.md` and `docs/architecture.md` first.

## Ports and names (differ from Agent RTS so both can run at once)

| Part | Outpost Zero | Agent RTS |
|---|---|---|
| Hermes Synapse (Docker project) | 127.0.0.1:8101 (`outpostzero`) | 8100 (`agentrts`) |
| Mission Control | 127.0.0.1:3001 (no sign-in front, `tools/mc_open.mjs`; MC itself on 3011) | 3000 |
| Adapter | 127.0.0.1:8771 | 8770 |
| Hermes dashboard (optional profile) | 9120 | 9119 |
| Godot user data | `app_userdata/Outpost Zero/outpost_zero_*` | `app_userdata/Agent RTS/agent_rts_*` |
| Ollama model | `agentrts-qwen3` (shared, pulled once) | same |

Env override for the game's world feed: `OUTPOST_ZERO_WS`. Compose root override: `OUTPOST_ZERO_ROOT`.

## State of the build (2026-10-15)

Phases 0–6 of `docs/master-plan.md` are done: economy, buildings and colonists on the map, real
work feeding the economy, the Arena (referee, Governor, colony tools, Mission Control lobby,
teams, director, Elo), story Chapters I–IV with events, factions, MOTHER's shutdown, the four
endings and MOTHER's voice; match maps. Pending: Contest mode, the side-by-side replay. Frontier-model teams are set up from the Arena Setup page.

## Run

- `scripts/setup.sh` once (clones the pinned foundations into `vendor/`, builds Hermes images, installs
  Mission Control and the adapter). `vendor/`, `.data/`, `.env`, `infra/hermes.env` are gitignored.
- `scripts/start.sh` (`--fake` for no LLM, `--no-game` for services only), `scripts/stop.sh`.
- Adapter checks: `cd adapter && npm test && npm run typecheck` (51 tests, the balance check among them; `node tools/economy_sim.mjs 80 --map <id>` per battlefield).
- Fast clock for play-testing: `COLONY_SECONDS_PER_HOUR=0.3`; `node tools/play_default.mjs 12` plays the default order over HTTP.
- Arena: `scripts/arena.sh up B=ollama:agentrts-qwen3` (Hermes 8102, adapter 8781, Arena API 8782), `tools/match_director.mjs start --teams A,B --map duel ...`.
  Every team's adapter must run the same `COLONY_SECONDS_PER_HOUR` (export it before `arena.sh up`; the director refuses uneven clocks). A team's window: `OUTPOST_ZERO_WS=ws://127.0.0.1:8781/world godot --path game`.
- Two Ollama teams on one Mac: start both adapters with `ARENA_LLM_LOCK=.data/teams/ollama.lock MOTHER_VOICE=0` (turn-taking, docs/arena.md §8c) and keep Ollama at one slot; `OLLAMA_NUM_PARALLEL=2` swaps this 16 GB Mac to a crawl. Game windows: `godot --path game --max-fps 30`, placed side by side with System Events (`-- --window=x,y,w,h` also places one).
- Arena Setup page: `node tools/arena_setup.mjs` → http://127.0.0.1:8790 (also `arena-setup` in the workspace launch.json): provider, model and API key per team, apply, open windows, start or record a race. Keys in `infra/teams/<T>/api.key` (600, gitignored), relayed by the key gateway on :8795 so no key enters a container; the gateway also reports real token counts, which the match budget charges, and each team's Hermes keeps its data in `.data/hermes/<T>` (docs/arena.md §8f). Cloud keys can also go in `infra/providers.env` (template `infra/providers.env.example`).
- Battlefields: ten random maps in `design/maps.json` (`tools/make_battlefields.mjs`, docs/arena.md §8d); the director picks one at random for 2+ teams, `node tools/match_director.mjs maps` lists them, `--map <id>` or `--map duel` chooses.
- Record a match: `tools/record_match.sh [sols] [map] [objective]` (teams up first, ideally `COLONY_SECONDS_PER_HOUR=2`; default a `lifeline` race, docs/arena.md §8e) renders team A's window off screen with Godot's movie writer, framed on both bases, and saves `recordings/*.mp4` (gitignored); the colony runs faster in the video than the animations.
- Two modes: the start scene is `game/source/boot/Boot.tscn` (`-- --mode=outpost-war|outpost-zero`, else the saved choice, else Outpost Zero; `open-rts` is a legacy alias). Outpost War is the original Open RTS deathmatch renamed on screen (credits keep Open RTS / Lampe Games in game/LICENSE and the README; no Godot or Lampe logo intro; Outpost War has its own title sequence war/WarIntro.gd since 2026-10-22). It has no Play/Options screens: battles are set up on the Arena Setup page's Outpost War tab (http://127.0.0.1:8790/#war), which sends them to the battle service `adapter/src/battle-main.ts` on 127.0.0.1:8796 (`scripts/start.sh --war` starts the service, Arena Setup and the game; Mission Control battle tasks only with `BATTLE_FROM_MC=1`; docs/outpost-war.md). Any player can be an AI model (RTS Arena, docs/rts-arena.md): `ModelPlayer.gd` in the game carries out orders, `adapter/src/battle/commander.ts` runs one model per player through the key gateway's `/llm/war` route; provider keys in `infra/keys/<provider>.key`. Check it with `tools/war_smoke.sh [--quick]` after touching Open RTS files. Tool launchers (Arena Setup windows, recorder, captures) pass `--mode=outpost-zero`; `scripts/start.sh` launches the normal window without `--mode` so the Mission Control settings card decides the game.
- Screenshots: `godot --path game -- --mode=outpost-zero --capture-dir=DIR --capture-at=8 --quit-after-capture` (no `--open-settings`: there is no Settings tab) (the CLI godot is not visible to desktop automation);
  `--camera-at=62,20 --camera-size=110` frames both bases of a duel.
- Stop processes by their pid files (`.data/adapter.pid`, `.data/teams/<T>.pid`); a broad `pkill -f "node src/main.ts"` also kills Agent RTS's adapter.
- Mission Control has no sign-in screen: `tools/mc_open.mjs` on 3001 signs in with the `.env` admin and fronts MC on 3011 (docs/settings.md). Don't put a login back or move the relay off 127.0.0.1.
- Never start Mission Control from the app's preview pane. Never QA against the user's other stacks.

## Conventions carried over

- No in-game settings or setup screens. Game setup for both games is the Arena Setup page (Outpost Zero tab and Outpost War tab; the user chose it over Mission Control for Outpost War on 2026-10-20); window settings for a window started without `--mode` are the Mission Control settings card (docs/settings.md). Never add settings screens to the game.
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
