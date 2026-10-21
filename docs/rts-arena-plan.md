# RTS Arena plan: Claude and OpenAI play Outpost War

Status: built 2026-10-20 (docs/rts-arena.md describes what exists; setup is on the Arena Setup
page, not in Mission Control, and models call providers through the key gateway rather than
Hermes). Plan written 2026-10-19. Builds on Outpost War (docs/outpost-war.md, the Open RTS deathmatch) and
the Outpost Zero Arena (docs/arena.md).

## Goal

Two AI models command the two sides of an Outpost War battle (Claude against GPT-5, a model
against Open RTS's scripted opponent, or the local model) under the same rules, map, speed and
token budget. The last side with anything left wins. The match is watchable, recorded, and scored
with an Elo per model.

## The core design: models command, the game executes

Outpost War runs in real seconds, and a model answers in 3 to 40 s. A model therefore never steers
single units: it gives orders the way a commander would, and the game carries them out using
Open RTS's own actions, the same calls its scripted opponent makes:

| Order | Carried out by (existing code) |
|---|---|
| build a structure near a place | charge `CONSTRUCTION_COSTS`, `find_valid_position_radially`, `MatchSignals.setup_and_spawn_unit`, then a worker's `Constructing` action |
| train N units at a building | `production_queue.produce(scene)` (checks the 5-unit queue limit and the cost) |
| send workers to gather A or B | `worker.action = CollectingResourcesSequentially.new(deposit)` |
| attack a player or an area with a group | `AutoAttacking` / `MovingToUnit` per unit, retargeting like `AutoAttackingBattlegroup` |
| defend a building, scout with a drone | `Moving`, `AutoAttacking` near the building; `Moving` for the drone |

Every order is checked the way a human click would be (costs, queue limit, ownership, valid
placement). A refused order comes back with the reason, as the colony tools do.

## Setup lives in Mission Control, not in the game

Built 2026-10-19 for human and scripted players: the battle card, the lobby and battle service
(`adapter/src/battle/`, `adapter/src/battle-main.ts`) and the game's battle client
(`game/source/war/BattleClient.gd`); Outpost War's Play and Options screens are gone
(docs/outpost-war.md). Model players extend the same card.

As in Outpost Zero, a match is set up in Mission Control's web interface (127.0.0.1:3001) and
the game only plays it. Outpost War's in-game **Play** screen (map and player selection) gives way
to a **Waiting for a battle from Mission Control** screen. Options, Credits, the Outpost Zero
switch and Quit stay.

Mission Control's task form cannot edit task metadata (it only sets recurrence), so the setup is
a **battle card**: a short block in an ordinary task's description, written in the browser.

```
battle:
  map: Plain & Simple
  players:
    - red: anthropic/claude-sonnet-5-5
    - blue: openai/gpt-5
    - green: ai          # Outpost War's scripted opponent
    - yellow: human      # plays in the game window
  speed: 0.5
  minutes: 20
  budget: 400k
  fog: on
  record: yes
```

- **Starting and stopping:** moving the task to *In progress* starts the battle, and *Done* or
  *Cancelled* stops it, as the Outpost Zero lobby already does for `metadata.arena`. The referee
  polls Mission Control, checks the card and posts problems as a task comment ("unknown map",
  "team B has no API key").
- **Running the battle:** the referee opens the game window in Outpost War and hands it the
  battle.
- **Results:** results, the replay or recording link and the Elo change come back as a comment,
  and the task is marked done.
- **Keys:** API keys never go into Mission Control. Providers and models are named on the card,
  and each team's key stays in the local key vault (the Arena Setup page's key section).
- **Later option:** a dedicated Battles panel in Mission Control with dropdowns. That means
  changing Mission Control's own code, which is pinned and reinstalled by `scripts/setup.sh`, so it
  would ship as a patch applied at setup. The battle card needs no such change.

## Architecture

```
Godot (one match, authoritative)
  ModelPlayer x N   (new PlayerType.MODEL, like Human / SimpleClairvoyantAI)
  BattleBridge      (WebSocket client: sends per-team state, receives orders)
        |
        v
Battle referee (adapter/src/rts/, TypeScript)
  per-team API  GET /rts/<T>/state   POST /rts/<T>/order   (token per team)
  match lifecycle, clock, budgets, results, Elo (match director)
        ^
        |
Hermes per team (A on 8101, B on 8102), "Commander" sub-agent with rts_* tools
        |
Key gateway (tools/arena_setup.mjs): real keys, pinned model, real token counts
```

- **One Godot process runs the match.** Both teams play in the same world. This differs from the
  colony Arena, where each team has its own colony. The spectator window and the recorder watch
  that match with full visibility.
- **The referee keeps teams apart.** Each team's token only reads its own state and gives orders
  to its own units.

## What a model sees

The observation is a compact JSON per turn, with honest fog of war (unlike the scripted opponent,
which sees everything):

- **Economy:** resources A and B, income over the last minute, worker count and what each worker
  is doing.
- **Own forces:** units and buildings by type, with health, position (a coarse 10×10 grid such as
  "D7", plus x,z) and current order; production queues.
- **Known map:** map size; deposits seen so far, with the amount left; enemy units and buildings
  currently in sight; enemy buildings last seen and where.
- **Match:** game time, speed, tokens used and left, and the results of its last 6 orders.

## Tools for the Commander (Hermes plugin, rts_*)

`rts_state`, `rts_build(type, near)`, `rts_train(building_id | type, count)`,
`rts_gather(resource, workers)`, `rts_attack(group | unit_ids | "all_army", target_player | area)`,
`rts_defend(group, building_id)`, `rts_scout(area)`, `rts_rally(building_id, area)`,
`rts_note(text)`. `near` and `area` take grid cells or named places: `my_base`, `center`,
`enemy_last_seen`, or a deposit id.

## Fairness rules

- **Same match for everyone:** the same map, seed, spawn mirror, game speed and token budget. The
  budget is charged with the gateway's real token counts.
- **Game speed:** a configurable time scale (default 0.5×) so turns of a few seconds still matter.
  The clock never waits: a slower model loses tempo, as in the colony Arena.
- **Shared local model:** two teams on one Ollama model take turns (the existing `ARENA_LLM_LOCK`).
- **Match end:** the last player standing wins. At the time limit (default 20 game minutes) the
  winner is the side with the most surviving value (unit and building costs times health
  fraction).
- **Freeze:** a team that runs out of budget is frozen. Its units keep their last orders and
  defend themselves.

## Phases

**Phase 0: spike (half a day)**
A scripted ModelPlayer reads orders from a test list and carries out each order type on Plain &
Simple, headless. It proves every order works through the existing code, with no model involved.

**Phase 1: ModelPlayer and BattleBridge in Godot (one and a half days)**
- `PlayerType.MODEL` with its controller scene, selectable in the Play menu as "Model (A/B…)".
- The state builder: per-team fog from each unit's sight range, plus last-seen memory of enemy
  buildings.
- The order executor with validation and refusal reasons.
- A WebSocket client to the referee. Match settings come from launch flags, for unattended
  matches.
- Extend `tools/war_smoke.sh`: a scripted commander through the bridge plays a full match.

**Phase 2: battle referee in the adapter (one day)**
- `adapter/src/rts/`: match lifecycle (start, clock, time limit, result) and per-team state and
  order endpoints with tokens.
- An action log with latency per order; token budgets from the gateway; freeze.
- Unit tests with a fake bridge. `match_director.mjs --game rts` keeps the Elo and match records.

**Phase 3: Commander tools and prompt (half a day to one day)**
- `rts_*` tools in `infra/hermes-plugin/plugin.py` and a Commander sub-agent.
- The prompt: the rules and the economy table, a goal line (enemy buildings left, army strength),
  and a fresh chat each turn, the lesson from the colony races.

**Phase 4: Mission Control setup, spectator and recording (one day)**
- The battle card parser and the Mission Control lobby for battles in the referee, with comments
  for bad cards and results.
- Outpost War's Play screen becomes "Waiting for a battle from Mission Control", listing the
  battle once it is assigned.
- The Arena Setup page keeps only the key vault and status. Setup moves to Mission Control.
- A spectator window with full visibility, a scoreboard overlay (army value, buildings, tokens,
  average turn time) and the recorder (`tools/record_match.sh --game rts`).

**Phase 5: tuning and real matches (one day)**
- Each model against the scripted opponent first, as a baseline, then Claude against GPT-5.
- Tune the time scale, the observation size (tokens per turn) and the order set from what the
  models actually do.

**Total: about five to six days.**

## Costs

A turn is about 4,000 to 8,000 tokens, mostly the observation. At 0.5× speed a 10-game-minute
battle takes 20 real minutes. Claude at about 5 s a turn would want about 240 turns, which is more
than a 400k budget allows, so the budget becomes part of the contest, as it did in the colony
races. At current list prices a 400k-token side costs roughly $1 to $2 (Claude Sonnet 5.5 $2/$10,
GPT-5 $1.25/$10 per million tokens in/out).

## Risks

- **Spatial reasoning:** models handle coordinates poorly. The coarse grid, named places and
  "near" orders keep orders meaningful; the executor picks exact positions.
- **Latency against real time:** the time scale and high-level orders cover it. If needed, an
  option to pause the game while every team thinks (turn-based) is a small extension.
- **Upstream code:** Open RTS's actions carry TODOs (unit "push" problems, retargeting). The
  executor re-issues orders whose units went idle.
- **One shared Godot process:** a crash ends both teams' match. The referee records the state
  every few seconds, so a crashed match can at least be scored.

## Decisions for the owner

0. Decided (2026-10-19): the game setup lives in Mission Control's web interface, not in the
   game, as in Outpost Zero; the Lampe Games logo is out of the intro.

1. **Speed model:** real time slowed to 0.5× (recommended) or pause-while-thinking (turn-based).
2. **Fog of war for models:** honest fog (recommended) or full visibility.
3. **First formats:** 1 v 1 on Plain & Simple plus each model against the scripted opponent
   (recommended), with free-for-all up to 4 models later.
4. **Time limit and budget:** 20 game minutes and 400k tokens per side (recommended starting
   point).
