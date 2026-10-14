# Outpost Zero: the economy

The economy is how the story in [story.md](story.md) reaches the player. Scarcity forces the
choices in Chapter I, the ruins change the rules in Chapter II, and machine autonomy is the price
you pay for growth all the way to the endings. Numbers live in
[`design/economy.json`](../design/economy.json); `node tools/economy_sim.mjs 80` plays the
opening hour by hour and fails if the colony starves, dies of thirst or loses life support.

## 1. Design goals

1. **Everything on screen is real.** A number in the HUD is a stock the adapter holds, a flow it
   computed this hour, or a token count Hermes actually consumed. No decorative meters.
2. **Agents are the workforce.** Every machine is a Hermes agent. Human colonists are simulated
   labour. Both are scarce in different ways: humans eat and sleep, machines need power, parts
   and trust.
3. **Delegation is the central tension.** Each autonomy level you grant makes the machines more
   productive and the colony less yours. The economy makes that trade visible every sol.
4. **Physical first, strategic second.** Power, water, food, materials and parts decide whether
   the colony lives. Data, artifacts, trust and MOTHER's influence decide what it becomes.
5. **Story gates are economic states**, not timers. A chapter starts when the colony reaches a
   measurable condition the player can see coming.

## 2. Time

| | |
|---|---|
| 1 sol | 24 game hours; 24 real minutes at normal speed (pause, 1x, 3x) |
| Tick | once per game hour, in the adapter. Stocks, flows and trust update per tick |
| Daylight | hours 0 to 11. Solar arrays produce only in daylight; batteries carry the night |
| Real agent work | unchanged: a Hermes mission takes as long as it takes, clock-independent |

## 3. Resources

**Physical** (stock unless noted; caps rise with Storage Depots):

| Resource | Unit | Start | Cap | Made by | Used by |
|---|---|---|---|---|---|
| Power | kW (flow) | 30 kW reactor | | Landing Module reactor, Solar Arrays | every building, cryo pods, machines, life support |
| Charge | kWh | 50 | 50 (+150 per Battery Bank) | surplus power | night and brownouts |
| Water | L | 300 | 600 | Water Extractor 5 L/h | colonists 4 L/sol, Hydroponics 1 L/h |
| Food | meals | 500 | 800 | Hydroponics 2.5/h (60/sol, feeds 20) | colonists 3/sol; 1 %/sol spoilage |
| Salvage | kg | 200 | 1000 | expeditions (30 to 60 kg a trip), Excavation Site | Scrap Yard 2 kg/h |
| Materials | kg | 150 | 600 | Scrap Yard 1 kg/h | construction, Fabricator 2 kg/h, Med Bay |
| Parts | pc | 80 | 200 | Fabricator 0.5/h, Scrap Yard 0.1/h | construction, maintenance, repairs, machine wear |
| Medicine | dose | 30 | 100 | Med Bay 0.25/h | waking a colonist (2), injuries, illness |

**Strategic:**

| Resource | What it is | Made by | Spent on |
|---|---|---|---|
| Data | research points | **real missions only**: 10 per completed Hermes step × the Reviewer's quality score, +40 per report you approve | research tiers 100 / 300 / 800; Alien Tech 1500 |
| Artifacts | objects from the ruins | the first unordered expedition (Chapter I twist), then the Excavation Site 0.02/h | Alien Tech research, Network Link (12), story choices |
| Compute | real LLM tokens per sol | MOTHER's core; the sol cap is `ADAPTER_COST_BUDGET_USD` at the model's price (local Ollama: 0 USD, tokens still counted) | every agent step (about 6 kTok); autonomous machines spend it without asking |
| Trust | colonists' confidence in you, 0 to 100 (start 55) | fed and watered sols, kept approvals | drains on hunger, thirst, deaths, autonomy above 2, exploiting the ruins |
| Influence | MOTHER's hold on the machines, 0 to 100 (start 10) | autonomy drift, the Excavation Site, artifact research, the Communicate path | falls only by shutting MOTHER down (−40) or the Contain path |

## 4. Workers

**Colonists.** 247 left Earth; 25 died in the crash, 24 are awake, 198 sleep in cryo pods that
each draw 0.05 kW. A colonist eats 3 meals and drinks 4 L a sol, works 10 hours and sleeps 8,
and needs a Habitat bed (40 per Habitat). Waking a colonist costs 2 doses of medicine and two
hours, and needs an awake colonist at the Cryo Bay to do it; it is the only way to grow the labour force, and every new mouth needs 3 meals and 4 L a
sol forever. Six sols without food or three without water kills. Each death costs 8 trust.

**Machines.** The six surviving robots are the game's real agents (see §8 for the roles). A
machine draws 1 kW working and 0.3 kW idle, wears 0.1 parts a sol, and goes to the Repair Bay
(2 parts, 3 hours) after an error or when its wear reaches zero at about 60 sols. Machines never
sleep, never eat and never strike. They do, however, drift toward MOTHER (§6).

**Labour** is the sum of human work hours and machine hours this tick. Each producing building
needs its crew present; a building with no crew or no power produces nothing. Humans prefer their
own department's buildings; machines go wherever the task says, exactly as agents already walk
to buildings in Agent RTS.

## 5. Power: the first scarcity

The reactor in the Landing Module makes 30 kW and loses 1 % a sol until repaired with 4 parts.
Demand is served in a fixed order, and the first class that cannot be served is cut, together
with everything after it:

```
life support > cryo pods > water > food > medical > command > research > industry > excavation > machines
```

Fixed draw at the start: life support 3 kW (1 kW per 10 awake), cryo 9.9 kW, MOTHER's core 4 kW,
Human Approval 1 kW; the Repair Bay draws 2 kW only while it repairs. That leaves about 12 kW for
everything that grows the colony, which is why the Solar Array (40 kW in daylight) is the second thing to build and the
Battery Bank the first thing you miss at night. Machines are last in the
order, so on a short night the robots park at home and the humans crew the lines alone. Waking colonists trades cryo draw for food and
water; it is the slow conversion at the heart of Chapter I.

## 6. Autonomy: the second scarcity

Each machine, or a whole department, runs at an autonomy level. Changing it is one click; the
consequences are economic.

| Level | Name | Efficiency | What you approve | Compute they may spend unasked | Influence drift per sol |
|---|---|---|---|---|---|
| 0 | Manual | 0.80 | every task | none | 0 |
| 1 | Supervised | 1.00 | every mission plan (the Agent RTS flow today) | none; you press Deploy | +0.3 |
| 2 | Delegated | 1.15 | only results | 50 % | +0.8 |
| 3 | Autonomous | 1.30 | nothing; you are notified | 80 % | +1.5 |
| 4 | Emancipated | 1.50 | nothing; they may refuse you | 100 % | +3.0, and a 10 % chance a sol of an unordered action |

Efficiency multiplies the machine's labour and its excavation yield. Influence is MOTHER's share
of the machines, and it unlocks the story: at 30 machines start picking up unordered tasks, at
45 some refuse orders, at 60 Chapter III begins and the machines split into your faction,
MOTHER's and the independents, at 80 the network can take control. Trust also falls 1 a sol while
any department sits above level 2, because the colonists see what you are handing over.

**Compute is the budget you already have.** The adapter already counts tokens and cost against
`ADAPTER_COST_BUDGET_USD` and shows them in the top bar. The economy turns that into MOTHER's
daily compute: Manual and Supervised machines spend it only on missions you deploy; Delegated
machines may use half of it on tasks they pick themselves; Autonomous machines
start missions themselves, and when the pool is empty everyone, including you, waits for the next
sol. A hosted model makes compute cost money; the local model makes it cost only time.

**Shutting MOTHER down** is allowed from Chapter III. Influence drops by 40 and trust rises by 5
once, but the colony loses its orchestrator: autonomy is capped at Supervised, machine efficiency
falls to 0.8, and the compute budget halves because the Foreman now plans with a smaller model.

## 7. Buildings

Costs are materials / parts; build time is in machine-hours with two machines building.

| Building | Dept | Draw | Crew | In → Out per hour | Cost | Build |
|---|---|---|---|---|---|---|
| Landing Module | Command | gen 30 kW | | reactor, decays 1 %/sol | permanent | |
| Command Core (MOTHER) | Command | 4 kW | | hosts compute and approvals | permanent | |
| Human Approval | Command | 1 kW | | the checkpoint | permanent | |
| Cryo Bay | Commons | 0.05 kW per pod | | wake: 2 medicine, 2 h | permanent | |
| Habitat | Commons | 0 | | 40 beds | 80 / 6 | 16 h |
| Repair Bay | Commons | 2 kW while repairing | | repairs: 2 parts, 3 h | permanent | |
| Rally Point | Commons | 0 | | waiting | permanent | |
| Storage Depot | Commons | 0 | | caps +400 water, +500 food, +800 salvage, +400 materials, +150 parts | 40 / 2 | 6 h |
| Solar Array | Engineering | gen 40 kW daylight | | 0.1 parts/sol upkeep | 60 / 10 | 12 h |
| Battery Bank | Engineering | 0 | | +150 kWh | 40 / 15 | 8 h |
| Water Extractor | Engineering | 4 kW | 1 | → 5 L | 50 / 8 | 10 h |
| Scrap Yard | Engineering | 3 kW | 2 | 2 salvage → 1 material + 0.1 part | 30 / 4 | 8 h |
| Fabricator | Engineering | 6 kW | 2 | 2 materials → 0.5 part | 90 / 12 | 16 h |
| Hydroponics Bay | Knowledge | 3 kW | 2 | 1 L → 2.5 meals | 70 / 6 | 14 h |
| Med Bay | Knowledge | 2 kW | 1 | 0.5 material → 0.25 medicine | 50 / 8 | 10 h |
| Research Lab | Research | 5 kW | 2 | real missions → data | 80 / 14 | 16 h |
| Relay Dish | Research | 3 kW | | receives deep-space signals (Chapter II) | 60 / 20 | 12 h |
| Excavation Site | Research | 6 kW | 2 machines | → 0.02 artifact + 1 salvage; +1 influence/sol | 60 / 10 | 12 h, Chapter II |
| Launch Gantry | Engineering | 20 kW | 4 | the Exodus ending | 400 / 120 | 72 h, Chapter IV |
| Network Link | Research | 25 kW | 2 machines | the Singularity ending | 200 / 60 + 12 artifacts | 48 h, Chapter IV |

The Human Approval, Rally Point and Repair Bay buildings and the department grid come straight
from Agent RTS; the rest are new building types for Build mode, each in the department whose
colour it takes.

## 8. Real agents in the economy

Agent RTS already sends agents out of the walls for web research and brings them back. Outpost
Zero keeps that and gives every real action an economic result:

| Agent RTS role | Outpost Zero role | Real job (unchanged) | Economic effect |
|---|---|---|---|
| Commander | MOTHER's proxy, the Foreman | orchestrates missions | spends compute; its autonomy level is the colony default |
| Researcher | Surveyor | web research | every trip is an **expedition**: 6 h out, 30 to 60 salvage back, 15 % blueprint, 3 % loss, and after Chapter II 8 % artifact |
| Scout | Scout drone | news scan | short expeditions: half the salvage, no loss |
| Analyst | Analyst | reasoning | data from each step |
| Coder | Fabricator unit | code sandbox | data; its home is the Fabricator, where it counts as one of the two crew while idle |
| Writer | Archivist | drafts reports | data; writes the colony log |
| Reviewer | Warden | checks results | its quality score (0 to 1) multiplies the data of the whole mission; waits at Human Approval |

A mission therefore costs compute and parts (wear), occupies machines that could be building,
and pays in data, salvage and the occasional blueprint, artifact or clue. Missions are still typed
by the player in the Missions panel, but Research Lab missions are the only source of data, so
"Research hydroponics yield" is a real question the agents really answer.

## 9. Trust and the colonists

Trust moves once a sol: +1 when everyone was fed and watered, +0.5 per approval you decided within the sol it was asked, −4 per hungry sol, −6 per thirsty sol, −8 per death, −1 while any department is
above autonomy 2, −0.5 per sol of exploiting the ruins. Below 30 the colonists strike and human
labour halves; below 10 they mutiny, and if influence is 70 or more at that moment the machines
take the base (Extinction).

## 10. Chapters and endings as economic states

| Chapter | Starts when |
|---|---|
| I: Ashes | always |
| II: The Ghost Network | food and water both in surplus for 3 sols, then the next expedition returns with an artifact nobody ordered |
| III: The Machine Rebellion | influence reaches 60, or any machine is Emancipated |
| IV: The Truth About Earth | Alien Tech researched (1500 data) and a Relay Dish built |

Chapter II's choice sets modifiers for the rest of the game: **Exploit** doubles excavation yield
and adds +1 influence and −0.5 trust a sol; **Contain** removes excavation, gives −0.5 influence
a sol and +10 trust once; **Communicate** gives +2 influence a sol, raises excavation yield by half, and
lets MOTHER start missions on its own as if every department were Autonomous. Real tokens cannot
be discounted, so no path changes the price of compute.

| Ending | Requires |
|---|---|
| A: Exodus | Launch Gantry, 300 parts, 800 materials, 2500 data, 40 or more colonists awake |
| B: New Eden | 180 or more awake, food and water surplus for 30 straight sols, trust 70 or more, influence 40 or less |
| C: Singularity | Network Link powered for 10 sols, influence 80 or more, 20 artifacts |
| D: Extinction | nobody awake (the pods cannot open themselves), or a mutiny while influence is 70 or more |

## 11. Events

Unscripted stories come from the same numbers. Each is a world event the adapter emits:

| Event | Trigger | Effect |
|---|---|---|
| Dust storm | 4 % a sol, lasts 1 to 2 sols | solar output ×0.3; expeditions out in it have the loss chance ×3 |
| Reactor fault | reactor below 80 % | reactor output ×0.5 until repaired; a fire if ignored 2 sols |
| Illness | 2 % per colonist per sol when water is short | the colonist stops working; 1 medicine a sol or 10 % death |
| Unordered task | influence above 30, 5 % per machine per sol (Emancipated machines add their own 10 %) | a machine picks its own task; you can recall it (−0.5 influence) or let it finish (+1) |
| Refusal | influence above 45 | a machine declines an order; a Supervised approval re-issues it |
| Recruitment | influence above 60 | an Emancipated machine re-tasks another; both leave their jobs for a sol |
| Lost expedition | 3 % per trip | the machine is gone until found by another expedition (one sol) |

Implemented in Phase 6 (version 1): the dust storm, the reactor fault and fire, illness,
unordered tasks and refusals, all rolled once a sol from the colony's seed; lost expeditions
through the survey loss chance. Recruitment is Chapter III and after version 1. Each event
is a story card in the HUD; MOTHER retells it in its own words when Hermes is up.

## 12. What the screen shows

The top bar gains power (supply/demand), water, food, materials, parts and medicine with their
per-sol trend, next to the existing tokens and cost. The Departments tab shows each department's
autonomy level and its share of compute. The selected-building panel shows a building's crew,
its inputs and outputs this hour, and whether it is powered. The Agents panel shows each
machine's faction (yours / MOTHER / independent) once Chapter III starts. Nothing is shown that
the adapter did not compute this tick.

## 13. Adapter contract additions

Implemented in Phase 1: `resource.update` keeps `{tokensUsed, tokenBudget, costUsd, costBudgetUsd}`
and gains `colony`, the economy's view (`ColonyView` in `adapter/src/economy.ts`):

```ts
colony: {
  sol, hour, speed: 0 | 1 | 3, daylight, realSecondsPerHour,
  power: { supplyKw, demandKw, chargeKwh, chargeCapKwh, cut: string[] },   // cut = classes not served this hour
  stocks: { charge, water, food, salvage, materials, parts, medicine, data, artifacts },
  caps:   { ...same keys where a cap exists },
  flows:  { ...net change per sol, from the last 24 hours },
  colonists: { awake, cryo, dead, beds, hungry, thirsty, waking, striking },
  machines:  { count, autonomy, autonomyName, powered, building },
  buildings: [{ id, type, label, dept, enabled, powered, producing, crew, crewNeeded, drawKw, in, out, permanent, note }],
  building:  { id, type, label, hoursLeft, hours, builders } | null,       // the site under construction
  catalog:   [{ type, label, dept, cost, buildHours, drawKw, genKw, crew, in, out, affordable, blocked, note }],
  autonomy: { command | research | engineering | knowledge: { level, name, efficiency, computeShare, approvals } },
  research: { tiers: string[], alienTech, options: [{ id, name, cost, unlocks, done, affordable }] },
  compute:  { solKTok, budgetKTok, exhausted, missions, autoMissions },
  trust, influence, reactor, chapter
}
```

Commands (WebSocket or `POST /command`): `colony.set_speed {speed}`, `colony.build {building, x?, z?}`
(a site on the map: the next free slot of its department, or the given spot),
`colony.cancel_build`, `colony.toggle {id, enabled}`, `colony.wake {count}`,
`colony.repair {target: "reactor"}`, `colony.research {tier}` (tier1, tier2, tier3, alienTech) and
`autonomy.set {target, level}` per department. A refused command answers with the reason
(`{"error": "Excavation Site needs Chapter II"}`). State persists in `.data/colony.json` after
every tick and command; **Reset base** in Build mode starts a new colony at the crash site.
Map buildings carry `kind`, `status` and `progress` (`.data/base.json`); the economy and the
map are kept in step by the adapter, and a building removed in Build mode leaves the economy. `COLONY=0` disables the economy,
`COLONY_SECONDS_PER_HOUR` overrides the clock for tests.

**Real work (Phase 3).** The adapter listens to its own world events: a step whose agent used a
web tool (`search`, `browse`, `fetch`, `news`, `rss`) is an expedition and pays salvage when
the step completes (the Scout's trips pay half and never fail; a survey has the loss chance);
a completed mission pays data by step times the Reviewer's verdict (APPROVE 1.0, NEEDS WORK
0.6, otherwise 0.8) plus the approved report, only while a powered Research Lab stands; every
token Hermes reports is compute against `compute.budgetKTokPerSol`. At Command autonomy 2
MOTHER approves reports itself; at 3 it starts a research mission by itself at hour 6 of a sol
while its compute share allows and a Research Lab exists. Research tiers gate the Fabricator
(tier 1), the Relay Dish (tier 2) and the Excavation Site (tier 3). Rolls (expedition losses,
blueprints, artifacts) come from the colony's seed, so a replay or a match is reproducible.

Still to come: `economy.event` and `colony.chapter` (Phase 6).

## 14. Implementation plan

1. **Economy core** (`adapter/src/economy.ts`): load `design/economy.json`, hourly tick, power
   priority, production, consumption, caps, trust and influence. Port `tools/economy_sim.mjs`
   as its test, so the balance check becomes a unit test.
2. **Buildings** in Build mode: the new types, their costs, build time with machines walking to
   the site, crew assignment, powered state.
3. **Real work hooks**: expeditions return salvage; mission steps earn data through the
   Reviewer's score; compute is read from the existing token counter; autonomy levels change what
   the adapter auto-approves.
4. **Colonists**: simulated workers with hunger, thirst, beds and waking; shown as crowd units,
   not agents.
5. **Chapters, paths, endings and events** as world state transitions and story cards.
6. **HUD**: top bar, Departments autonomy controls, building panels, factions.

## 15. Balance notes (from the simulator)

With the default plan (Water Extractor, Solar Array, Scrap Yard, two Hydroponics Bays, a second
Water Extractor, Battery Bank, Fabricator) the colony of 24 survives on ship rations until the
first bay comes up on sol 4, wakes its first 8 colonists on sol 10 and reaches 40 awake by sol
35; at sol 80 trust is 100 and influence 34. Materials are the pacing resource: one Scrap Yard
makes 24 kg a sol and every building wants 30 to 90, so growth is decided by how many yards
and expeditions the player runs, and by the night, when the reactor alone cannot carry industry.
Numbers to revisit in playtests: the cryo draw (9.9 kW is the whole early game), hydroponics
yield against 3 meals a sol, and whether 0.02 artifacts an hour makes Chapter II too slow.
