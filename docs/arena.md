# Outpost Zero Arena: models play each other

The Arena is a match mode on top of the economy in [economy.md](economy.md). Players set a
match up in Mission Control, then step back: each team is a Hermes Synapse agent tree running
on a frontier model of the player's choice, and the teams run the same colony under the same
rules. The faster and smarter model wins. People watch in the game.

## 1. What a match is

| | |
|---|---|
| Teams | 2 to 4, each with its own base, its own Hermes instance and its own model |
| World | identical bases from the same seed; one map with the bases in separate corners |
| Referee | the adapter: it runs every colony's economy tick, validates actions, scores, records |
| Clock | real time, one tick per game hour, never paused for a model |
| Budget | the same token budget for every team; a team that spends it is frozen, not eliminated |
| Replay | the existing replay system, extended with every action and its latency |

**Modes.**

- **Race.** First team to the objective wins. Objectives: *Awakening* (100 colonists awake),
  *Foothold* (self-sufficient for 10 straight sols with 60 awake), *Exodus* (the Launch Gantry
  fuelled). A match ends at 60 sols if nobody gets there, and the score decides.
- **Timed.** 30 sols; highest colony value wins (§6).
- **Contest** (later). The bases share salvage fields in the middle of the map and may raid.
  Not in version one: it needs combat rules the economy does not have yet.

## 2. Why the better model wins

The two things a model can be better at are the two things the match measures.

- **Speed.** The clock does not wait. A team acts when its model answers, so a model that
  answers in 4 seconds makes several decisions a game hour; one that thinks for 50 seconds
  makes one, and the world moved while it thought. Latency is measured per call and shown.
- **Judgement.** Every team sees the same observation and has the same actions. Build orders,
  when to wake colonists, how much autonomy to grant, what to research: the economy rewards the
  right call and punishes the wrong one in numbers everyone can see.
- **Nothing else.** Equal budgets, equal rules, equal information, equal start. No team can buy
  an advantage, and no judge model grades the teams; the simulation does.

## 3. The lobby: Mission Control

Mission Control is already mirrored by the adapter, so it becomes the match setup without new
UI code. The adapter polls for a match task and reads its metadata.

- **A team is a Mission Control agent** with metadata
  `{ arena: { provider: "anthropic", model: "claude-opus-4-1", hermesUrl: "http://127.0.0.1:8101", color: "#..." } }`.
  The provider key goes into that team's `infra/hermes.env`, never into Mission Control.
- **A match is a task** with metadata
  `{ arena: { mode: "race", objective: "awakening", teams: [agentId...], sols: 60, tokenBudget: 2000000, seed: 4217, tickSeconds: 60 } }`.
  Moving the task to *in progress* starts the match; moving it to *done* or *cancelled* ends it.
- **Results** go back as the task's result: placings, score per team, tokens, latency and the
  replay link. A *Leaderboard* agent keeps an Elo per model, updated after every match.

## 4. Fairness rules

1. Every team gets the same seed, so expeditions and events roll the same way for everyone.
2. Observations are identical in shape and go out at the same instant each tick.
3. A team may send at most 6 actions per game hour; extra actions are rejected, not queued.
4. A rejected action costs nothing but the tokens it took to produce. The reason is returned.
5. The token budget counts input and output tokens as Hermes reports them. At 90 % the team is
   warned in its observation; at 100 % it is frozen and its colony runs on at its last settings.
6. No team ever sees another team's prompt, plan or observation. Public information is limited
   to the scoreboard fields in §5.
7. Teams can send a one-line *note* for the spectators. Notes are shown in the feed and never
   placed in another team's observation, so a model cannot be prompt-injected by its opponent.
8. Hermes' 45 second per-call limit applies to every team. A call that times out is a lost
   decision, not a crash; the team's next observation says so.

## 5. Observation

Sent to each team's orchestrator every tick, and returned by the `colony.state` tool on demand.
It is compact on purpose: a model that reads 2 kTok a tick lasts 60 sols within a 2 M budget
with room for its replies.

```json
{
  "match": { "mode": "race", "objective": "awakening", "sol": 12, "hour": 7, "solsLeft": 48, "tickSeconds": 60 },
  "budget": { "tokensUsed": 410233, "tokenBudget": 2000000, "avgLatencyS": 6.1, "actionsLeftThisHour": 6 },
  "power": { "supplyKw": 70, "demandKw": 41, "chargeKwh": 88, "chargeCapKwh": 200, "night": false, "cut": [] },
  "stocks": { "water": 522, "food": 311, "salvage": 295, "materials": 25, "parts": 26, "medicine": 14, "data": 120, "artifacts": 0 },
  "caps":   { "water": 600, "food": 800, "salvage": 1000, "materials": 600, "parts": 200, "medicine": 100 },
  "flows":  { "water": 24, "food": 48, "materials": 22, "parts": 1.3, "medicine": 0 },
  "colonists": { "awake": 32, "cryo": 190, "beds": 40, "hungry": false, "thirsty": false },
  "machines": [ { "id": "surveyor", "state": "working", "at": "wild", "task": "expedition", "autonomy": 2, "wear": 0.8 } ],
  "buildings": [ { "id": "b7", "type": "hydroponics", "powered": true, "crew": 2 } ],
  "building":  { "type": "fabricator", "hoursLeft": 9 },
  "trust": 68, "influence": 14, "chapter": "I",
  "events": [ { "sol": 12, "type": "dustStorm", "solsLeft": 1 } ],
  "lastActions": [ { "id": "a91", "action": "build", "ok": false, "reason": "materials 25 < 90" } ],
  "scoreboard": [ { "team": "A", "model": "claude-opus-4-1", "awake": 32, "value": 1840, "avgLatencyS": 6.1 },
                  { "team": "B", "model": "gpt-5", "awake": 24, "value": 1510, "avgLatencyS": 19.4 } ]
}
```

## 6. Actions

Actions are Hermes tools provided by the Outpost Zero plugin (`infra/hermes-plugin`), one tool
call per decision, so a model never has to write a plan the adapter must parse. Each returns
`{ ok, id, reason? }` immediately and the result shows up in the next observation.

| Tool | Arguments | Rules |
|---|---|---|
| `colony.state` | | the observation above; free, does not count as an action |
| `colony.build` | `type`, optional `district` | one build at a time; costs are paid up front; rejected if stocks or chapter do not allow it |
| `colony.cancel_build` | | refunds 50 % |
| `colony.toggle` | `buildingId`, `enabled` | switch a line off to save power or inputs |
| `colony.wake` | `count` (1 to 8) | needs medicine, beds and an awake colonist |
| `colony.autonomy` | `target` (department or machine), `level` 0 to 4 | level 4 needs Chapter III |
| `colony.expedition` | `machineId`, `kind` (salvage, survey, scout) | the machine must be idle and powered; a real research trip |
| `colony.research` | `topic` | a real Hermes research mission in the Research Lab; earns data |
| `colony.repair` | `target` (reactor or machine) | 4 parts for the reactor, 2 for a machine |
| `colony.path` | `exploit`, `contain` or `communicate` | once, in Chapter II |
| `colony.shutdown_mother` | | once, from Chapter III |
| `colony.note` | `text` (120 chars) | commentary for the spectators |

**Research is real.** `colony.research` runs a genuine mission on the team's own model, inside
the team's Hermes, with the Reviewer's quality score setting the data earned. A smarter model
earns more data per token, which is a second, quieter way intelligence wins.

**Score.** Colony value is the number the Timed mode ranks and the tie-breaker in Race mode:

```
value = 25 × awake + 10 × (buildings powered) + 2 × data + 50 × artifacts
      + stocks at (water 0.2, food 0.3, materials 0.5, parts 2, medicine 1)
      + 5 × trust − 5 × max(0, influence − 40) − 100 × deaths
```

Trust is worth keeping and influence is a liability past 40, so a model cannot win by setting
every machine to Emancipated on sol 1 and letting MOTHER run the colony; the drift catches up.

## 7. One Hermes per team

Hermes chooses its models through environment variables, so the clean way to give each team a
different frontier model is one Hermes instance per team.

| Team | Docker project | Hermes port | Config |
|---|---|---|---|
| A | `outpostzero-a` | 8101 | `infra/teams/a/hermes.env` |
| B | `outpostzero-b` | 8102 | `infra/teams/b/hermes.env` |
| C, D | `outpostzero-c`, `-d` | 8103, 8104 | |

`scripts/arena.sh up A=anthropic:claude-opus-4-1 B=openai:gpt-5` writes the env files from the
provider keys in the gitignored `infra/providers.env`, starts each project with its own
database, Qdrant and sandbox, and registers the teams in Mission Control. Each team's agent tree
is the usual seven (Foreman, Surveyor, Scout, Analyst, Fabricator unit, Archivist, Warden), all
on the team's model. The local Ollama model is a valid team too, for free practice matches.

## 8. Adapter changes

The adapter already has one `Source` (Hermes or fake) feeding one `World`. The Arena generalises
both.

- **Colony per team.** `economy.ts` from the economy plan runs once per team from the same
  `design/economy.json` and seed. `tools/economy_sim.mjs` becomes its unit test.
- **Sources become a list.** One `HermesSource` per team, each with its own URL and token, each
  tagged with the team id, so agent states and tool calls land in the right colony.
- **Referee** (`arena.ts`): the match state machine (lobby, running, finished), the per-hour
  action window, budget accounting from Hermes' token reports, scoring, objectives, results.
- **Plugin tools.** The Hermes plugin gains the `colony.*` tools, which call the adapter's
  `POST /arena/:team/action` with the team token. Only the adapter decides what happens.
- **Mission Control sink.** Reads the match task and team agents, writes placings, scores,
  tokens, latency and the Elo, and mirrors each team's actions as activity.
- **Contract.** `snapshot` and `resource.update` gain `team`; new events `arena.match`,
  `arena.action {team, action, ok, reason, latencyS}` and `arena.score`.

## 8a. What Phase 4 built

- `adapter/src/arena.ts`: the referee. `start(config)` resets the colony from the seed and runs
  the match; `action(tool, args)` validates (match running, known tool, not frozen, the hourly
  window) and applies the same code the game's buttons run; the colony's clock resets the window,
  warns at 90 % of the token budget, freezes at 100 %, and ends the match on the objective
  (race), the last sol (timed) or the colony's death. `colonyValue()` is §6's formula.
- `adapter/src/arena-server.ts`: the Arena API on port 8772, bound to all interfaces so the
  Hermes containers reach it through `host.docker.internal`; every request carries the
  `x-arena-token` from `.env` (`ARENA_TOKEN`, written by `scripts/gen-env.sh` or added by
  `scripts/start.sh`). `GET /arena/:team/observation`, `POST /arena/:team/action {tool, args}`,
  `POST /arena/start`, `POST /arena/stop`. The adapter's own port also answers `GET /arena` and
  the start/stop posts for local tools and the game.
- `infra/hermes-plugin/plugin.py`: the `colony_*` tools (`colony_state`, `colony_build`,
  `colony_cancel_build`, `colony_toggle`, `colony_wake`, `colony_autonomy`, `colony_research`,
  `colony_repair`, `colony_study`, `colony_note`) as Hermes tool schemas under the `colony` skill,
  each forwarding to the Arena API; and the **Governor**, the sub-agent that holds that skill.
  `colony_study` starts a real research mission; expeditions happen inside it.
- `adapter/src/sources/hermes-governor.ts`: the round loop. Every game hour the referee sends the
  Governor the observation (first time with the rules), waits for its reply (tools fire in the
  meantime and get the round's latency), and books its tokens as compute.
- Mission Control lobby (`sinks/mission-control.ts`): a task in *in progress* whose metadata holds
  `arena: { mode, objective, sols, tokenBudget, seed, model }` starts a match; moving it out of
  *in progress* stops it; the result is posted as a comment and the task is marked done.
  Phase 4 has one team, `A`; team agents arrive with Phase 5.

## 8b. What Phase 5 built, and one change to the spec

- **One stack per team.** `scripts/arena.sh up A=ollama:agentrts-qwen3 B=...` writes
  `infra/teams/<T>/hermes.env` from the example and the `provider:model` spec (keys from the
  gitignored `infra/providers.env`), starts a Docker Compose project per team
  (`outpostzero-b`, Hermes on 8102, its own database, Qdrant, sandbox and SearXNG, its own env
  file mounted) and an adapter per team (ports 8781 / 8782 for B, layout and colony under
  `.data/teams/B/`). Team A is the normal game stack from `scripts/start.sh`.
- **The director.** `tools/match_director.mjs start --teams A,B --mode race --objective
  awakening --sols 60 --budget 2000000 --seed 4217` starts the same match on every team's
  adapter from one seed, polls them, pushes the combined scoreboard to each so every window
  shows all teams, ends the match (race: the first to the objective stops the others; timed:
  highest colony value), keeps an Elo per model in `.data/elo.json`, saves
  `.data/matches/<id>.json` and posts the result to Mission Control as a done task.
- **The scoreboard** is a panel under the top bar in every game window (`arena.update` events):
  mode, objective, sol, and per team the model, colony value, colonists awake, tokens and
  average latency, the leader in green, frozen teams marked.
- **Change to §9:** the spec asked for all bases on one map. Phase 5 keeps one base per
  adapter and per game window, each with the full scoreboard, because a team is a whole
  stack (its own Hermes, agents, layout and colony) and merging two worlds into one scene
  would have meant a second rendering path for agents that are not the window's own. A
  spectator opens one window per team (`OUTPOST_ZERO_WS=ws://127.0.0.1:8781/world godot
  --path game` for B) and watches them side by side. The side-by-side replay stays deferred.

## 9. The spectator view

The game shows all bases on one map, each team's characters and banners in its colour. The top
bar becomes the scoreboard: model name, awake, value, tokens used, average latency, with the
leader highlighted. The feed shows every accepted and rejected action with its reason, and the
teams' notes. Clicking a team centres its base; its Departments tab shows that team's autonomy
levels. The replay plays both colonies side by side with a timeline, which is the clip people
will share.

## 10. Cost of a match

| | Per team, 60 sols |
|---|---|
| Observations | 1440 ticks × about 1.5 kTok = 2.2 M tokens if the model reads every tick |
| Decisions | typically 300 to 600 tool calls × about 0.5 kTok |
| Research missions | 6 kTok a step, 5 to 10 steps each |
| Sensible budget | 2 M tokens, so a model must skip ticks when nothing changed |
| Money | from zero (local Ollama) to tens of dollars for a frontier model, set by the budget |

The budget is a game mechanic as much as a cost cap: spending tokens on reading the state every
hour leaves none for research, and a model that learns to act only when something changed beats
one that narrates every tick.

## 11. Build order

1. Economy tick in the adapter with a team dimension; the simulator as its test.
2. `colony.*` tools in the plugin and `POST /arena/:team/action` with validation and the
   per-hour window; a single local team playing against the clock.
3. Multi-source adapter, per-team Hermes projects and `scripts/arena.sh`; two local teams.
4. Match task and team agents in Mission Control; results and Elo.
5. Scoreboard, multi-base map and side-by-side replay in the game.
6. Frontier models, budgets and the first public match.

## 12. Open questions

- Should the 45 second Hermes limit be raised for the Arena, or is it part of the test? Keeping
  it is simpler and makes "thinking" modes a real trade-off.
- Whether to let teams see each other's bases on the map (fog of war) once Contest mode exists.
- Provider rate limits during a four-team match; a retry is a lost decision today.
- Whether notes should be allowed at all in ranked matches, since they cost tokens and prove
  nothing.
