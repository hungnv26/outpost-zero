import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Source } from "../source.ts";
import type { World } from "../world.ts";
import type { AgentDef, BaseLayout } from "../layout.ts";
import { HermesTranslator } from "./hermes-translator.ts";

export interface HermesOptions {
  baseUrl: string; // http://127.0.0.1:8000
  token: string; // Hermes accepts the built-in dev token for local use
  orchestratorId?: string; // "jarvis"
  requireApproval?: boolean; // hold the final report at Human Approval
  costBudgetUsd?: number | null;
  missionTimeoutMs?: number;
}

// Seeded Hermes agents the game has no unit for. They are detached from the orchestrator
// so its planner only delegates to the four agents on the map. (sysops is the only seeded
// agent with an unrestricted shell tool; its skills are stripped as well. The built-in
// "analyst" is replaced by the plugin's faster "insights" agent.)
const BENCHED = ["football", "monitor", "planner", "scheduler", "sysops", "analyst"];
const FINAL_GRACE_MS = 1500;

interface Run {
  missionId: string;
  chatId: string;
  title: string;
  ws: WebSocket | null;
  translator: HermesTranslator;
  timer: NodeJS.Timeout | null;
  approvalId: string | null;
  draft: string | null;
  closed: boolean;
  finalScheduled: boolean;
}

export class HermesSource implements Source {
  readonly name = "hermes";
  private world!: World;
  private opts: Required<HermesOptions>;
  private run: Run | null = null;
  private rosterReady = false;

  constructor(opts: HermesOptions) {
    this.opts = {
      orchestratorId: "jarvis",
      requireApproval: true,
      costBudgetUsd: null,
      missionTimeoutMs: 20 * 60_000,
      ...opts,
    };
  }

  async start(world: World): Promise<void> {
    this.world = world;
    try {
      await this.ensureRoster();
    } catch (e) {
      world.logLine(`Hermes not reachable yet (${errText(e)}). Will retry when a mission starts.`, "warn");
    }
  }

  async createMission(title: string): Promise<void> {
    await this.cancelMission();
    const w = this.world;
    const missionId = randomUUID();
    const chatId = `rts_${missionId.slice(0, 8)}`;
    w.startMission(missionId, title);
    w.setResources({ tokenBudget: null, costBudgetUsd: this.opts.costBudgetUsd });
    w.logLine(`Mission received: "${title}"`);
    const run: Run = {
      missionId,
      chatId,
      title,
      ws: null,
      translator: new HermesTranslator(w, missionId, chatId),
      timer: null,
      approvalId: null,
      draft: null,
      closed: false,
      finalScheduled: false,
    };
    this.run = run;

    try {
      if (!this.rosterReady) await this.ensureRoster();
      // Route this chat to the orchestrator so Hermes always plans and delegates.
      await this.api("POST", `/api/history/${chatId}/agent`, { agent_id: this.opts.orchestratorId });
    } catch (e) {
      return this.fail(run, `Could not reach Hermes: ${errText(e)}`);
    }
    // Cancelled or replaced while we were waiting on Hermes: don't start it after all.
    if (this.run !== run || run.closed) return;

    const wsUrl = this.opts.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(wsUrl);
    run.ws = ws;
    run.timer = setTimeout(() => this.fail(run, "Mission timed out."), this.opts.missionTimeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type: "chat_message", content: missionPrompt(title, w.layout), chat_id: chatId })));
    ws.on("message", (data) => {
      if (this.run !== run || run.closed) return;
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      const result = run.translator.handle(frame);
      // Hermes can deliver the final answer before trace broadcasts it queued earlier
      // (e.g. the last step's failure), so keep reading briefly before settling.
      if (result && !run.finalScheduled) {
        run.finalScheduled = true;
        setTimeout(() => void this.onFinal(run, result.content, result.failed), FINAL_GRACE_MS);
      }
    });
    ws.on("close", (code) => {
      if (this.run === run && !run.closed && !run.translator.done) this.fail(run, `Lost connection to Hermes (code ${code}).`);
    });
    ws.on("error", (e) => {
      if (this.run === run && !run.closed && !run.translator.done) this.fail(run, `Hermes connection error: ${errText(e)}`);
    });
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const run = this.run;
    if (!run || run.approvalId !== id || run.closed) return;
    const w = this.world;
    w.upsertApproval({ id, status: approved ? "approved" : "rejected" });
    const taskId = `${run.missionId}:approval`;
    if (approved) {
      w.upsertTask({ id: taskId, status: "done", result: "Approved" });
      w.setAgent("reviewer", { state: "complete", detail: "Report approved" });
      w.setAgent("commander", { state: "complete", detail: "Mission closed" });
      w.updateMission({ status: "completed", result: run.draft });
      w.logLine("Report approved. Mission complete.");
    } else {
      w.upsertTask({ id: taskId, status: "failed", result: "Rejected" });
      w.setAgent("reviewer", { state: "complete", detail: "Report rejected" });
      w.updateMission({ status: "failed", result: `**Rejected at Human Approval.** Draft below.\n\n${run.draft ?? ""}` });
      w.logLine("Report rejected at Human Approval.", "warn");
    }
    this.finish(run, 3000);
  }

  async cancelMission(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const status = this.world.getMission()?.status;
    this.close(run);
    if (status === "planning" || status === "running") {
      this.world.updateMission({ status: "cancelled" });
      this.world.logLine("Mission cancelled. (Hermes may finish the current step in the background.)", "warn");
    }
    this.world.resetAgents();
  }

  async stop(): Promise<void> {
    await this.cancelMission();
  }

  // ---- internals ----

  private async onFinal(run: Run, content: string, failed: boolean) {
    const w = this.world;
    if (this.run !== run || run.closed) return;
    if (run.timer) clearTimeout(run.timer);
    run.ws?.close();
    run.translator.finalize();
    content = cleanReport(content);
    if (failed) return this.fail(run, firstParagraph(content) || "Hermes returned no result.", content);
    run.draft = content;
    if (!this.opts.requireApproval) {
      w.updateMission({ status: "completed", result: content });
      w.logLine("Mission complete. Report ready.");
      return this.finish(run, 3000);
    }
    const approvalId = randomUUID();
    run.approvalId = approvalId;
    const taskId = `${run.missionId}:approval`;
    w.upsertTask({ id: taskId, title: "Human approval of the final report", agentId: "reviewer", status: "awaiting_approval" });
    w.upsertApproval({
      id: approvalId,
      agentId: "reviewer",
      tool: "publish_report",
      summary: `The report for "${run.title}" is ready. Approve it as the mission result?`,
    });
    w.setAgent("reviewer", { state: "approval", taskId, taskTitle: "Human approval of the final report", detail: "Waiting for your sign-off" });
    w.setAgent("commander", { state: "waiting", detail: "Waiting for your approval" });
    w.logLine("The Reviewer is waiting for your approval at Human Approval.", "warn", "reviewer");
  }

  private fail(run: Run, reason: string, content?: string) {
    if (this.run !== run || run.closed) return;
    this.world.logLine(reason, "error");
    this.world.updateMission({ status: "failed", result: content ? `**${reason}**\n\n${content}` : reason });
    this.finish(run, 4000);
  }

  private finish(run: Run, resetAfterMs: number) {
    this.close(run);
    setTimeout(() => {
      if (this.run === null || this.run === run) this.world.resetAgents();
    }, resetAfterMs);
    if (this.run === run) this.run = null;
  }

  private close(run: Run) {
    run.closed = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    try {
      run.ws?.close();
    } catch {
      /* already closed */
    }
    if (this.run === run) this.run = null;
  }

  private async ensureRoster() {
    const agents = (await this.api("GET", "/api/subagents")) as any[];
    const orch = this.opts.orchestratorId;
    for (const a of agents) {
      const bench = BENCHED.includes(a.id) && (a.parent_id === orch || (a.id === "sysops" && a.skills !== "none"));
      if (!bench) continue;
      await this.api("POST", "/api/subagents", {
        id: a.id,
        name: a.name,
        system_prompt: a.system_prompt,
        model: a.model,
        agent_type: a.agent_type,
        parent_id: "benched",
        // "" would grant every safe tool; an unknown skill grants none.
        skills: a.id === "sysops" ? "none" : a.skills,
        x: a.x,
        y: a.y,
        temperature: a.temperature,
      });
    }
    await this.syncCustomAgents(this.world.layout, agents);
    const ids = new Set((await this.api("GET", "/api/subagents") as any[]).map((a) => a.id));
    const missing = this.world.layout.agents.filter((a) => a.hermesId !== orch && !ids.has(a.hermesId)).map((a) => a.hermesId);
    if (missing.length) this.world.logLine(`Hermes is missing agents: ${missing.join(", ")} (is the agentrts plugin mounted?)`, "warn");
    this.rosterReady = true;
  }

  // Characters created in Build mode are real Hermes sub-agents under the orchestrator.
  async layoutChanged(layout: BaseLayout): Promise<void> {
    try {
      await this.syncCustomAgents(layout, (await this.api("GET", "/api/subagents")) as any[]);
    } catch (e) {
      this.world.logLine(`Couldn't update Hermes agents: ${errText(e)}`, "warn");
    }
  }

  private async syncCustomAgents(layout: BaseLayout, existing: any[]) {
    const orch = this.opts.orchestratorId;
    const model = existing.find((a) => a.id === orch)?.model ?? existing[0]?.model ?? "agentrts-qwen3";
    const wanted = new Map(layout.agents.filter((a) => !a.builtin).map((a) => [a.hermesId, a]));
    for (const [hermesId, def] of wanted) {
      const cur = existing.find((a) => a.id === hermesId);
      const body = customAgentBody(def, model, orch);
      if (!cur || cur.system_prompt !== body.system_prompt || cur.name !== body.name || cur.skills !== body.skills) {
        await this.api("POST", "/api/subagents", body);
      }
    }
    // Remove Hermes agents for characters deleted in Build mode (only ours: rts_*).
    for (const a of existing) {
      if (typeof a.id === "string" && a.id.startsWith("rts_") && !wanted.has(a.id)) {
        await this.api("DELETE", `/api/subagents/${a.id}`);
      }
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  }
}

// Skills a Build-mode character can have (the "code" sandbox stays with the built-in Coder).
const SKILL_TO_HERMES: Record<string, string> = { web: "web_search", reasoning: "reasoning" };

function customAgentBody(def: AgentDef, model: string, orch: string) {
  return {
    id: def.hermesId,
    name: def.name,
    system_prompt: `You are ${def.name}. ${def.job}`,
    model,
    agent_type: "agent",
    parent_id: orch,
    skills: SKILL_TO_HERMES[def.skill] ?? "reasoning",
    x: 700,
    y: 200,
    temperature: 0.3,
  };
}

// The small local model plans better with the team spelled out.
export function missionPrompt(title: string, layout: BaseLayout): string {
  const team = layout.agents
    .filter((a) => a.hermesId !== "jarvis")
    .map((a) => `- ${a.name} (${a.hermesId}): ${a.job}`);
  return [
    `Mission: ${title}`,
    "",
    "Plan this as a short sequence (at most 5 steps) using only this team:",
    ...team,
    "",
    "Finish with a concise report in Markdown: a one-line summary, key findings as bullets, and sources.",
  ].join("\n");
}

// When Hermes skips synthesis it returns raw sub-agent output, which can include scraped
// binary (PDF streams). Drop lines that are mostly non-text and cap the length.
export function cleanReport(text: string, max = 12_000): string {
  const lines = text.split("\n").filter((line) => {
    if (/%PDF-|endobj|\/FlateDecode|stream\s+h/.test(line)) return false;
    const bad = (line.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) ?? []).length;
    return bad < 3;
  });
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > max ? out.slice(0, max) + "\n\n… (truncated)" : out;
}

function firstParagraph(s: string): string {
  return s.trim().split(/\n\s*\n/)[0]?.slice(0, 300) ?? "";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
