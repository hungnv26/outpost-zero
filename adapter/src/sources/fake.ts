import { randomUUID } from "node:crypto";
import type { BuildingId } from "../contract.ts";
import { homeOf } from "../layout.ts";
import type { Source } from "../source.ts";
import type { World } from "../world.ts";

class Cancelled extends Error {}

export interface FakeOptions {
  speed?: number; // >1 runs faster (tests use a large value)
  autoApproveMs?: number | null; // approve automatically after this long; null waits for a human
  injectError?: boolean; // coder hits one recoverable error
  loop?: boolean; // start a new demo mission after each one ends
}

// Scripted "mission" that exercises every agent state through the real contract,
// so the game can be built and tuned before any LLM is involved.
export class FakeSource implements Source {
  readonly name = "fake";
  private world!: World;
  private run: { id: string; abort: AbortController } | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private opts: Required<FakeOptions>;
  private demoIndex = 0;

  constructor(opts: FakeOptions = {}) {
    this.opts = {
      speed: opts.speed ?? 1,
      autoApproveMs: opts.autoApproveMs === undefined ? 20_000 : opts.autoApproveMs,
      injectError: opts.injectError ?? true,
      loop: opts.loop ?? false,
    };
  }

  async start(world: World): Promise<void> {
    this.world = world;
    if (this.opts.loop) void this.createMission(DEMO_MISSIONS[0]);
  }

  async createMission(title: string): Promise<void> {
    await this.cancelMission();
    const id = randomUUID();
    const abort = new AbortController();
    this.run = { id, abort };
    this.script(id, title, abort.signal)
      .catch((e) => {
        if (!(e instanceof Cancelled)) {
          this.world.logLine(`Fake mission crashed: ${e}`, "error");
          this.world.updateMission({ status: "failed" });
        }
      })
      .finally(() => {
        if (this.run?.id !== id) return;
        this.run = null;
        if (this.opts.loop && !abort.signal.aborted) {
          setTimeout(() => {
            if (!this.run) void this.createMission(DEMO_MISSIONS[++this.demoIndex % DEMO_MISSIONS.length]);
          }, 4000 / this.opts.speed);
        }
      });
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    resolve(approved);
  }

  async cancelMission(): Promise<void> {
    if (!this.run) return;
    this.run.abort.abort();
    this.run = null;
    for (const r of this.pendingApprovals.values()) r(false);
    this.pendingApprovals.clear();
    if (this.world.getMission()?.status === "running" || this.world.getMission()?.status === "planning") {
      this.world.updateMission({ status: "cancelled" });
      this.world.logLine("Mission cancelled.", "warn");
    }
    this.world.resetAgents();
  }

  async stop(): Promise<void> {
    this.opts.loop = false;
    await this.cancelMission();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Cancelled());
      const t = setTimeout(resolve, ms / this.opts.speed);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(new Cancelled())), { once: true });
    });
  }

  // Progress ticks while an agent works inside a building.
  private async work(agentId: string, taskId: string, building: BuildingId, detail: string, ms: number, signal: AbortSignal) {
    const w = this.world;
    const title = w.getTask(taskId)?.title ?? detail;
    w.upsertTask({ id: taskId, status: "running", agentId });
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      w.setAgent(agentId, { state: "working", building, taskId, taskTitle: title, detail, progress: i / steps });
      w.addTokens(380 + Math.round(Math.random() * 400), 0.0009);
      if (i < steps) await this.sleep(ms / steps, signal);
    }
  }

  private awaitApproval(id: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(id, resolve);
      signal.addEventListener("abort", () => reject(new Cancelled()), { once: true });
      if (this.opts.autoApproveMs != null) {
        setTimeout(() => {
          if (this.pendingApprovals.has(id)) {
            this.world.logLine("No reviewer response: auto-approved (demo mode).", "warn");
            void this.resolveApproval(id, true);
          }
        }, this.opts.autoApproveMs / this.opts.speed);
      }
    });
  }

  private async script(missionId: string, title: string, signal: AbortSignal): Promise<void> {
    const w = this.world;
    const s = (ms: number) => this.sleep(ms, signal);
    const t = (n: string) => `${missionId}:${n}`;

    w.startMission(missionId, title);
    w.setResources({ tokenBudget: 50_000, costBudgetUsd: 0.5 });
    w.logLine(`Mission received: "${title}"`);
    w.setAgent("commander", { state: "thinking", detail: "Planning the mission" });
    await s(2500);

    const steps: [string, string, string][] = [
      ["research", `Deep research: ${title}`, "researcher"],
      ["scan", "Scan the latest news", "scout"],
      ["analyse", "Analyse findings", "analyst"],
      ["chart", "Build summary chart", "coder"],
      ["draft", "Draft the report", "writer"],
      ["review", "Review the final report", "reviewer"],
    ];
    for (const [id, taskTitle, agentId] of steps) w.upsertTask({ id: t(id), title: taskTitle, agentId });
    w.updateMission({ status: "running" });
    w.setAgent("commander", { state: "working", building: "command_centre", detail: "Coordinating the team", progress: null });
    w.logLine("Plan ready: research + scan → analyse → chart → draft → review.");

    w.setAgent("analyst", { state: "waiting", taskId: t("analyse"), taskTitle: "Analyse findings", detail: "Waiting for Researcher and Scout" });
    w.setAgent("coder", { state: "waiting", taskId: t("chart"), taskTitle: "Build summary chart", detail: "Waiting for Analyst" });

    // Researcher and Scout work in parallel at the Research Lab.
    w.logLine("Researcher and Scout heading to the Research Lab.", "info", "researcher");
    await Promise.all([
      this.work("researcher", t("research"), "research_lab", "web_search + scraping sources", 9000, signal),
      this.work("scout", t("scan"), "research_lab", "web_search: latest news", 5000, signal).then(() => {
        w.upsertTask({ id: t("scan"), status: "done", result: "6 recent headlines" });
        w.setAgent("scout", { state: "complete", detail: "6 recent headlines" });
      }),
    ]);
    w.upsertTask({ id: t("research"), status: "done", result: "14 sources collected" });
    w.setAgent("researcher", { state: "complete", detail: "14 sources collected" });
    w.logLine("Research done: 14 sources and 6 headlines.", "info", "researcher");

    await this.work("analyst", t("analyse"), "knowledge_library", "Extracting facts and trends", 7000, signal);
    w.upsertTask({ id: t("analyse"), status: "done", result: "Key trends extracted" });
    w.setAgent("analyst", { state: "complete", detail: "Key trends extracted" });
    w.setAgent("researcher", { state: "idle" });
    w.setAgent("scout", { state: "idle" });

    // Characters built in Build mode take a turn at their home building.
    for (const def of w.layout.agents.filter((a) => !a.builtin)) {
      const id = t(`custom_${def.id}`);
      w.upsertTask({ id, title: `${def.name}: ${def.job}`.slice(0, 120), agentId: def.id });
      await this.work(def.id, id, homeOf(w.layout, def.id), def.job.slice(0, 80), 3000, signal);
      w.upsertTask({ id, status: "done", result: "Done" });
      w.setAgent(def.id, { state: "complete", detail: "Done" });
    }

    await this.work("coder", t("chart"), "code_factory", "python_sandbox: matplotlib chart", 4000, signal);
    if (this.opts.injectError) {
      w.setAgent("coder", { state: "error", detail: "ModuleNotFoundError: seaborn — retrying without it" });
      w.logLine("Coder hit an error in the sandbox, retrying.", "error", "coder");
      await s(3500);
      await this.work("coder", t("chart"), "code_factory", "python_sandbox: retry with matplotlib only", 4000, signal);
    }
    w.upsertTask({ id: t("chart"), status: "done", result: "chart.png" });
    w.setAgent("coder", { state: "complete", detail: "chart.png ready" });
    w.setAgent("analyst", { state: "idle" });

    await this.work("writer", t("draft"), "knowledge_library", "Writing the report draft", 5000, signal);
    w.upsertTask({ id: t("draft"), status: "done", result: "Draft ready" });
    w.setAgent("writer", { state: "complete", detail: "Draft ready" });
    w.setAgent("coder", { state: "idle" });

    await this.work("reviewer", t("review"), "knowledge_library", "Checking claims against sources", 5000, signal);
    const approvalId = randomUUID();
    w.upsertTask({ id: t("review"), status: "awaiting_approval" });
    w.upsertApproval({ id: approvalId, agentId: "reviewer", tool: "publish_report", summary: `Publish the final report for "${title}"?` });
    w.setAgent("reviewer", { state: "approval", detail: "Needs your sign-off to publish" });
    w.setAgent("writer", { state: "idle" });
    w.setAgent("commander", { state: "waiting", detail: "Waiting for your approval" });
    w.logLine("Reviewer is waiting for your approval at Human Approval.", "warn", "reviewer");
    const approved = await this.awaitApproval(approvalId, signal);
    w.upsertApproval({ id: approvalId, status: approved ? "approved" : "rejected" });

    if (!approved) {
      w.upsertTask({ id: t("review"), status: "failed", result: "Rejected by human" });
      w.setAgent("reviewer", { state: "complete", detail: "Report rejected" });
      w.updateMission({ status: "failed", result: "The report was rejected at Human Approval." });
      w.logLine("Report rejected. Mission closed.", "warn");
    } else {
      w.upsertTask({ id: t("review"), status: "done", result: "Approved" });
      w.setAgent("reviewer", { state: "complete", detail: "Approved and published" });
      w.updateMission({ status: "completed", result: fakeReport(title) });
      w.logLine("Mission complete. Report ready.");
    }
    w.setAgent("commander", { state: "complete", detail: "Mission closed" });
    await s(3000);
    w.resetAgents();
  }
}

export const DEMO_MISSIONS = [
  "Research the Australian EV market",
  "Compare three CRM tools for a 10-person agency",
  "Summarise this week's AI agent framework releases",
];

function fakeReport(title: string): string {
  return [
    `# ${title}`,
    "",
    "_Simulated result (fake source)._",
    "",
    "- Commander planned the mission and coordinated the team.",
    "- Researcher gathered 14 sources; Scout found 6 recent headlines.",
    "- Analyst extracted the key trends; Coder produced a summary chart.",
    "- Writer drafted the report; Reviewer checked it and a human approved publication.",
  ].join("\n");
}
