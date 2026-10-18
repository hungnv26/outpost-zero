// The Arena referee (docs/arena.md): a match on top of the colony. Phase 4: one team
// against the clock. The referee validates every action, enforces the per-hour window and
// the token budget, scores the colony, and ends the match on its objective or its last sol.
import { EventEmitter } from "node:events";
import { Colony, ColonyError, type ColonyRunner, type ColonyView, conditionsFrom, DEPTS } from "./economy.ts";
import type { ArenaInfo, BaseOnMap, Battlefield, BattlefieldItem, ScoreEntry, ServerMessage } from "./contract.ts";
import { TERRAINS } from "./layout.ts";
import type { World } from "./world.ts";

export type Mode = "race" | "timed";
export type Objective = "awakening" | "foothold" | "ending" | "sprint" | "lifeline";

export interface MatchConfig {
  mode: Mode;
  objective: Objective;
  sols: number;
  tokenBudget: number; // tokens, not kTok
  seed: number;
  team: string; // team id, "A" in Phase 4
  model: string; // for the scoreboard
  actionsPerHour: number;
  source?: string; // where the match was set up (e.g. a Mission Control task id)
  battlefield?: Battlefield; // the director's pick from design/maps.json battlefields
}

const ITEM_KINDS = ["wreck", "wreckLarge", "relay", "ruins", "hangar", "rocket", "turret", "generator", "monorail", "pipeline", "ridge", "chasm", "crater", "lake", "mesa", "crystals", "meteors"];
const LIQUIDS = ["water", "ice", "lava", "methane"];

// A battlefield from the director, checked: known kinds and terrain, finite numbers, at most 80 items.
export function battlefieldFrom(b: unknown): Battlefield | undefined {
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  const str = (v: unknown, max = 80) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-2000, Math.min(2000, v)) : undefined);
  const items = (v: unknown): BattlefieldItem[] =>
    (Array.isArray(v) ? v : []).slice(0, 80).flatMap((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const x = num(i.x);
      const z = num(i.z);
      if (!ITEM_KINDS.includes(String(i.kind)) || x === undefined || z === undefined) return [];
      const out: BattlefieldItem = { kind: String(i.kind), x, z };
      for (const k of ["x2", "z2", "r", "w", "h", "rot", "size"] as const) {
        const n = num(i[k]);
        if (n !== undefined) out[k] = n;
      }
      if (LIQUIDS.includes(String(i.liquid))) out.liquid = String(i.liquid);
      return [out];
    });
  const terrain = str(o.terrain);
  if (!(TERRAINS as readonly string[]).includes(terrain)) return undefined;
  return { id: str(o.id, 40) || "battlefield", name: str(o.name) || "Battlefield", terrain, brief: str(o.brief, 200), conditions: conditionsFrom(o.conditions), structures: items(o.structures), obstacles: items(o.obstacles) };
}

export interface ActionRecord {
  id: string;
  hour: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  reason: string | null;
  latencyS: number | null;
  ts: number;
}

export interface MatchResult {
  winner: string | null;
  reason: string;
  placings: { team: string; model: string; value: number; awake: number; tokens: number; avgLatencyS: number | null; actions: number; rejected: number }[];
  sols: number;
  endedAt: number;
}

export interface MatchState {
  id: string;
  status: "lobby" | "running" | "finished";
  config: MatchConfig;
  startedAt: number;
  startHour: number;
  hour: number;
  actions: ActionRecord[];
  hourActions: number;
  tokensAtStart: number;
  frozen: boolean;
  warned: boolean;
  rounds: number;
  notes: { hour: number; text: string }[];
  result: MatchResult | null;
}

export const LIFELINE = ["waterExtractor", "hydroponics", "solarArray", "scrapYard", "medBay"];

export const OBJECTIVES: Record<Objective, { name: string; check: (c: Colony) => boolean; describe: string }> = {
  awakening: { name: "Awakening", check: (c) => c.state.awake >= 100, describe: "100 colonists awake" },
  foothold: { name: "Foothold", check: (c) => c.state.awake >= 60 && c.state.shortSols.food === 0 && c.state.shortSols.water === 0 && c.state.stocks.food > 300 && c.state.stocks.water > 300, describe: "60 awake and fed and watered with reserves" },
  // A race a short match can finish: past the first Habitat's 40 beds and the 30 medicine of
  // the landing (2 per colonist woken), with food and water for everyone. It takes a Med Bay, a
  // second Habitat, water and power, in a sensible order.
  sprint: { name: "Sprint", check: (c) => c.state.awake >= 44 && c.state.shortSols.food === 0 && c.state.shortSols.water === 0 && c.state.shortHours.food === 0 && c.state.shortHours.water === 0, describe: "first to 44 colonists awake, nobody hungry or thirsty" },
  // The shortest race: water, food, power, materials and medicine all produced at home. The
  // five cost 260 materials against the landing's 150, so the Scrap Yard's place in the order
  // decides it (about 5 sols played well).
  lifeline: { name: "Lifeline", check: (c) => LIFELINE.every((t) => c.state.buildings.some((b) => b.type === t && b.enabled)), describe: "first to run a Water Extractor, Hydroponics Bay, Solar Array, Scrap Yard and Med Bay" },
  ending: { name: "Ending", check: (c) => !!c.state.story.ending && c.state.story.ending !== "Extinction", describe: "reach Exodus, New Eden or Singularity" },
};

export const TOOLS = ["colony_state", "colony_build", "colony_cancel_build", "colony_toggle", "colony_wake", "colony_autonomy", "colony_research", "colony_repair", "colony_study", "colony_note", "colony_path", "colony_shutdown_mother"] as const;

// Colony value (docs/arena.md §6).
export function colonyValue(c: Colony): number {
  const s = c.state;
  const v = c.view();
  const powered = v.buildings.filter((b) => b.powered).length;
  const stocks = 0.2 * s.stocks.water + 0.3 * s.stocks.food + 0.5 * s.stocks.materials + 2 * s.stocks.parts + 1 * s.stocks.medicine;
  const deaths = s.dead - c.defs.start.colonistsDead;
  return Math.round(25 * s.awake + 10 * powered + 2 * s.stocks.data + 50 * s.stocks.artifacts + stocks + 5 * s.trust - 5 * Math.max(0, s.influence - 40) - 100 * deaths);
}

export class Arena extends EventEmitter {
  readonly runner: ColonyRunner;
  private world: World;
  match: MatchState | null = null;
  private seq = 0;
  private roundStartedAt: number | null = null;
  private govTokens = 0;
  // Other teams' scores, set by the match director (tools/match_director.mjs).
  private others: ScoreEntry[] = [];
  // The match map: every team's base origin (from the director; design/maps.json).
  private map = "solo";
  private bases: BaseOnMap[] = [];
  // The match's outcome across all teams, from the director: a race lost to another team ends
  // here as "stopped", and every window should still show who won.
  private outcome: { winner: string | null; reason: string } | null = null;

  constructor(runner: ColonyRunner, world: World) {
    super();
    this.runner = runner;
    this.world = world;
    world.on("message", (m: ServerMessage) => this.onWorld(m));
  }

  get colony(): Colony {
    return this.runner.colony;
  }

  // The scoreboard the game shows: this team first, then what the director reports.
  myScore(): ScoreEntry {
    const m = this.match;
    const c = this.runner.colony;
    const acts = m?.actions ?? [];
    const lat = acts.filter((a) => a.latencyS !== null).map((a) => a.latencyS as number);
    return {
      team: m?.config.team ?? "A",
      model: m?.config.model ?? "",
      value: colonyValue(c),
      awake: c.state.awake,
      tokens: this.tokensUsed(),
      avgLatencyS: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null,
      status: m ? (m.status === "running" && m.frozen ? "frozen" : m.status) : "lobby",
    };
  }

  setScoreboard(entries: ScoreEntry[], bases?: BaseOnMap[], map?: string, outcome?: { winner: string | null; reason: string }): void {
    const mine = this.match?.config.team ?? "A";
    this.others = entries.filter((e) => e.team !== mine);
    if (bases) this.bases = bases;
    if (map) this.map = map;
    if (outcome) this.outcome = outcome;
    this.publishInfo();
  }

  info(): ArenaInfo | null {
    const m = this.match;
    if (!m) return null;
    const v = this.runner.colony.view();
    return {
      id: m.id,
      map: this.map,
      battlefield: m.config.battlefield ?? null,
      bases: this.bases,
      status: m.status,
      mode: m.config.mode,
      objective: m.config.objective,
      objectiveText: OBJECTIVES[m.config.objective].describe,
      sols: m.config.sols,
      sol: v.sol,
      team: m.config.team,
      scoreboard: [this.myScore(), ...this.others],
      result: this.outcome ?? (m.result ? { winner: m.result.winner, reason: m.result.reason } : null),
    };
  }

  private publishInfo(): void {
    this.world.setArena(this.info());
  }

  // The Governor's decision round: actions that arrive while it thinks get its latency.
  roundStarted(): void {
    this.roundStartedAt = Date.now();
    if (this.match) this.match.rounds++;
  }

  // The Governor starts a new Hermes chat: its token count starts again from zero.
  chatReset(): void {
    this.govTokens = 0;
  }

  // Real token counts from the key gateway (tools/arena_setup.mjs): every call the team's model
  // answered, as the provider reported it, Governor turns, missions and retries alike. Once the
  // first report arrives the match is charged these instead of Hermes' estimates, so the budget
  // and the freeze follow what the provider billed.
  private realTokens = false;
  providerUsage(tokens: number): void {
    if (!this.match || this.match.status !== "running" || !Number.isFinite(tokens) || tokens <= 0) return;
    this.realTokens = true;
    this.runner.realTokens = true;
    this.runner.command((c) => c.useCompute(Math.round(tokens)));
  }

  roundEnded(reply: { text: string; tokens: number; latencyS: number; timedOut: boolean }): void {
    this.roundStartedAt = null;
    const delta = Math.max(0, reply.tokens - this.govTokens);
    if (reply.tokens > this.govTokens) this.govTokens = reply.tokens;
    if (delta > 0 && !this.realTokens) this.runner.command((c) => c.useCompute(delta));
    const team = this.match?.config.team ?? "A";
    if (reply.timedOut) this.world.logLine(`Team ${team}'s Governor did not answer in time (lost decision).`, "warn");
    else if (reply.text.trim()) this.world.logLine(`Team ${team} (${reply.latencyS}s): ${reply.text.trim().slice(0, 140)}`, "info");
  }

  // A new match: a fresh colony from the seed, the clock running.
  start(cfg: Partial<MatchConfig> = {}): MatchState {
    if (this.match?.status === "running") throw new ColonyError("a match is already running");
    const config: MatchConfig = {
      mode: cfg.mode === "race" ? "race" : "timed",
      objective: cfg.objective === "foothold" || cfg.objective === "ending" || cfg.objective === "sprint" || cfg.objective === "lifeline" ? cfg.objective : "awakening",
      sols: Math.max(1, Math.min(200, Math.floor(cfg.sols ?? 30))),
      tokenBudget: Math.max(10_000, Math.floor(cfg.tokenBudget ?? 2_000_000)),
      seed: Math.floor(cfg.seed ?? 4217),
      team: cfg.team ?? "A",
      model: cfg.model ?? "unknown",
      actionsPerHour: Math.max(1, Math.floor(cfg.actionsPerHour ?? 6)),
      source: cfg.source,
      battlefield: battlefieldFrom(cfg.battlefield),
    };
    this.runner.freshBase();
    this.runner.colony.state = Colony.initial(this.runner.colony.defs, config.seed, config.battlefield?.conditions);
    if (config.battlefield) this.map = config.battlefield.id;
    this.runner.colony.card("landing");
    this.runner.syncWithLayout();
    this.govTokens = 0;
    this.roundStartedAt = null;
    this.outcome = null;
    this.realTokens = false;
    this.runner.realTokens = false;
    this.match = {
      id: `m${Date.now().toString(36)}`,
      status: "running",
      config,
      startedAt: Date.now(),
      startHour: 0,
      hour: 0,
      actions: [],
      hourActions: 0,
      tokensAtStart: this.runner.colony.state.compute.totalKTok * 1000,
      frozen: false,
      warned: false,
      rounds: 0,
      notes: [],
      result: null,
    };
    if (config.battlefield) {
      const k = config.battlefield.conditions;
      this.world.logLine(`Battlefield: ${config.battlefield.name} (${config.battlefield.terrain}). ${config.battlefield.brief} Solar ×${k.solar}, water ×${k.water}, salvage ×${k.salvage}, storms ×${k.storms}.`, "info");
    }
    this.world.logLine(`Match ${this.match.id}: ${config.mode} · ${OBJECTIVES[config.objective].name} · ${config.sols} sols · ${Math.round(config.tokenBudget / 1000)} kTok for team ${config.team} (${config.model})`, "warn");
    this.runner.command((c) => c.setSpeed(c.state.speed === 0 ? 1 : c.state.speed));
    this.emit("match", this.match);
    this.publishInfo();
    return this.match;
  }

  stop(reason = "stopped"): MatchResult | null {
    if (!this.match || this.match.status !== "running") return this.match?.result ?? null;
    return this.finish(reason, false);
  }

  tokensUsed(): number {
    if (!this.match) return 0;
    return Math.max(0, Math.round(this.runner.colony.state.compute.totalKTok * 1000 - this.match.tokensAtStart));
  }

  // The team's view of the world (docs/arena.md §5), compact on purpose.
  observation(): Record<string, unknown> {
    const m = this.match;
    const c = this.runner.colony;
    const v = c.view();
    const used = this.tokensUsed();
    const acts = m?.actions ?? [];
    const lat = acts.filter((a) => a.latencyS !== null).map((a) => a.latencyS as number);
    return {
      match: m
        ? { id: m.id, battlefield: m.config.battlefield ? { name: m.config.battlefield.name, terrain: m.config.battlefield.terrain, brief: m.config.battlefield.brief, conditions: m.config.battlefield.conditions } : null, status: m.status, mode: m.config.mode, objective: m.config.objective, objectiveText: OBJECTIVES[m.config.objective].describe, sol: v.sol, hour: v.hour, solsLeft: Math.max(0, m.config.sols - v.sol), realSecondsPerHour: v.realSecondsPerHour / Math.max(1, v.speed) }
        : null,
      budget: { tokensUsed: used, tokenBudget: m?.config.tokenBudget ?? null, frozen: m?.frozen ?? false, avgLatencyS: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null, actionsLeftThisHour: m ? Math.max(0, m.config.actionsPerHour - m.hourActions) : null },
      power: { supplyKw: v.power.supplyKw, demandKw: v.power.demandKw, chargeKwh: v.power.chargeKwh, chargeCapKwh: v.power.chargeCapKwh, night: !v.daylight, cut: v.power.cut },
      stocks: v.stocks,
      caps: v.caps,
      flows: v.flows,
      colonists: { awake: v.colonists.awake, cryo: v.colonists.cryo, dead: v.colonists.dead, beds: v.colonists.beds, hungry: v.colonists.hungry, thirsty: v.colonists.thirsty, waking: v.colonists.waking },
      machines: { count: v.machines.count, powered: v.machines.powered, building: v.machines.building, autonomy: Object.fromEntries(DEPTS.map((d) => [d, v.autonomy[d].level])) },
      buildings: v.buildings.map((b) => ({ id: b.id, type: b.type, enabled: b.enabled, powered: b.powered, producing: b.producing, crew: b.crew })),
      site: v.building ? { id: v.building.id, type: v.building.type, hoursLeft: v.building.hoursLeft, builders: v.building.builders } : null,
      catalog: v.catalog.map((k) => ({ type: k.type, cost: k.cost, hours: k.buildHours, drawKw: k.drawKw, genKw: k.genKw, blocked: k.blocked })),
      research: v.research.options.map((o) => ({ id: o.id, cost: o.cost, done: o.done, unlocks: o.unlocks })),
      mission: this.world.getMission() ? { status: this.world.getMission()!.status, title: this.world.getMission()!.title.slice(0, 80) } : null,
      trust: v.trust,
      influence: v.influence,
      reactor: v.reactor,
      chapter: v.chapter,
      lastActions: acts.slice(-6).map((a) => ({ id: a.id, hour: a.hour, tool: a.tool, args: a.args, ok: a.ok, reason: a.reason })),
      scoreboard: m ? [{ team: m.config.team, model: m.config.model, awake: v.colonists.awake, value: colonyValue(c), avgLatencyS: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null, tokens: used }] : [],
    };
  }

  // One action from the team. Validation, then the same code the game's buttons run.
  action(tool: string, args: Record<string, unknown> = {}, latencyS: number | null = null): { ok: boolean; id: string; reason?: string } {
    const m = this.match;
    const id = `a${++this.seq}`;
    const refuse = (reason: string) => {
      if (m) m.actions.push({ id, hour: m.hour, tool, args, ok: false, reason, latencyS, ts: Date.now() });
      this.emit("action", { id, tool, args, ok: false, reason, latencyS });
      return { ok: false, id, reason };
    };
    if (latencyS === null && this.roundStartedAt !== null) latencyS = Math.round((Date.now() - this.roundStartedAt) / 100) / 10;
    if (!m || m.status !== "running") return refuse("no match is running");
    if (!TOOLS.includes(tool as (typeof TOOLS)[number])) return refuse(`unknown tool ${tool}`);
    if (tool === "colony_state") return { ok: true, id };
    if (m.frozen) return refuse("the team is frozen: token budget spent");
    if (m.hourActions >= m.config.actionsPerHour) return refuse(`only ${m.config.actionsPerHour} actions per game hour`);
    try {
      this.apply(tool, args);
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    m.hourActions++;
    m.actions.push({ id, hour: m.hour, tool, args, ok: true, reason: null, latencyS, ts: Date.now() });
    this.emit("action", { id, tool, args, ok: true, reason: null, latencyS });
    return { ok: true, id };
  }

  private apply(tool: string, a: Record<string, unknown>): void {
    const r = this.runner;
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
    const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : Number(a[k]));
    switch (tool) {
      case "colony_build":
        return r.command((_, run) => run.build(str("type") || str("building"), Number.isFinite(num("x")) ? num("x") : undefined, Number.isFinite(num("z")) ? num("z") : undefined));
      case "colony_cancel_build":
        return r.command((_, run) => run.cancelBuild());
      case "colony_toggle":
        return r.command((c) => void c.toggle(str("id") || str("buildingId"), a.enabled !== false && a.enabled !== "false"));
      case "colony_wake":
        return r.command((c) => c.wake(Number.isFinite(num("count")) ? num("count") : 8));
      case "colony_autonomy":
        return r.command((c) => c.setAutonomy(str("target") || str("department"), num("level")));
      case "colony_research":
        return r.command((c) => c.research(str("tier") || str("id")));
      case "colony_repair":
        return r.command((c) => c.repair((str("target") || "reactor") as "reactor"));
      case "colony_study": {
        // A real research mission in the Research Lab; it earns data when it completes.
        const topic = str("topic").trim();
        if (!topic) throw new ColonyError("colony_study needs a topic");
        if (!r.source) throw new ColonyError("no mission source");
        const mi = this.world.getMission();
        if (mi && (mi.status === "planning" || mi.status === "running")) throw new ColonyError("a mission is already running; wait for it");
        if (!r.colony.state.buildings.some((b) => b.type === "researchLab" && b.enabled)) throw new ColonyError("build a Research Lab first: missions earn data only there");
        void r.source.createMission(topic.slice(0, 200));
        return;
      }
      case "colony_path":
        return r.command((c) => c.choosePath(str("path")));
      case "colony_shutdown_mother":
        return r.command((c) => c.shutdownMother());
      case "colony_note": {
        const text = str("text").trim().slice(0, 120);
        if (!text) throw new ColonyError("empty note");
        this.match!.notes.push({ hour: this.match!.hour, text });
        this.world.logLine(`Team ${this.match!.config.team}: ${text}`, "info");
        return;
      }
      default:
        throw new ColonyError(`unknown tool ${tool}`);
    }
  }

  // The clock: every colony hour resets the window, checks the budget and the objective.
  private onWorld(m: ServerMessage): void {
    if (m.type !== "resource.update" || !m.resources.colony) return;
    const match = this.match;
    if (!match || match.status !== "running") return;
    const v = m.resources.colony;
    const hour = v.sol * 24 + v.hour;
    const used = this.tokensUsed();
    if (!match.warned && used >= 0.9 * match.config.tokenBudget) {
      match.warned = true;
      this.world.logLine(`Team ${match.config.team} has used 90% of its compute budget.`, "warn");
    }
    if (!match.frozen && used >= match.config.tokenBudget) {
      match.frozen = true;
      this.world.logLine(`Team ${match.config.team} is frozen: compute budget spent. The colony runs on at its last settings.`, "error");
    }
    if (hour !== match.hour) {
      match.hour = hour;
      match.hourActions = 0;
      this.emit("hour", hour);
      this.publishInfo();
    }
    const obj = OBJECTIVES[match.config.objective];
    if (match.config.mode === "race" && obj.check(this.colony)) this.finish(`${obj.name}: ${obj.describe}`, true);
    else if (v.sol >= match.config.sols) this.finish(match.config.mode === "race" ? `time is up without ${obj.name}` : `${match.config.sols} sols played`, match.config.mode === "timed");
    else if (this.colony.state.awake === 0) this.finish("the colony died", false);
    else if (this.colony.state.story.ending) this.finish(`${this.colony.state.story.ending} ending`, this.colony.state.story.ending !== "Extinction");
  }

  private finish(reason: string, achieved: boolean): MatchResult {
    const m = this.match!;
    const c = this.runner.colony;
    const lat = m.actions.filter((a) => a.latencyS !== null).map((a) => a.latencyS as number);
    const value = colonyValue(c);
    const result: MatchResult = {
      winner: achieved || m.config.mode === "timed" ? m.config.team : null,
      reason,
      placings: [{ team: m.config.team, model: m.config.model, value, awake: c.state.awake, tokens: this.tokensUsed(), avgLatencyS: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 10) / 10 : null, actions: m.actions.filter((a) => a.ok).length, rejected: m.actions.filter((a) => !a.ok).length }],
      sols: c.sol,
      endedAt: Date.now(),
    };
    m.status = "finished";
    m.result = result;
    this.world.logLine(`Match ${m.id} over: ${reason}. Team ${m.config.team} value ${value}, ${c.state.awake} awake, ${Math.round(result.placings[0].tokens / 1000)} kTok.`, "warn");
    this.emit("finished", result);
    this.publishInfo();
    return result;
  }
}
