import type { Agent, AgentState, Mission, ServerMessage, Task, TaskStatus } from "../contract.ts";
import type { World } from "../world.ts";

// Mirrors the world into Mission Control (builderz-labs/mission-control) over its REST API:
// agents and their status, one MC task per mission plus one per agent step, the Human
// Approval checkpoint as a task in "review", token usage and activity events. It also
// listens to MC's SSE stream so an approval given in MC (quality review) resolves the
// checkpoint in the game.
//
// MC quirks handled here (see docs/phase0-findings.md):
//  - moving a task to "done" needs an Aegis quality review, so done = POST /api/quality-review
//  - unknown @mentions in descriptions/comments are rejected, so "@" is escaped
//  - our own writes come back on the SSE stream, so expected statuses are tracked

export interface MissionControlOptions {
  url: string; // http://127.0.0.1:3001
  apiKey: string;
  model?: string; // reported with token usage
  onApproval?: (approvalId: string, approved: boolean) => void;
}

const MC_ROLE: Record<string, string> = {
  commander: "agent",
  researcher: "researcher",
  scout: "researcher",
  analyst: "assistant",
  coder: "coder",
  writer: "assistant",
  reviewer: "reviewer",
};

const MC_AGENT_STATUS: Record<AgentState, string> = {
  idle: "idle",
  complete: "idle",
  thinking: "busy",
  working: "busy",
  waiting: "busy",
  approval: "busy",
  error: "error",
};

const STATUS_LABEL: Record<AgentState, string> = {
  idle: "Idle at the Command Centre",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting",
  approval: "Waiting for human approval",
  error: "Error",
  complete: "Finished",
};

export const COMMANDER = "commander";

function mcName(agentId: string) {
  return `rts-${agentId}`;
}

function safe(text: string, max = 4900): string {
  // MC treats "@name" as a mention and rejects unknown names.
  const s = text.replace(/@/g, "＠");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export class MissionControlSink {
  private opts: Required<Omit<MissionControlOptions, "onApproval">> & Pick<MissionControlOptions, "onApproval">;
  private world!: World;
  private queue: Promise<void> = Promise.resolve();
  private mcTaskIds = new Map<string, number>(); // world task id / "mission:<id>" -> MC task id
  private finished = new Set<string>(); // missions whose end was reported
  private expected = new Map<number, string>(); // MC task id -> status we last set
  private approvalTask = new Map<number, string>(); // MC task id -> approval id
  private lastAgent = new Map<string, string>();
  private warned = false;
  private sseAbort: AbortController | null = null;
  private stopped = false;

  constructor(opts: MissionControlOptions) {
    this.opts = { model: "local", ...opts };
  }

  async start(world: World): Promise<void> {
    this.world = world;
    world.missionControlUrl = this.opts.url;
    world.on("message", (m: ServerMessage) => this.enqueue(() => this.onMessage(m)));
    this.enqueue(() => this.registerAgents());
    void this.listen();
  }

  stop(): void {
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    this.lobbyTimer = null;
    this.stopped = true;
    this.sseAbort?.abort();
  }

  // Resolves when all queued writes have been attempted (used by tests).
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(job: () => Promise<void>) {
    this.queue = this.queue.then(job).catch((e) => this.warn(e));
  }

  private warn(e: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.world.logLine(`Mission Control sync problem: ${e instanceof Error ? e.message : e}`, "warn");
  }

  // ---- the Arena lobby (docs/arena.md §3): a task with metadata.arena starts a match when
  // it is moved to in_progress; the result is written back when the match ends. ----
  private arena: import("../arena.ts").Arena | null = null;
  private lobbyTimer: NodeJS.Timeout | null = null;
  private lobbyTaskId: number | null = null;

  attachArena(arena: import("../arena.ts").Arena): void {
    this.arena = arena;
    arena.on("finished", (r: import("../arena.ts").MatchResult) => void this.reportMatch(r));
    const poll = () => void this.pollLobby().finally(() => {
      if (!this.stopped) this.lobbyTimer = setTimeout(poll, 10_000);
    });
    this.lobbyTimer = setTimeout(poll, 3_000);
  }

  private async pollLobby(): Promise<void> {
    if (!this.arena || this.stopped) return;
    let tasks: any[] = [];
    try {
      const res = await this.api("GET", "/api/tasks?status=in_progress&limit=100");
      tasks = Array.isArray(res) ? res : res?.tasks ?? [];
    } catch {
      return;
    }
    const match = this.arena.match;
    const lobby = tasks.filter((t) => t?.metadata && typeof t.metadata === "object" && t.metadata.arena && typeof t.metadata.arena === "object");
    if (match?.status === "running" && this.lobbyTaskId !== null && !lobby.some((t) => t.id === this.lobbyTaskId)) {
      // The task left in_progress (done or cancelled in Mission Control): the match stops.
      this.arena.stop("stopped from Mission Control");
      return;
    }
    if (match?.status === "running") return;
    const next = lobby.find((t) => t.id !== this.lobbyTaskId);
    if (!next) return;
    const a = next.metadata.arena as Record<string, unknown>;
    try {
      this.lobbyTaskId = next.id;
      this.arena.start({ ...a, source: `mc:${next.id}`, model: typeof a.model === "string" ? a.model : this.opts.model } as Partial<import("../arena.ts").MatchConfig>);
      await this.comment(next.id, `Match started by Outpost Zero: ${JSON.stringify(this.arena.match?.config)}`);
    } catch (e) {
      this.world.logLine(`Could not start the match from Mission Control task ${next.id}: ${e}`, "warn");
    }
  }

  private async reportMatch(r: import("../arena.ts").MatchResult): Promise<void> {
    const id = this.lobbyTaskId;
    if (id === null) return;
    const p = r.placings[0];
    const text = [`Match over: ${r.reason}.`, `Winner: ${r.winner ?? "none"}.`, ...r.placings.map((x) => `${x.team} (${x.model}): value ${x.value}, ${x.awake} awake, ${Math.round(x.tokens / 1000)} kTok, ${x.actions} actions (${x.rejected} rejected), latency ${x.avgLatencyS ?? "n/a"} s`)].join("\n");
    try {
      await this.comment(id, text);
      await this.markDone(id, `Match: ${r.reason}. ${p ? `Value ${p.value}, ${p.awake} awake.` : ""}`);
    } catch (e) {
      this.world.logLine(`Could not report the match to Mission Control: ${e}`, "warn");
    }
    this.lobbyTaskId = null;
  }

  private async api(method: string, path: string, body?: unknown, attempt = 0): Promise<any> {
    const res = await fetch(this.opts.url + path, {
      method,
      headers: { "x-api-key": this.opts.apiKey, "content-type": "application/json", "x-agent-name": "outpost-zero" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // A production Mission Control rate-limits writes (60/min); wait and retry instead of
    // dropping the update. Writes are queued, so this only delays the mirror.
    if (res.status === 429 && attempt < 4) {
      const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5 * (attempt + 1));
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.api(method, path, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
    this.warned = false;
    return text ? JSON.parse(text) : {};
  }

  private async registerAgents() {
    const existing = new Set<string>(((await this.api("GET", "/api/agents?limit=200")).agents ?? []).map((a: any) => a.name));
    const wanted = this.world.layout.agents.map((a) => ({ id: a.id, role: MC_ROLE[a.id] ?? "agent" }));
    for (const a of wanted) {
      if (existing.has(mcName(a.id))) continue;
      await this.api("POST", "/api/agents/register", {
        name: mcName(a.id),
        role: a.role,
        framework: "outpost-zero/hermes-synapse",
        capabilities: [a.id],
      });
    }
  }

  private async onMessage(m: ServerMessage) {
    switch (m.type) {
      case "mission.upsert":
        return this.onMission(m.mission);
      case "task.upsert":
        return this.onTask(m.task);
      case "agent.state":
        return this.onAgent(m.agent);
      case "layout.update":
        return this.registerAgents(); // new characters from Build mode
      case "approval.upsert":
        if (m.approval.status === "pending") {
          await this.event("approval:requested", m.approval.agentId ?? "reviewer");
        }
        return;
      default:
        return;
    }
  }

  private async onMission(mission: Mission) {
    const key = `mission:${mission.id}`;
    let id = this.mcTaskIds.get(key);
    if (id === undefined) {
      const res = await this.api("POST", "/api/tasks", {
        title: safe(`Mission: ${mission.title}`, 480),
        description: safe(`Outpost Zero mission, orchestrated by Hermes Synapse.\n\nObjective: ${mission.title}`),
        status: "in_progress",
        priority: "high",
        assigned_to: mcName(COMMANDER),
        tags: ["outpost-zero", "mission"],
        metadata: { source: "outpost-zero", missionId: mission.id },
      });
      id = res.task.id as number;
      this.mcTaskIds.set(key, id);
      this.expected.set(id, "in_progress");
      if (this.world.getMission()?.id === mission.id) this.world.updateMission({ link: `${this.opts.url}/tasks?taskId=${id}` });
      await this.event("mission:start", COMMANDER, mission.id);
      // fall through: the mission may already be finished (e.g. Hermes unreachable)
    }
    // Each mission's end is reported once (the link update above re-emits the mission).
    if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
      if (this.finished.has(mission.id)) return;
      this.finished.add(mission.id);
    }
    switch (mission.status) {
      case "completed":
        await this.markDone(id, "Mission approved and completed in Outpost Zero.");
        if (mission.result) await this.comment(id, `Final report\n\n${mission.result}`);
        await this.reportTokens(mission);
        await this.event("mission:complete", COMMANDER, mission.id);
        return;
      case "failed":
      case "cancelled":
        await this.setStatus(id, "failed", {
          outcome: mission.status === "cancelled" ? "abandoned" : "failed",
          error_message: safe(mission.result ?? mission.status, 1000),
        });
        await this.reportTokens(mission);
        await this.event(`mission:${mission.status}`, COMMANDER, mission.id);
        return;
      default:
        return;
    }
  }

  private async onTask(task: Task) {
    let id = this.mcTaskIds.get(task.id);
    const missionTitle = this.world.getMission()?.title ?? "";
    if (id === undefined) {
      const res = await this.api("POST", "/api/tasks", {
        title: safe(task.title || "Agent step", 480),
        description: safe(`Part of mission: ${missionTitle}`),
        status: "assigned",
        priority: "medium",
        assigned_to: task.agentId ? mcName(task.agentId) : undefined,
        tags: ["outpost-zero"],
        metadata: { source: "outpost-zero", missionId: task.missionId, taskId: task.id },
      });
      id = res.task.id as number;
      this.mcTaskIds.set(task.id, id);
      this.expected.set(id, "assigned");
    } else if (task.title) {
      await this.api("PUT", `/api/tasks/${id}`, { title: safe(task.title, 480) });
    }
    await this.applyTaskStatus(id, task.status, task.result);
    if (task.status === "awaiting_approval") {
      const pending = this.world.snapshot().approvals.find((a) => a.status === "pending");
      if (pending) {
        this.approvalTask.set(id, pending.id);
        await this.comment(
          id,
          "Waiting for human approval in Outpost Zero. Approve this task here (quality review → approve) or in the game at the Human Approval building.",
        );
      }
    }
  }

  private async applyTaskStatus(id: number, status: TaskStatus, result: string | null) {
    switch (status) {
      case "queued":
        return;
      case "running":
        return this.setStatus(id, "in_progress");
      case "awaiting_approval":
        return this.setStatus(id, "review");
      case "done":
        return this.markDone(id, safe(result ?? "Completed in Outpost Zero.", 900));
      case "failed":
      case "cancelled":
        return this.setStatus(id, "failed", { error_message: safe(result ?? status, 1000) });
    }
  }

  private async setStatus(id: number, status: string, extra: Record<string, unknown> = {}) {
    if (this.expected.get(id) === status && Object.keys(extra).length === 0) return;
    this.expected.set(id, status);
    await this.api("PUT", `/api/tasks/${id}`, { status, ...extra });
  }

  private async markDone(id: number, notes: string) {
    if (this.expected.get(id) === "done") return;
    this.expected.set(id, "done");
    // MC only lets a task reach "done" through an approved Aegis quality review.
    await this.api("POST", "/api/quality-review", { taskId: id, reviewer: "aegis", status: "approved", notes: notes || "Done" });
  }

  private async comment(id: number, content: string) {
    await this.api("POST", `/api/tasks/${id}/comments`, { content: safe(content) });
  }

  private async onAgent(agent: Agent) {
    const status = MC_AGENT_STATUS[agent.state];
    const activity = [STATUS_LABEL[agent.state], agent.taskTitle, agent.detail].filter(Boolean).join(" · ").slice(0, 240);
    const key = `${status}|${activity}`;
    if (this.lastAgent.get(agent.id) === key) return;
    this.lastAgent.set(agent.id, key);
    await this.api("PUT", "/api/agents", { name: mcName(agent.id), status, last_activity: activity });
  }

  private async reportTokens(mission: Mission) {
    const r = this.world.snapshot().resources;
    if (r.tokensUsed <= 0) return;
    await this.api("POST", "/api/tokens", {
      model: this.opts.model,
      sessionId: `${mcName(COMMANDER)}:${mission.id}`,
      inputTokens: r.tokensUsed, // Hermes only reports an estimated total
      outputTokens: 0,
      operation: "mission",
      duration: mission.endedAt ? mission.endedAt - mission.startedAt : undefined,
      taskId: this.mcTaskIds.get(`mission:${mission.id}`),
    });
  }

  private async event(event: string, agentId: string, sessionId?: string) {
    await this.api("POST", "/api/hermes/events", {
      event,
      session_id: sessionId ?? this.world.getMission()?.id ?? "outpost-zero",
      source: "outpost-zero",
      agent_name: mcName(agentId),
      timestamp: new Date().toISOString(),
    });
  }

  // ---- inbound: approvals given in Mission Control ----

  private async listen() {
    while (!this.stopped) {
      this.sseAbort = new AbortController();
      try {
        const res = await fetch(this.opts.url + "/api/events", {
          headers: { "x-api-key": this.opts.apiKey, accept: "text/event-stream" },
          signal: this.sseAbort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line.startsWith("data:")) this.onEvent(line.slice(5).trim());
          }
        }
      } catch {
        /* reconnect below */
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  onEvent(raw: string) {
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev?.type !== "task.status_changed" && ev?.type !== "task.updated") return;
    const id = Number(ev.data?.id ?? ev.data?.task_id);
    const status = ev.data?.status;
    const approvalId = this.approvalTask.get(id);
    if (!approvalId || !status || this.expected.get(id) === status) return;
    if (status === "done") {
      this.approvalTask.delete(id);
      this.expected.set(id, "done");
      this.world.logLine("Approved in Mission Control.", "info", "reviewer");
      this.opts.onApproval?.(approvalId, true);
    } else if (status === "failed" || status === "in_progress") {
      // A rejected quality review sends the task back to in_progress.
      this.approvalTask.delete(id);
      this.expected.set(id, status);
      this.world.logLine("Rejected in Mission Control.", "warn", "reviewer");
      this.opts.onApproval?.(approvalId, false);
    }
  }
}
