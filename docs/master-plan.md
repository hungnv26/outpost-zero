# Outpost Zero: master plan

The authority for what gets built, in what order, and when a phase is done. Written 2026-10-14
before any game code for Outpost Zero exists. Read with [story.md](story.md),
[economy.md](economy.md) and [arena.md](arena.md); when they disagree with this plan, this plan
wins and the other doc gets fixed.

## 1. Vision

A science-fiction colony simulator in which every worker is a real AI agent. Two ways to play:

- **Campaign.** You run humanity's last colony. Scarcity, machine autonomy and MOTHER's secret
  drive a story that emerges from the simulation and ends in one of four ways.
- **Arena.** Players set a match up in Mission Control, then frontier models play the same
  colony against each other through Hermes agent teams. Faster and smarter wins, measured by
  the simulation, not by a judge.

Both run on one engine: the economy. The campaign is the economy with a story on top; the
arena is the economy with teams and a clock on top.

## 2. What exists today

Inherited from Agent RTS on 2026-10-14, running and tested in `~/Projects/outpost-zero`:

| Piece | State |
|---|---|
| Game (Godot 4, Open RTS fork) | base on a 3×3 department grid, 7 animated agent characters, Build mode with 32 building slots and 24 custom characters, terrain and scenery, shroud and exploration, HUD on live data, mission replay and report |
| Adapter (TypeScript) | world store, Hermes source, fake source, Mission Control sink, Human Approval, base layout persistence, 23 tests; renamed and on port 8771 |
| Hermes Synapse | pinned; orchestrator plus 6 sub-agents; plugin that sandboxes shell; Docker project `outpostzero` on 8101 (not yet set up here) |
| Mission Control | pinned; mirrors missions, approvals, cost; port 3001 (not yet set up here) |
| Design | story, economy with data file and balance simulator, arena spec |

Not built: any economy, colonists, new buildings, chapters, events, endings, teams, scoring.

## 3. Principles

1. **Real data only.** Nothing in the HUD that the adapter did not compute this tick or Hermes
   did not actually do. No fake meters, no neon, no moving lights.
2. **The adapter is the truth.** All simulation lives in the adapter; the game draws, Hermes
   thinks, Mission Control reports. Any of the three can be replaced.
3. **Data-driven.** Every number comes from `design/economy.json`. Balance changes are a data
   edit plus a simulator run, never a code change.
4. **Deterministic given a seed.** The same seed and actions produce the same colony. Required
   for fair matches, replays and tests.
5. **Build the shared core first, then the two modes.** No campaign feature that the arena
   cannot use, and no arena feature that breaks the campaign.
6. **Ship a playable slice at the end of every phase.** Each phase ends with `scripts/start.sh`
   showing something new that works, and with the acceptance checks below passing.

## 4. Scope

**In version 1 (the first public build):** the economy, the new buildings, colonists as crowd
units, waking, autonomy levels, real expeditions and research feeding the economy, Chapter I and
II with the three paths, the dust storm and reactor events, the Arena in Race and Timed modes
with 2 teams, scoreboard and side-by-side replay.

**After version 1:** Chapters III and IV, the four endings, machine factions and recruitment,
illness and injuries, Contest mode with raids and combat, 4-team matches, public leaderboard.

**Never (by design):** colonist relationships and ideologies as in RimWorld, a hand-authored
cutscene story, pay-to-win anything in the Arena, cloud hosting of other people's API keys.

## 5. Phases

Effort is in focused sessions of a few hours each. Each phase lists what is done when.

### Phase 0: Ground truth (1 session) — DONE 2026-10-14

Evidence: `scripts/setup.sh` clean; `scripts/start.sh --fake --no-game` played a scripted mission
through every agent state, approval and report, mirrored into Mission Control on 3001; the real
stack (Hermes `outpostzero` on 8101, local model) ran a research mission through five steps and
Human Approval to a sourced report in 378 s; the game window opens as "Outpost Zero" and connects
to the adapter on 8771. Ollama was started by hand (`ollama serve`), not as a service.

Set the project up and prove the inherited stack runs under the new name.

- `scripts/setup.sh`; Hermes on 8101, Mission Control on 3001, adapter on 8771, game opens as
  "Outpost Zero"; a fake-source demo mission and a real local-model mission both complete.
- Decide the open decisions in §7 and record them in this file.
- **Done when:** `scripts/start.sh --fake` plays a mission end to end, and
  `scripts/start.sh` runs one real mission to Human Approval.

### Phase 1: Economy core (3 sessions) — DONE 2026-10-14

Evidence: `adapter/src/economy.ts` (Colony, runner, persistence) with 6 tests, the balance
check playing 80 sols on the real code (`adapter/src/economy-plan.ts`, CLI `tools/economy_sim.mjs`);
`resource.update.colony` and six `colony.*` commands; the colony strip in the game's top bar
(`docs/screenshots/colony-strip.jpg`) updating every real minute; a restart resumed at the same
hour and stocks from `.data/colony.json`; fake-source tests still pass. Build, wake and toggle
exist as commands only; Phase 2 puts them on the map.

The hourly tick in the adapter, with nothing new to look at yet except numbers.

- `adapter/src/economy.ts`: load `design/economy.json`; a `Colony` with stocks, caps, flows,
  power served by priority, production and consumption, trust, influence, reactor decay and
  repair, persistence in `.data/colony.json`, pause and speed (1x, 3x).
- Port `tools/economy_sim.mjs` into `adapter/test/economy.test.ts` as the balance test; keep the
  CLI simulator reading the same code.
- Contract: the new `resource.update` shape from economy.md §13; `GET /state` includes the
  colony; `colony.set_speed` command.
- Game: top bar shows power, water, food, materials, parts, medicine with per-sol trend next to
  tokens and cost; a sol clock.
- **Done when:** the economy test passes 80 sols on the default plan; the HUD numbers change
  every real minute; restart resumes from `.data/colony.json`; the fake source still works.

### Phase 2: Buildings and colonists (4 sessions) — DONE 2026-10-14

Evidence: the default base is now the crash site (Command Core, Human Approval, Landing Module,
Cryo Bay, Habitat; the six machines live at the lander until their building exists); the Build
tab is a catalog of economy kinds with cost, hours and power, built into the district or at a
clicked spot; a site is a map building that rises with progress while two idle machines work
on it (`docs/screenshots/colony-day.jpg`); the building panel shows power, rates, crew and the
switch, wake and repair actions; colonists are a crowd that walks to crewed lines by day and
to the Habitat at night; the sun dims at night. `tools/play_default.mjs` played the default
order through the game's own HTTP commands: first wake on sol 10, 32 awake by sol 12, no deaths,
matching the simulator. 30 adapter tests pass.

Make the numbers come from things on the map.

- New building types in Build mode with cost, build time, crew, power class, inputs and
  outputs; construction as a real job (two machines walk to the slot, the shell rises over the
  build hours); powered and unpowered states; toggling a line off.
- Colonists as crowd units: awake count, beds, hunger and thirst, waking at the Cryo Bay as a
  2-hour job for an awake colonist; crowds walk to their crewed buildings at shift start and to
  the Habitat at night.
- Storage Depot caps; Battery Bank charge; day and night lighting matching the daylight hours.
- Selected-building panel: crew, inputs and outputs this hour, powered, toggle.
- **Done when:** the default build order from the simulator can be played by hand in the game
  and reaches 32 awake by sol 12 with no desync between the HUD and the adapter state.

### Phase 3: Real work in the economy (3 sessions)

Hook the agents' real work into the numbers.

- Expeditions return salvage, blueprints and losses; the Scout's short trips.
- Research Lab missions earn data by step and by the Reviewer's quality score; data buys the
  research tiers, which unlock buildings (Fabricator at tier 1, Relay Dish and Research Lab
  upgrades at tier 2, Excavation at tier 3, Alien Tech at 1500).
- Compute: the existing token and cost counters become MOTHER's sol budget; autonomy levels
  per department and per machine change what the adapter auto-approves and who may start
  missions; influence drift; trust rules.
- Departments tab gains autonomy controls and compute share.
- **Done when:** a real research mission raises data on screen, an expedition raises salvage,
  setting a department to Autonomous makes the next mission start without Deploy, and
  influence rises as economy.md says.

### Phase 4: Arena, one team against the clock (3 sessions)

Everything the arena needs before a second team exists.

- `adapter/src/arena.ts`: match state machine, seed, action window of 6 per hour, budget from
  Hermes token reports, objectives, colony value, results.
- `colony.*` tools in the Hermes plugin calling `POST /arena/:team/action`; the observation
  JSON from arena.md §5 on every tick and from `colony.state`.
- A match task and a team agent in Mission Control start and finish a match; results written
  back.
- **Done when:** the local model plays a 20-sol Timed match on its own through the tools, every
  action is validated and logged with latency, and the result lands in Mission Control.

### Phase 5: Arena, teams (4 sessions)

- Multi-source adapter: one `HermesSource` per team with team-tagged events; one colony per
  team from the same seed.
- `scripts/arena.sh` and `infra/teams/`: one Docker project per team on 8101 to 8104, env
  files from a gitignored `infra/providers.env`.
- Game: two bases on one map in team colours, scoreboard in the top bar, feed of accepted and
  rejected actions, team notes, click to centre a base, side-by-side replay.
- Elo per model as a Mission Control agent's metadata.
- **Done when:** two local-model teams finish a Race to Awakening with a winner, a replay and
  an Elo update; then one frontier-model team beats the local model in the same match.

### Phase 6: Story, Chapters I and II (3 sessions)

- Chapter state and story cards (short, in the HUD, no cutscenes); the Chapter I twist (the
  unordered expedition that returns with an artifact); Chapter II gate and the three paths with
  their modifiers; Relay Dish and the 46-year-old signal; Excavation Site.
- Events: dust storm, reactor fault, unordered tasks, refusals, lost expedition.
- MOTHER's voice: the Foreman's reports in the mission log carry the story beats, written by the
  real model from a chapter brief, so no two playthroughs read the same.
- **Done when:** a fresh campaign reaches Chapter II by the economic gate and each path
  visibly changes the numbers and the machines' behaviour.

### Phase 7: Version 1 release (2 sessions)

- Settings, performance on 4K and 5K, first-run flow, README rewrite with screenshots, licences
  for new assets, public repository, a recorded two-team match as the trailer.
- **Done when:** a new user follows the README on a clean Mac to a finished match and a
  Chapter II campaign.

Later phases, not planned in detail yet: Chapters III and IV, endings, factions, Contest mode.

## 6. Milestones

| Milestone | Phases | What you can show |
|---|---|---|
| M1: The colony breathes | 0 to 2 | power, water, food and colonists on the map, waking from cryo |
| M2: Agents feed the colony | 3 | expeditions and research move the numbers; autonomy has a price |
| M3: First match | 4 to 5 | two models race to 100 colonists; a replay with a winner |
| M4: The secret | 6 | Chapter II and the three paths |
| M5: Version 1 | 7 | public build |

## 7. Decisions to take before Phase 1

**Decided 2026-10-14:** every recommendation below was accepted as written. They are now rules.

| Decision | Recommendation (accepted) |
|---|---|
| Campaign first or Arena first after the core? | Arena (Phases 4 to 5) before story (Phase 6): it is the differentiator, and Chapter I is enough for Race mode |
| Colonists as units or as numbers? | crowd units with no AI: cheap, visible, and the map needs people |
| Keep Hermes' 45-second call limit in the Arena? | keep it for version 1; it makes thinking modes a real trade-off |
| Compute budget source | the existing `ADAPTER_COST_BUDGET_USD` for the campaign; a token count per match for the Arena |
| New building models | KayKit and Quaternius kits already in the repo first; new assets only where a type has no fit |
| Per-team Hermes vs one Hermes with per-agent models | per team; Hermes has one orchestrator and global tool config |
| Pricing of frontier providers | the player's own keys in `infra/providers.env`; never stored in Mission Control |

## 8. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Hermes 45 s limit vs thinking models | lost decisions, unfair-looking matches | short tool-call protocol; latency on the scoreboard; limit kept on purpose |
| Local model reports fall back to raw output | poor research quality, low data | quality score already handles it; hosted model for serious play |
| Provider rate limits in matches | frozen teams | one Hermes per team; retries counted as lost decisions, shown |
| Economy balance | boring or impossible colonies | data file plus simulator test on every change; playtests at M1 |
| Godot build complexity for crowds and two bases | frame rate on 5K | low-poly crowd meshes, LOD, the existing render-scale setting |
| Scope creep from the storyline | version 1 never ships | §4 is the fence; Chapters III and IV wait |
| Match cost | surprising bills | budget is a hard freeze; default 2 M tokens; local model is free |

## 9. Definition of done, every phase

- The phase's acceptance line passes on a clean `scripts/start.sh`.
- `cd adapter && npm test && npm run typecheck` pass; the economy test is part of it.
- The contract in economy.md §13 and arena.md §8 is updated if events changed.
- README and this plan reflect what shipped; a screenshot in `docs/screenshots/` per visible
  feature.
- Nothing fake is on screen.
