# Architecture

> Outpost Zero adds, on top of this Agent RTS architecture, the colony economy (`adapter/src/economy.ts`,
> [economy.md](economy.md) §13 for the contract additions), the map's economy kinds (`layout.ts`),
> the Arena referee and API (`arena.ts`, `arena-server.ts`, [arena.md](arena.md) §8a–8b), the
> Governor client and MOTHER's voice (`sources/hermes-governor.ts`), the Mission Control lobby in
> the sink, and the `colony_*` tools in the Hermes plugin. The three foundations stay unmodified.

```
                 ┌──────────── game (Godot 4, fork of Open RTS) ────────────┐
   player ─────▶ │ command bar · approvals · roster · results               │
                 │ agents walk between buildings, badges show state         │
                 └──────────────▲───────────────────────┬───────────────────┘
                     world feed │ ws://127.0.0.1:8771/world │ commands
                 ┌──────────────┴───────────────────────▼───────────────────┐
                 │ adapter (Node 23.6+, TypeScript, ~2.4k lines)             │
                 │  World store ◀── Source: FakeSource | HermesSource       │
                 │       │                     │ WS + REST                   │
                 │       └──▶ MissionControlSink                             │
                 └──────────────────────┬──────────────┼────────────────────┘
                            REST + SSE  │              │
              ┌─────────────────────────▼──┐   ┌───────▼────────────────────┐
              │ Mission Control :3001      │   │ Hermes Synapse :8101       │
              │ tasks, agents, cost, feed  │   │ Jarvis → research, scout,  │
              │ (approve = quality review) │   │ insights, code, writer,    │
              │                            │   │ reviewer · Ollama          │
              └────────────────────────────┘   └────────────────────────────┘
```

All three foundations stay unmodified in `vendor/`, except for two small fixes in the game fork.
The only custom integration code is the adapter, so any of the three can be swapped out.

## The world contract (`adapter/src/contract.ts`)

On connect the server sends a `snapshot`, then events, each with an increasing `seq`:

| Event | Meaning |
|---|---|
| `agent.state` | `{id, role, state, location, taskTitle, detail, progress}` |
| `task.upsert` | A unit of agent work (one per orchestrator step, plus the approval step) |
| `mission.upsert` | The mission's status: `planning → running → completed / failed / cancelled`, plus the result (Markdown) and a Mission Control link |
| `approval.upsert` | A Human Approval request: `pending → approved / rejected` |
| `resource.update` | Tokens (estimated), cost in USD, and the cost budget |
| `log` | A line for the in-game feed |
| `replay` | Reply to `replay.request`: a recorded mission (start states plus every timestamped event until shortly after it ended). Only sent to the client that asked. |

Commands from the game: `mission.create {title}`, `approval.resolve {id, approved}`, `mission.cancel`,
`replay.request {missionId?}`. The adapter keeps the last 5 missions; `GET /replay?missionId=` also serves them.
The same commands can be sent as `POST /command` (see `scripts/run-mission.sh`); `GET /state`
returns the snapshot.

## States and places

| State | Where the agent goes | Set by |
|---|---|---|
| `thinking` | stays put, with a spinning ring | Orchestrator planning |
| `working` | the door of a building, which glows | Delegation, or a tool call (tool → building) |
| `waiting` | Rally Point | Blocked on another agent (fake source) |
| `approval` | Human Approval | The final report is waiting for a person |
| `error` | Repair Bay | A step failed |
| `complete` / `idle` | the agent's home building | Step finished / mission over |

Agents map from Hermes as follows: the orchestrator (`jarvis`) → Commander, `research` →
Researcher, `scout` → Scout, `insights` → Analyst (reasoning only), `code` → Coder,
`writer` → Writer (reasoning only), `reviewer` → Reviewer (reasoning only). Tools map to departments: search tools →
Research, code and shell tools → Engineering, notes and RAG → Knowledge; the agent drives to
its own home if that building hosts the work, otherwise the nearest building of that
department. Otherwise each role has a home building.

## Pacing

Hermes steps can take 200 ms or 3 minutes. Each agent in the game keeps a small queue. A state
that changes location is applied only after the agent has arrived and stood still for at least
1.2 s, or after 9 s of travel; at most 4 states are queued. So every step is visible, and long
steps simply show the agent working. Roster cards follow what the 3D agent shows, not the raw
feed.

## Mission Control mapping

| Outpost Zero | Mission Control |
|---|---|
| The 7 agents (Commander included) | agents `rts-commander`, `rts-researcher`, `rts-scout`, … (busy / idle / error, plus last activity) |
| Mission | Task "Mission: …" assigned to `rts-commander`; the final report is added as a comment |
| Step | Task assigned to the agent: `assigned → in_progress → done` (via an Aegis review) or `failed` |
| Human Approval | Task in `review`. Approving it in Mission Control (quality review → approve) approves it in the game, and the reverse also works. |
| Tokens and cost | `POST /api/tokens` at the end of a mission, under session `rts-commander:<mission>` |
| Mission events | Activity feed (`mission:start`, `approval:requested`, `mission:complete`, …) |

## Mission replay

When a mission completes or fails, the game asks the adapter for its recording and plays
it back as a 12–20 s highlight reel. Holographic ghost agents re-walk the mission, and
buildings, conduits and beams react as they did live. The timeline shows a marker per step
in the agent's colour, and log lines appear as captions. Pause, speed (×0.5–×4) and Close
are available; the report opens when the replay ends (or straight away with **View
report**). **▶ Replay** in the report panel plays it again.

## Build mode (player-designed base)

The adapter owns the base layout (`adapter/src/layout.ts`, saved to `.data/base.json`):
buildings (position, model, colour, capability), the two spots, and the characters. A
building's capability is its department (Command, Research, Engineering, Knowledge, Commons),
which sets its colour and its district: the map is a 3×3 grid of districts with 2×2 slots on
a 7-unit lattice on a 44-unit map, and `layout.organise` moves every building into its district's slots. The
snapshot carries it, and edits arrive as `layout.*` commands (`building.upsert/remove`,
`spot.move`, `agent.upsert/remove`, `organise`, `terrain`, `reset`). They are validated (map bounds, spacing,
limits, core buildings and the core team can't be deleted), applied to the world (agents
added or removed live), saved, and synced to Hermes. Each custom character becomes a
sub-agent `rts_<id>` under the orchestrator, with its job as the system prompt and its skill
mapped to `web_search` or a no-tools reasoning skill. Tool calls route to the agent's own
building or the nearest one of the matching department, and the mission prompt lists the whole
current team.


## Who may talk to the adapter

The adapter listens on 127.0.0.1 only and accepts HTTP and WebSocket requests from local
tools alone: a request that carries an `Origin` header (every web page does) or a `Host`
other than 127.0.0.1/localhost on its port is refused, and `POST /command` must be
`application/json` (at most 64 KB). So a page open in a browser cannot start missions,
approve them or read reports. Hermes' shell tool (`execute_command`) is redirected by the
Outpost Zero plugin into the isolated sandbox container, so an agent steered by a web page
cannot read Hermes' keys or change its code.
