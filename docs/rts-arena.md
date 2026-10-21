# RTS Arena: AI models play Outpost War

Built 2026-10-20 from docs/rts-arena-plan.md. Any Outpost War player can be an AI model (Claude,
GPT, a model on OpenRouter, or the local Ollama model), the scripted computer player or you. A
battle is set up on the Arena Setup page, Outpost War tab (http://127.0.0.1:8790/#war):

1. **Map**, **Battlefield** (one of Outpost Zero's ten, random or none; docs/outpost-war.md) and **Players**: 2 to 4 on Plain & Simple, 2 to 8 on Big Arena. One card per player.
2. On each card, **Played by**: *AI model* (then **Provider**, **Model** and **API key**), *Scripted
   computer player* or *Human (you)* (one at most).
3. **Speed** (0.5× suits models), **time limit** in game minutes, **token budget** per model.
4. **Start battle**. The page lists each model's status, turns, tokens, average turn time,
   orders (and how many were refused) and its last orders; at the end, the winner and each side's
   units and buildings.

Keys are kept per provider in `infra/keys/<provider>.key` (600, gitignored): one Anthropic key
serves every Claude player. A key saved on an Outpost Zero team for the same provider, or
`<PROVIDER>_API_KEY` in `infra/providers.env`, also serves. *Test key* sends one short request.

## Models

Each player card's **Model** list is asked of the provider with the saved key (Anthropic's and
OpenAI's model lists, OpenRouter's tool-capable models, the models on Ollama), refreshed every 15
minutes. OpenAI's reasoning models get low reasoning effort; the newer ones (GPT-5.4 and later)
take tools on chat completions only with reasoning off, which the gateway switches to by itself.
GPT-6 Astra and GPT-6.1 Sol allow neither and are not offered (they need the Responses API).

One mid-battle turn, timed 2026-10-21 (two runs each):

| Model | Answer time |
|---|---|
| GPT-4.1 mini, GPT-5.4 mini / nano | 1 to 2 s |
| GPT-6 Sol, GPT-5.6 Sol / Luna, GPT-6 Luna, GPT-5.5, Claude Haiku 5.5 | about 2 s |
| Claude Sonnet 5.5 | 3 to 5 s |
| Claude Fable 5.1, Claude Opus 5.5 | 4 to 6 s |
| GPT-5 mini / nano | 6 to 10 s |
| GPT-5 | about 16 s |

## Prompt logs

Every battle with model players is logged in `battle-logs/<battle id>/` (gitignored), linked from
the Outpost War tab under the result:

- `battle.json`: the setup, the result and each model's totals (turns, tokens, orders, refusals).
- `<colour>.md`: a readable transcript per model: the system prompt once, then every turn with the
  prompt it was sent (what its side could see and its last results), its reply and tool calls,
  each order's result, the answer time and tokens.
- `<colour>.jsonl`: the same, one JSON line per turn, for tools.

Battles before 2026-10-21 were not logged; only their totals and last orders were kept in memory.

## How a model plays

```
Arena Setup page ── battle card ──> battle service (adapter/src/battle-main.ts, :8796)
                                      Commander per model player (adapter/src/battle/commander.ts)
                                        │  observe / order over the game link (war.observe, war.order)
                                        ▼
                                    game window: ModelPlayer (game/source/match/players/model/)
                                        carries orders out with Open RTS's own actions
Commander ── chat with tools ──> key gateway (tools/arena_setup.mjs, :8795, /llm/war/...) ──> provider
```

Each turn the Commander asks the game what its side can see, sends that to the model in a fresh
chat with six order tools, and has the game carry out the calls (at most 8 per turn). The results,
including refusals with their reason ("tank costs a 3, b 1; you have a 0, b 0"), open the next
turn. The game never waits: a slow model loses tempo.

- **Orders:** `build(structure, near)`, `train(unit, count)`, `gather(resource, workers)`,
  `attack(target, units)` (an attack-move), `move(units, to)`, `scout(to, units)`. Places are
  `base`, `center`, a grid cell (`A1` to `J10`, columns west to east, rows north to south), a
  player colour (their start position) or an id. Units are `army`, `tanks`, `helicopters`,
  `drones`, `workers` or ids. Ids never look like cells: `w3` worker, `t2` tank, `hc1`
  helicopter, `dr1` drone, `cc1` `vf1` `af1` `gt1` `at1` buildings, `x7` an enemy, `ra2`/`rb4`
  deposits.
- **What a model sees:** resources, its units (type, health, cell, what each is doing), its
  buildings (what they are training, how far construction is), enemies in sight, enemy buildings
  where they were last seen, deposits it has seen, every player's start position and who is still
  alive. Fog is honest: only what its own units see, whatever the screen shows.
- **Standing behaviour:** idle workers gather (the resource the model last chose for them, else the
  scarcer one), an unfinished structure gets the nearest worker, and combat units with nothing to
  do fight anything in range. So a side whose model is thinking, failing or out of budget still
  defends itself.
- **Economy help (the same for every side):** the view's `economy` gives income over the last
  minute, workers on each resource, `useful_workers` (about 3 per deposit near home) and what the
  side can afford now. Workers past `useful_workers` are refused with the reason. A build ordered
  before it is affordable is planned: its cost is set aside (training cannot spend it) and it starts
  by itself when the resources are there (`planned_builds`, `planned_build_news`). The system prompt
  explains the trap fast models fell into on 2026-10-21 (a worker every turn, so never the 6 a a
  factory needs) and a working opening.
- **Fair gathering:** a worker goes to the deposit nearest its own command center, never one
  nearer an enemy's start unless nothing else is left (choosing by the worker's own position sent
  one side's workers into the enemy base once its home deposit ran out). Repeating `gather` or
  `attack` every turn leaves workers mid-trip and units mid-fight alone; it used to restart them,
  which kept a side's income at zero.
- **Spectating:** with no human player the camera starts over the middle of every base, zoomed
  out to show them all.
- **Budget:** tokens per model player, charged with the providers' real counts. At the budget the
  side is frozen (its units keep their last orders). Six failed calls in a row also stop it.
- **Speed of thought:** GPT-5 and the o-series are asked for low reasoning effort. Ollama players
  take turns on the one local model.
- **End:** as any Outpost War battle: the last side standing, or at the time limit the side ahead
  on army and building value.

## Checked

- `adapter/test/commander.test.ts`: the card's model players and budget; a commander observing,
  ordering, carrying refusals into the next turn and stopping at its budget.
- 2026-10-20 live: the local model (blue) against the scripted player played 20 turns (about 4 s
  each, 63 orders) and lost at 1:51 of game time; two local-model players took turns; one sample turn
  each from Claude Sonnet 5.5 (1.8 s) and GPT-5 (14.4 s) through the gateway returned valid orders
  (train workers, scout). `tools/war_smoke.sh --quick` still passes.

Not built yet from the plan: Elo for RTS battles, the recorder for them, and a spectator
scoreboard overlay in the game window.
