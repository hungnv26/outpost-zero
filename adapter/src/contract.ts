import type { GameSettings } from "./settings-card.ts";
// World-state contract between the adapter and game clients.
// The adapter is the only writer; the game renders and sends back a small set of commands.
// Transport: WebSocket, JSON text frames. Server sends `snapshot` on connect, then events.

export const CONTRACT_VERSION = 1;

export type AgentState =
  | "idle" // at the Command Centre, nothing to do
  | "thinking" // planning in place
  | "working" // inside a building doing a task
  | "waiting" // blocked on another agent, at the rally point
  | "approval" // blocked on a human, at the Oversight Post
  | "error" // something failed, at the repair bay
  | "complete"; // finished its part, heading home

import type { BaseLayout } from "./layout.ts";
import type { ColonyView } from "./economy.ts";

// Buildings are player-defined (see layout.ts); ids are strings like "research_lab".
export type BuildingId = string;
export type SpotId = "rally_point" | "repair_bay";
export type LocationId = string; // a building id or a spot id

export type AgentRole = string; // the agent's id for built-ins, "custom" otherwise

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  state: AgentState;
  location: LocationId;
  taskId: string | null;
  taskTitle: string | null;
  detail: string | null; // e.g. current tool call, last error
  progress: number | null; // 0..1 when known
  updatedAt: number;
}

export type TaskStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  missionId: string;
  title: string;
  agentId: string | null;
  status: TaskStatus;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MissionStatus = "planning" | "running" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  title: string;
  status: MissionStatus;
  result: string | null;
  startedAt: number;
  endedAt: number | null;
  link?: string | null; // deep link to this mission in Mission Control, when mirrored
}

// A finished mission, kept so the game can list recent missions and reopen their reports.
export interface MissionRecord extends Mission {
  tasksDone: number;
  tasksTotal: number;
}

export interface Approval {
  id: string;
  missionId: string | null;
  agentId: string | null;
  tool: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

export interface Resources {
  tokensUsed: number;
  tokenBudget: number | null;
  costUsd: number;
  costBudgetUsd: number | null;
  colony?: ColonyView; // the colony economy (docs/economy.md); absent until the runner starts
}

export interface LogLine {
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
  agentId: string | null;
}

export interface ScoreEntry {
  team: string;
  model: string;
  value: number;
  awake: number;
  tokens: number;
  avgLatencyS: number | null;
  status: string; // running | finished | frozen
  color?: string;
}

export interface BaseOnMap {
  team: string;
  origin: { x: number; z: number }; // world units; the window's own base is at its origin
  ws: string | null; // the team's adapter world feed, for rendering its base
  model?: string;
}

// A battlefield (design/maps.json battlefields, tools/make_battlefields.mjs): the terrain every
// window shows during the match, scenery in the wild between the bases, and the conditions.
// Coordinates are in match-world units, base A's corner at 0,0.
export interface BattlefieldItem {
  kind: string; // structures: wreck wreckLarge relay ruins hangar rocket turret generator monorail pipeline; obstacles: ridge chasm crater lake mesa crystals meteors
  x: number;
  z: number;
  x2?: number; // lines (ridge, chasm, monorail, pipeline) run from x,z to x2,z2
  z2?: number;
  r?: number; // radius (crater, lake, mesa, crystals, meteors)
  w?: number; // width of a line
  h?: number; // height (mesa)
  rot?: number; // degrees
  size?: number; // footprint of a structure
  liquid?: string; // lake: water | ice | lava | methane
}

export interface Battlefield {
  id: string;
  name: string;
  terrain: string;
  brief: string;
  conditions: { solar: number; water: number; salvage: number; storms: number };
  structures: BattlefieldItem[];
  obstacles: BattlefieldItem[];
}

export interface ArenaInfo {
  id: string;
  map: string; // design/maps.json preset or battlefield id
  battlefield?: Battlefield | null;
  bases: BaseOnMap[];
  status: "lobby" | "running" | "finished";
  mode: string;
  objective: string;
  objectiveText: string;
  sols: number;
  sol: number;
  team: string;
  scoreboard: ScoreEntry[];
  result: { winner: string | null; reason: string } | null;
}

export interface WorldSnapshot {
  contract: number;
  arena?: ArenaInfo | null;
  settings?: GameSettings | null; // the Mission Control settings card (settings-card.ts)
  source: string; // "fake" | "hermes"
  mission: Mission | null;
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
  resources: Resources;
  log: LogLine[];
  links: { missionControl: string | null };
  layout: BaseLayout;
  history: MissionRecord[]; // finished missions, newest first
}

// A recorded mission: every world event between mission start and a few seconds after it
// ended, with the time it happened. Used by the game's mission replay.
export type RecordedEvent = Exclude<
  ServerEvent,
  { type: "snapshot" } | { type: "replay" } | { type: "error" } | { type: "layout.update" } | { type: "agent.removed" }
> & { ts: number };

export interface Replay {
  mission: Mission;
  agents: Agent[]; // agent states when the mission started
  events: RecordedEvent[];
}

// ---- server -> client ----
export type ServerEvent =
  | { type: "snapshot"; world: WorldSnapshot }
  | { type: "agent.state"; agent: Agent }
  | { type: "task.upsert"; task: Task }
  | { type: "mission.upsert"; mission: Mission }
  | { type: "approval.upsert"; approval: Approval }
  | { type: "resource.update"; resources: Resources }
  | { type: "log"; line: LogLine }
  | { type: "replay"; replay: Replay | null }
  | { type: "layout.update"; layout: BaseLayout }
  | { type: "agent.removed"; agentId: string }
  | { type: "arena.update"; arena: ArenaInfo | null }
  | { type: "settings.update"; settings: GameSettings | null }
  | { type: "error"; message: string };

export type ServerMessage = ServerEvent & { seq: number };

// ---- client -> server ----
export type ClientCommand =
  | { type: "hello"; client: string }
  | { type: "mission.create"; title: string }
  | { type: "approval.resolve"; id: string; approved: boolean }
  | { type: "mission.cancel" }
  | { type: "replay.request"; missionId?: string }
  // Build mode (validated in layout.ts)
  | { type: "layout.building.upsert"; building: Record<string, unknown> }
  | { type: "layout.building.remove"; id: string }
  | { type: "layout.spot.move"; id: string; x: number; z: number }
  | { type: "layout.agent.upsert"; agent: Record<string, unknown> }
  | { type: "layout.agent.remove"; id: string }
  | { type: "layout.terrain"; terrain: string }
  | { type: "layout.organise" }
  | { type: "layout.reset" }
  // Colony economy (validated in economy.ts)
  | { type: "colony.set_speed"; speed: number }
  | { type: "colony.build"; building: string; x?: number; z?: number }
  | { type: "colony.cancel_build" }
  | { type: "colony.toggle"; id: string; enabled: boolean }
  | { type: "colony.wake"; count: number }
  | { type: "colony.repair"; target: string }
  | { type: "colony.research"; tier: string }
  | { type: "autonomy.set"; target: string; level: number }
  | { type: "colony.path"; path: string }
  | { type: "colony.unordered"; recall: boolean }
  | { type: "colony.shutdown_mother" };
