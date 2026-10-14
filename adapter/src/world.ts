import { EventEmitter } from "node:events";
import { type BaseLayout, cloneLayout, DEFAULT_LAYOUT, homeOf } from "./layout.ts";
import {
  CONTRACT_VERSION,
  type Agent,
  type AgentState,
  type Approval,
  type BuildingId,
  type LocationId,
  type LogLine,
  type Mission,
  type MissionRecord,
  type RecordedEvent,
  type Replay,
  type Resources,
  type ServerEvent,
  type ServerMessage,
  type Task,
  type WorldSnapshot,
} from "./contract.ts";

const LOG_LIMIT = 200;
const REPLAY_KEEP = 5; // missions kept for replay
const HISTORY_KEEP = 12; // finished missions listed in the game
const REPLAY_TAIL_MS = 6000; // keep recording this long after a mission ends (agents walk home)
const RECORDED = new Set(["agent.state", "task.upsert", "mission.upsert", "approval.upsert", "log", "resource.update"]);

// Where an agent stands for a given state. Idle and finished agents wait at their home
// building; `building` only matters while working (default: the home building).
export function locationFor(state: AgentState, home: BuildingId, building?: BuildingId | null, current?: LocationId): LocationId {
  switch (state) {
    case "idle":
    case "complete":
      return home;
    case "thinking":
      return current ?? home;
    case "working":
      return building ?? home;
    case "waiting":
      return "rally_point";
    case "approval":
      return "human_approval";
    case "error":
      return "repair_bay";
  }
}

export interface AgentUpdate {
  state: AgentState;
  building?: BuildingId | null;
  taskId?: string | null;
  taskTitle?: string | null;
  detail?: string | null;
  progress?: number | null;
}

// Single source of truth for what the game shows. Sources write into it; the server
// and sinks subscribe to "message".
export class World extends EventEmitter {
  private seq = 0;
  private agents = new Map<string, Agent>();
  private tasks = new Map<string, Task>();
  private approvals = new Map<string, Approval>();
  private mission: Mission | null = null;
  private resources: Resources = { tokensUsed: 0, tokenBudget: null, costUsd: 0, costBudgetUsd: null };
  private log: LogLine[] = [];
  private recordings = new Map<string, Replay>();
  history: MissionRecord[] = [];
  source: string;
  missionControlUrl: string | null = null;
  readonly now: () => number;

  layout: BaseLayout;

  constructor(source: string, now: () => number = Date.now, layout: BaseLayout = cloneLayout(DEFAULT_LAYOUT)) {
    super();
    this.source = source;
    this.now = now;
    this.layout = layout;
    for (const a of layout.agents) this.agents.set(a.id, this.newAgent(a.id, a.name, a.builtin ? a.id : "custom"));
  }

  private newAgent(id: string, name: string, role: string): Agent {
    return { id, name, role, state: "idle", location: homeOf(this.layout, id), taskId: null, taskTitle: null, detail: null, progress: null, updatedAt: this.now() };
  }

  // Adopt an edited layout: add/remove/rename agents, send idle anyone whose spot vanished.
  applyLayout(layout: BaseLayout): void {
    this.layout = layout;
    const ids = new Set(layout.agents.map((a) => a.id));
    for (const id of [...this.agents.keys()]) {
      if (!ids.has(id)) {
        this.agents.delete(id);
        this.emitEvent({ type: "agent.removed", agentId: id });
      }
    }
    this.emitEvent({ type: "layout.update", layout });
    const places = new Set([...layout.buildings.map((b) => b.id), ...layout.spots.map((s) => s.id)]);
    for (const def of layout.agents) {
      const cur = this.agents.get(def.id);
      if (!cur) {
        this.agents.set(def.id, this.newAgent(def.id, def.name, "custom"));
        this.emitEvent({ type: "agent.state", agent: this.agents.get(def.id)! });
      } else if (cur.state === "idle" && cur.location !== homeOf(layout, def.id)) {
        // Home changed (or vanished): walk to the new one.
        cur.name = def.name;
        this.setAgent(def.id, { state: "idle" });
      } else if (cur.name !== def.name || !places.has(cur.location)) {
        cur.name = def.name;
        if (!places.has(cur.location)) this.setAgent(def.id, { state: "idle" });
        else this.emitEvent({ type: "agent.state", agent: cur });
      }
    }
  }

  agentIds(): string[] {
    return [...this.agents.keys()];
  }

  snapshot(): WorldSnapshot {
    return {
      contract: CONTRACT_VERSION,
      source: this.source,
      mission: this.mission,
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      approvals: [...this.approvals.values()],
      resources: this.resources,
      log: this.log,
      links: { missionControl: this.missionControlUrl },
      layout: this.layout,
      history: this.history,
    };
  }

  get currentSeq(): number {
    return this.seq;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getMission(): Mission | null {
    return this.mission;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  private emitEvent(event: ServerEvent): void {
    const msg = { ...event, seq: ++this.seq } as ServerMessage;
    this.record(event);
    this.emit("message", msg);
  }

  private record(event: ServerEvent) {
    const m = this.mission;
    if (!m || !RECORDED.has(event.type)) return;
    if (m.endedAt !== null && this.now() - m.endedAt > REPLAY_TAIL_MS) return;
    const rec = this.recordings.get(m.id);
    if (!rec) return;
    rec.events.push({ ...structuredClone(event), ts: this.now() } as RecordedEvent);
    if (event.type === "mission.upsert") rec.mission = structuredClone(event.mission);
  }

  // The recorded event stream of a mission (the latest one by default).
  replay(missionId?: string): Replay | null {
    if (missionId) return this.recordings.get(missionId) ?? null;
    let last: Replay | null = null;
    for (const r of this.recordings.values()) last = r;
    return last;
  }

  setAgent(id: string, u: AgentUpdate): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    const next: Agent = {
      ...a,
      state: u.state,
      location: locationFor(u.state, homeOf(this.layout, id), u.building, a.location),
      taskId: u.taskId !== undefined ? u.taskId : a.taskId,
      taskTitle: u.taskTitle !== undefined ? u.taskTitle : a.taskTitle,
      detail: u.detail !== undefined ? u.detail : a.detail,
      progress: u.progress !== undefined ? u.progress : u.state === "working" ? a.progress : null,
      updatedAt: this.now(),
    };
    if (u.state === "idle") {
      next.taskId = null;
      next.taskTitle = null;
      next.detail = null;
      next.progress = null;
    }
    this.agents.set(id, next);
    this.emitEvent({ type: "agent.state", agent: next });
    return next;
  }

  upsertTask(t: Partial<Task> & { id: string }): Task {
    const prev = this.tasks.get(t.id);
    const ts = this.now();
    const next: Task = {
      missionId: this.mission?.id ?? "",
      title: "",
      agentId: null,
      status: "queued",
      result: null,
      createdAt: ts,
      ...prev,
      ...t,
      updatedAt: ts,
    };
    this.tasks.set(t.id, next);
    this.emitEvent({ type: "task.upsert", task: next });
    return next;
  }

  startMission(id: string, title: string): Mission {
    this.tasks.clear();
    this.approvals.clear();
    this.mission = { id, title, status: "planning", result: null, startedAt: this.now(), endedAt: null };
    this.recordings.set(id, { mission: structuredClone(this.mission), agents: structuredClone([...this.agents.values()]), events: [] });
    while (this.recordings.size > REPLAY_KEEP) this.recordings.delete(this.recordings.keys().next().value!);
    this.emitEvent({ type: "mission.upsert", mission: this.mission });
    this.setResources({ tokensUsed: 0, costUsd: 0 });
    return this.mission;
  }

  updateMission(patch: Partial<Mission>): Mission | null {
    if (!this.mission) return null;
    const done = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled";
    this.mission = { ...this.mission, ...patch, endedAt: done ? this.now() : this.mission.endedAt };
    // A mission that stops early leaves nothing pending: open approvals are rejected and
    // unfinished tasks closed, so neither the game nor Mission Control waits on them.
    if (patch.status === "failed" || patch.status === "cancelled") {
      const id = this.mission.id;
      for (const a of this.approvals.values()) if (a.missionId === id && a.status === "pending") this.upsertApproval({ id: a.id, status: "rejected" });
      for (const t of this.tasks.values()) {
        if (t.missionId === id && (t.status === "queued" || t.status === "running" || t.status === "awaiting_approval")) {
          this.upsertTask({ id: t.id, status: patch.status === "cancelled" ? "cancelled" : "failed" });
        }
      }
    }
    this.emitEvent({ type: "mission.upsert", mission: this.mission });
    if (done) this.remember(this.mission);
    return this.mission;
  }

  // Adds (or refreshes) a finished mission in the history; "history" tells main.ts to save it.
  private remember(m: Mission) {
    const tasks = [...this.tasks.values()].filter((t) => t.missionId === m.id);
    const rec: MissionRecord = { ...structuredClone(m), tasksDone: tasks.filter((t) => t.status === "done").length, tasksTotal: tasks.length };
    this.history = [rec, ...this.history.filter((h) => h.id !== m.id)].slice(0, HISTORY_KEEP);
    this.emit("history", this.history);
  }

  upsertApproval(a: Partial<Approval> & { id: string }): Approval {
    const prev = this.approvals.get(a.id);
    const next: Approval = {
      missionId: this.mission?.id ?? null,
      agentId: null,
      tool: "",
      summary: "",
      status: "pending",
      createdAt: this.now(),
      ...prev,
      ...a,
    };
    this.approvals.set(a.id, next);
    this.emitEvent({ type: "approval.upsert", approval: next });
    return next;
  }

  setResources(patch: Partial<Resources>): void {
    this.resources = { ...this.resources, ...patch };
    this.emitEvent({ type: "resource.update", resources: this.resources });
  }

  addTokens(tokens: number, costUsd = 0): void {
    this.setResources({ tokensUsed: this.resources.tokensUsed + tokens, costUsd: this.resources.costUsd + costUsd });
  }

  logLine(text: string, level: LogLine["level"] = "info", agentId: string | null = null): void {
    const line: LogLine = { ts: this.now(), level, text, agentId };
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.emitEvent({ type: "log", line });
  }

  resetAgents(): void {
    for (const id of this.agents.keys()) this.setAgent(id, { state: "idle" });
  }
}
