# Phase 0 findings

Spikes run on 2026-10-04 against the pinned commits in `infra/vendor.lock`. Raw captures of
real Hermes runs live in `adapter/test/fixtures/` (trimmed).

## Hermes Synapse (agent brain)

| Question | Finding | What we did |
|---|---|---|
| How to start a mission | WebSocket `/api/ws?token=…`, send `{"type":"chat_message","content","chat_id"}`. A socket processes one turn at a time. | One socket per mission. `chat_id = rts_<id>`, mapped to the `jarvis` orchestrator with `POST /api/history/{chat_id}/agent`, so Hermes always plans and delegates. |
| Auth | Every route needs a bearer token. `dev_master_token` is hard-coded as valid in `auth.py`. | Used for local only. The backend port is bound to `127.0.0.1`. |
| Live telemetry | No token streaming, and `/api/office/state` events are never written. The usable signals are `trace_update` (planning, `Router/Route` "Step i/N: Delegating to agent 'X' (id)", per-agent finish traces) and `activity_log` (per-tool calls, but only for tool-loop sub-agents). | `HermesTranslator` derives agent state from these two streams. Traces carry `session_id == chat_id`, so they are filtered per mission. |
| Human approval | `ApprovalQueue.request_approval` is never called, and nothing in Hermes waits on a human. | The adapter owns the checkpoint: the final report is held at the Human Approval building until a person approves it, in the game or in Mission Control. |
| Budget | `BudgetGuard` is never enforced. Costs are USD from a hard-coded price table; tokens are char/4 estimates. | Shown as-is and labelled as estimates. |
| Roster | The planner sees every child of `jarvis` (9 seeded agents, incl. `sysops`, which has a shell). Seeds are re-upserted at startup, but `parent_id` survives. `get_retired_agent_ids` deletes and then immediately re-seeds, so it is useless. | The adapter "benches" unused agents by re-parenting them (and strips sysops' skills). A Hermes plugin (`infra/hermes-plugin`) seeds `reviewer` and `insights`. |
| Built-in analyst | Writes and runs plotting code in a self-correcting loop. With a 4B local model it exceeds the 45 s per-call timeout and falls back to hard-coded `google/gemini-*` names (404 on Ollama). | Replaced by the plugin's `insights` agent (a plain tool loop). |
| Docker | Upstream mounts `/var/run/docker.sock` into the backend, but no production code uses it. `execute_command` is LLM-callable. | Dropped the socket mount in `infra/hermes.override.yml`. |
| Hard-coded hostnames | The sandbox is called as `http://jarvis-sandbox:8080`. | Kept as a network alias. |
| Web search | SearXNG first, then DuckDuckGo/news/Wikipedia scraping. No key needed. | Added a SearXNG container with its JSON API enabled. |
| Local LLM | `qwen3:8b` thinks for minutes and times out. `qwen3:4b-instruct` makes a correct tool call in about 2 s on an M1 Pro, but Ollama's default 4K context overflows. | `agentrts-qwen3` = `qwen3:4b-instruct` with `num_ctx 16384` (`infra/ollama/Modelfile`). A typical mission takes 2–5 minutes. |

## Open RTS (visual world)

- It runs on Godot 4.7 with no porting. The fork is mostly additive (`game/source/agent/`).
- **Godot 4.4+ regression (fixed):** `MovementObstacle` snapped structures to the navmesh before
  the asynchronous bake finished, which teleported every structure to the map origin.
- The match ends with a "victory" when only one player exists. Disabled with
  `FeatureFlags.handle_match_end = false`.
- The camera script asserted a 30° pitch. Pitch and rotation are now exports
  (`expected_pitch_degrees`, `allow_rotation`).
- An orange height-fog quad and the fog of war are hidden. The ground is a custom grid shader.

## Mission Control (operations layer)

The upstream is `builderz-labs/mission-control`; `myeway/hermes-mission-control` is a copy of it.

- `generate-env.sh` does not save the credentials it prints. `scripts/gen-env.sh` writes `.env` directly.
- Webhooks refuse localhost targets, so the adapter listens on the SSE stream `GET /api/events` instead.
- A task only reaches `done` through an approved Aegis quality review (`POST /api/quality-review`).
  This doubles as the Human Approval bridge.
- `POST /api/adapters` and `POST /api/logs` save nothing. Activity is posted via `POST /api/hermes/events`.
- Unknown `@mentions` in task text are rejected, so the sink escapes `@`.
- Rate limits (60 mutations/min) are disabled with `MC_DISABLE_RATE_LIMIT=1` in dev mode.
