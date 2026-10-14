import { type BaseLayout, buildingForTool } from "../layout.ts";
import type { World } from "../world.ts";

// Translates Hermes Synapse WebSocket frames for one mission into World updates.
// Pure: no I/O, so it is unit-tested against captured frames (test/fixtures).
//
// Hermes signals used (see docs/phase0-findings.md):
//   trace_update  {session_id, trace:{agent, action, message, status, token_cost}}
//     Orchestrator/Start, Orchestrator/Planning, Router/Route "Step i/N: Delegating to agent 'Name' (id)",
//     <Agent>/Search|Execute|Plot|Error (step finished), Orchestrator/Finish|Abort|Error|Warning
//   activity_log  {log:{source, message}}  per-tool calls of tool-loop sub-agents (e.g. the Reviewer)
//   chat_message  {role:"assistant", chat_id, content, cost_usd}  final answer
//   logs_update   {logs:[{session_id, prompt_tokens_estimate, completion_tokens_estimate, cost_usd}]}

const COMMANDER = "commander";

// Hermes sub-agent id -> unit on the map, from the layout (custom characters included).
export function agentForHermesId(layout: BaseLayout, hermesId: string, name = ""): string {
  const exact = layout.agents.find((a) => a.hermesId === hermesId);
  if (exact) return exact.id;
  if (hermesId === "analyst" && layout.agents.some((a) => a.id === "analyst")) return "analyst"; // Hermes' built-in analyst
  const n = `${hermesId} ${name}`.toLowerCase();
  const byName = layout.agents.find((a) => n.includes(a.name.toLowerCase()));
  if (byName) return byName.id;
  const guess = /review|qa|check/.test(n) ? "reviewer" : /code|engineer|dev/.test(n) ? "coder" : /scout|news/.test(n) ? "scout" : /search|research/.test(n) ? "researcher" : /writ|draft|report/.test(n) ? "writer" : "analyst";
  return layout.agents.some((a) => a.id === guess) ? guess : layout.agents[0]?.id ?? COMMANDER;
}

const DELEGATE_RE = /Step (\d+)\/(\d+): Delegating to agent '([^']*)' \(([^)]+)\)/;
const STEP_DONE_ACTIONS = new Set(["Search", "Execute", "Plot", "Error", "Orchestrate"]);
const TOOL_CALL_RE = /Execution(?: \(subagent\))?: '([^']+)' with arguments (.*)$/s;
const RECEIVED_RE = /Received request for subagent '([^']+)': '(.*)/s;
const COST_RE = /Cost: \$([0-9.]+)/;

// Hermes' web_search output starts with a (Russian) header line; skip it in summaries.
const NOISE_LINE = /^(🌐|Search results:?$|Результаты)/;

function firstLine(s: unknown, max = 140): string {
  const line =
    String(s ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !NOISE_LINE.test(l)) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function toolDetail(tool: string, rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs);
    const v = args.query ?? args.q ?? args.command ?? args.code ?? Object.values(args)[0];
    return v ? `${tool}: ${firstLine(v, 100)}` : tool;
  } catch {
    return tool;
  }
}

interface Step {
  taskId: string;
  agentId: string;
  hermesId: string;
  name: string;
}

export interface TranslatorResult {
  kind: "final";
  content: string;
  failed: boolean;
}

export class HermesTranslator {
  private step: Step | null = null;
  private finalSeen = false;
  private tokens = 0;
  private cost = 0;

  private readonly world: World;
  readonly missionId: string;
  readonly chatId: string;

  constructor(world: World, missionId: string, chatId: string) {
    this.world = world;
    this.missionId = missionId;
    this.chatId = chatId;
  }

  get done(): boolean {
    return this.finalSeen;
  }

  // Returns a TranslatorResult when the mission's final answer arrives.
  handle(frame: any): TranslatorResult | null {
    switch (frame?.type) {
      case "trace_update":
        if (frame.session_id !== this.chatId) return null;
        this.onTrace(frame.trace ?? {});
        return null;
      case "activity_log":
        this.onActivity(frame.log ?? {});
        return null;
      case "logs_update":
        this.onLogs(frame.logs ?? []);
        return null;
      case "chat_message":
        if (frame.role !== "assistant" || String(frame.chat_id) !== this.chatId) return null;
        return this.onFinal(frame);
      default:
        return null;
    }
  }

  private onTrace(t: { agent?: string; action?: string; message?: string; status?: string; token_cost?: number }) {
    const w = this.world;
    const agent = t.agent ?? "";
    const action = t.action ?? "";
    const msg = String(t.message ?? "");
    if (typeof t.token_cost === "number" && t.token_cost > 0 && action === "Finish") this.setCost(t.token_cost);

    if (agent === "Orchestrator") {
      switch (action) {
        case "Start":
          w.logLine("The Commander is planning the mission.", "info", COMMANDER);
          w.setAgent(COMMANDER, { state: "thinking", detail: "Planning the mission" });
          return;
        case "Planning":
          if (t.status === "error") {
            w.logLine(`Planning problem: ${firstLine(msg)}`, "warn");
            return;
          }
          w.updateMission({ status: "running" });
          w.logLine(firstLine(msg) || "Plan ready.", "info", COMMANDER);
          w.setAgent(COMMANDER, { state: "working", building: "command_centre", detail: "Coordinating the team", progress: null });
          return;
        case "Abort":
        case "Error":
          w.logLine(`Commander: ${firstLine(msg)}`, "error");
          this.failStep(msg);
          return;
        case "Warning":
        case "Notice":
          w.logLine(`Commander: ${firstLine(msg)}`, "warn");
          return;
        default:
          return;
      }
    }

    if (agent === "Router" && action === "Route") {
      const m = DELEGATE_RE.exec(msg);
      if (m) return this.startStep(Number(m[1]), Number(m[2]), m[3], m[4]);
      if (/All plan steps completed/i.test(msg)) {
        w.logLine("All steps done. The Commander is writing the final report.", "info", COMMANDER);
        w.setAgent(COMMANDER, { state: "working", building: "command_centre", detail: "Writing the final report" });
      }
      return;
    }

    if (this.step && STEP_DONE_ACTIONS.has(action)) {
      if (t.status === "error" || action === "Error" || /failed/i.test(msg.slice(0, 60))) this.failStep(msg);
      else this.completeStep(msg);
    }
  }

  private startStep(i: number, n: number, name: string, hermesId: string) {
    const w = this.world;
    if (this.step) this.completeStep("");
    const agentId = agentForHermesId(this.world.layout, hermesId, name);
    const taskId = `${this.missionId}:step${i}`;
    this.step = { taskId, agentId, hermesId, name };
    const title = `Step ${i}/${n}: ${name}`;
    w.upsertTask({ id: taskId, title, agentId, status: "running" });
    w.setAgent(agentId, { state: "working", taskId, taskTitle: title, detail: `Delegated by the Commander`, progress: null });
    w.setAgent(COMMANDER, { state: "working", building: "command_centre", detail: `Coordinating step ${i} of ${n}` });
    w.logLine(`${name} takes step ${i} of ${n}.`, "info", agentId);
    w.addTokens(400); // brief + context sent to the sub-agent (estimate; corrected by logs_update)
  }

  private completeStep(message: string) {
    const s = this.step;
    if (!s) return;
    this.step = null;
    this.world.addTokens(Math.ceil(message.length / 4));
    const summary = firstLine(message.replace(/^Search results:\s*/i, "").replace(/^Sub-agent completed execution:\s*/i, ""));
    this.world.upsertTask({ id: s.taskId, status: "done", result: summary || null });
    this.world.setAgent(s.agentId, { state: "complete", detail: summary || "Step complete" });
    this.world.logLine(`${s.name} finished.`, "info", s.agentId);
  }

  private failStep(message: string) {
    const s = this.step;
    if (!s) return;
    this.step = null;
    const reason = firstLine(message.replace(/^Error:\s*/i, "").replace(/^Sub-agent execution failed:\s*/i, ""));
    this.world.upsertTask({ id: s.taskId, status: "failed", result: reason });
    this.world.setAgent(s.agentId, { state: "error", detail: reason });
    this.world.logLine(`${s.name} hit an error: ${reason}`, "error", s.agentId);
  }

  private onActivity(log: { source?: string; message?: string }) {
    const s = this.step;
    const source = String(log.source ?? "");
    const msg = String(log.message ?? "");
    if (!s || source.startsWith("Orch")) return;
    // Tool-loop sub-agents log under their display name.
    if (source !== s.name && source !== "Agent") return;
    const received = RECEIVED_RE.exec(msg);
    if (received) {
      const instruction = firstLine(received[2].replace(/'$/, ""), 120);
      this.world.upsertTask({ id: s.taskId, title: instruction });
      this.world.setAgent(s.agentId, { state: "working", taskTitle: instruction, detail: "Reading the brief" });
      return;
    }
    const tool = TOOL_CALL_RE.exec(msg);
    if (tool) {
      this.world.setAgent(s.agentId, { state: "working", building: buildingForTool(this.world.layout, tool[1], s.agentId), detail: toolDetail(tool[1], tool[2]) });
      this.world.addTokens(200);
      return;
    }
    const cost = COST_RE.exec(msg);
    if (cost) this.addCost(Number(cost[1]));
  }

  private onLogs(logs: any[]) {
    const entry = logs.find((l) => l?.session_id === this.chatId);
    if (!entry) return;
    const tokens = Number(entry.prompt_tokens_estimate ?? 0) + Number(entry.completion_tokens_estimate ?? 0);
    if (tokens > this.tokens) {
      this.tokens = tokens;
      // Hermes' own estimate covers the orchestrator turn; keep whichever is larger.
      this.world.setResources({ tokensUsed: Math.max(tokens, this.world.snapshot().resources.tokensUsed) });
    }
    if (typeof entry.cost_usd === "number") this.setCost(Math.max(entry.cost_usd, this.cost));
  }

  // Close out a step that never got its own finish trace.
  finalize(): void {
    if (this.step) this.completeStep("");
    if (this.world.getAgent(COMMANDER)?.state !== "idle") this.world.setAgent(COMMANDER, { state: "complete", detail: "Report delivered" });
  }

  private onFinal(frame: any): TranslatorResult {
    this.finalSeen = true;
    const content = String(frame.content ?? "");
    if (typeof frame.cost_usd === "number") this.setCost(Math.max(frame.cost_usd, this.cost));
    const failed = /^Apologies, Sir\./.test(content.trim()) || content.trim().length === 0;
    return { kind: "final", content, failed };
  }

  private setCost(usd: number) {
    this.cost = usd;
    this.world.setResources({ costUsd: usd });
  }

  private addCost(usd: number) {
    this.setCost(this.cost + usd);
  }
}
