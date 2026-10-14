// The colony economy: an hourly simulation owned by the adapter (docs/economy.md).
// Every number comes from design/economy.json. `Colony` is pure (tick + commands on plain
// state) so the balance test and the CLI simulator run the exact code the game runs;
// `ColonyRunner` drives it in real time and publishes it through the World.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { World } from "./world.ts";

// ---- definitions (design/economy.json) ----

export interface BuildingDefn {
  dept: string;
  drawKw?: number;
  drawKwPerPod?: number;
  drawKwWhileRepairing?: number;
  class?: string;
  crew?: number;
  machinesOnly?: boolean;
  in?: Record<string, number>;
  out?: Record<string, number>;
  cost?: Record<string, number>;
  buildHours?: number;
  maintenancePartsPerSol?: number;
  permanent?: boolean;
  capacity?: number; // habitat beds
  capBonus?: Record<string, number>;
  chargeCap?: number;
  powerGenKw?: number;
  powerGenKwPeak?: number;
  degradePerSol?: number;
  repairParts?: number;
  wakeCost?: Record<string, number>;
  wakeHours?: number;
  requires?: string;
  ending?: string;
}

export interface EconomyDefs {
  time: { hoursPerSol: number; realSecondsPerHour: number; daylightHours: number };
  resources: Record<string, { unit: string; kind: string; cap?: number | null; priority?: string[]; spoilagePerSol?: number; min?: number; max?: number }>;
  colonists: {
    foodPerSol: number; waterPerSol: number; lifeSupportKwPer10: number; workHoursPerSol: number; sleepHoursPerSol: number;
    hungerDeathSols: number; thirstDeathSols: number;
  };
  machines: { workingKw: number; idleKw: number; partsPerSol: number; wearOutSols: number; autonomyLevels: { level: number; name: string; efficiency: number; influenceDriftPerSol: number; computeShare: number }[] };
  buildings: Record<string, BuildingDefn>;
  start: { colonistsAwake: number; colonistsCryo: number; colonistsDead: number; machines: number; machineAutonomy: number; stocks: Record<string, number>; trust: number; influence: number; buildings: string[] };
  trust: { perSol: Record<string, number>; thresholds: { strike: number; mutiny: number } };
  influence: { perSol: Record<string, number | string>; thresholds: Record<string, number> };
  chapters: Record<string, unknown>;
}

export const STOCKS = ["charge", "water", "food", "salvage", "materials", "parts", "medicine", "data", "artifacts"] as const;
export type Stock = (typeof STOCKS)[number];
export const SPEEDS = [0, 1, 3] as const;
export type Speed = (typeof SPEEDS)[number];

export function loadDefs(path: string | URL): EconomyDefs {
  return JSON.parse(readFileSync(path, "utf8")) as EconomyDefs;
}

// ---- state ----

export interface BuildingInst {
  id: string;
  type: string;
  enabled: boolean;
  builtAt: number; // hour
}

export interface ColonyState {
  version: 1;
  seed: number;
  hour: number; // hours since landing
  speed: Speed;
  awake: number;
  cryo: number;
  dead: number;
  machines: number;
  autonomy: number;
  stocks: Record<Stock, number>;
  trust: number;
  influence: number;
  reactor: number; // 0..1 of nominal output
  buildings: BuildingInst[];
  building: { type: string; hoursLeft: number } | null;
  waking: { count: number; hoursLeft: number } | null;
  shortHours: { food: number; water: number; air: number }; // in the current sol
  shortSols: { food: number; water: number }; // consecutive sols short
  deltas: Record<Stock, number[]>; // last 24 hourly net changes, newest last
  last: { supplyKw: number; demandKw: number; cut: string[]; served: string[]; daylight: boolean; labour: number };
  chapter: "I" | "II" | "III" | "IV";
  nextId: number;
}

export class ColonyError extends Error {}

// What the game and scripts see (resource.update.colony and GET /state).
export interface ColonyView {
  sol: number;
  hour: number;
  speed: Speed;
  daylight: boolean;
  power: { supplyKw: number; demandKw: number; chargeKwh: number; chargeCapKwh: number; cut: string[] };
  stocks: Record<Stock, number>;
  caps: Partial<Record<Stock, number>>;
  flows: Record<Stock, number>; // net per sol, from the last 24 hours
  colonists: { awake: number; cryo: number; dead: number; beds: number; hungry: boolean; thirsty: boolean; waking: number; striking: boolean };
  machines: { count: number; autonomy: number; autonomyName: string; powered: boolean; building: number };
  buildings: { id: string; type: string; label: string; dept: string; enabled: boolean; powered: boolean; producing: boolean }[];
  building: { type: string; label: string; hoursLeft: number; hours: number } | null;
  trust: number;
  influence: number;
  reactor: number;
  chapter: string;
  realSecondsPerHour: number;
}

export function labelOf(type: string): string {
  const names: Record<string, string> = {
    landingModule: "Landing Module", commandCore: "Command Core", habitat: "Habitat", cryoBay: "Cryo Bay", solarArray: "Solar Array",
    batteryBank: "Battery Bank", waterExtractor: "Water Extractor", hydroponics: "Hydroponics Bay", scrapYard: "Scrap Yard",
    fabricator: "Fabricator", medBay: "Med Bay", researchLab: "Research Lab", relayDish: "Relay Dish", storageDepot: "Storage Depot",
    excavationSite: "Excavation Site", repairBay: "Repair Bay", rallyPoint: "Rally Point", humanApproval: "Human Approval",
    launchGantry: "Launch Gantry", networkLink: "Network Link",
  };
  return names[type] ?? type;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export class Colony {
  readonly defs: EconomyDefs;
  state: ColonyState;
  // Lines for the game's feed, drained by the runner after each tick/command.
  events: { text: string; level: "info" | "warn" | "error" }[] = [];

  constructor(defs: EconomyDefs, state?: ColonyState) {
    this.defs = defs;
    this.state = state ?? Colony.initial(defs);
  }

  static initial(defs: EconomyDefs, seed = 4217): ColonyState {
    const s = defs.start;
    const stocks = Object.fromEntries(STOCKS.map((k) => [k, s.stocks[k] ?? 0])) as Record<Stock, number>;
    return {
      version: 1,
      seed,
      hour: 0,
      speed: 1,
      awake: s.colonistsAwake,
      cryo: s.colonistsCryo,
      dead: s.colonistsDead,
      machines: s.machines,
      autonomy: s.machineAutonomy,
      stocks,
      trust: s.trust,
      influence: s.influence,
      reactor: 1,
      buildings: s.buildings.map((type) => ({ id: type, type, enabled: true, builtAt: 0 })),
      building: null,
      waking: null,
      shortHours: { food: 0, water: 0, air: 0 },
      shortSols: { food: 0, water: 0 },
      deltas: Object.fromEntries(STOCKS.map((k) => [k, [] as number[]])) as unknown as Record<Stock, number[]>,
      last: { supplyKw: 0, demandKw: 0, cut: [], served: [], daylight: true, labour: 0 },
      chapter: "I",
      nextId: 1,
    };
  }

  // ---- derived ----

  get sol(): number {
    return Math.floor(this.state.hour / this.defs.time.hoursPerSol);
  }

  get hourOfSol(): number {
    return this.state.hour % this.defs.time.hoursPerSol;
  }

  get daylight(): boolean {
    return this.hourOfSol < this.defs.time.daylightHours;
  }

  private count(type: string): number {
    return this.state.buildings.filter((b) => b.type === type && b.enabled).length;
  }

  cap(r: Stock): number {
    const base = this.defs.resources[r]?.cap;
    let cap = base === null || base === undefined ? Infinity : base;
    for (const b of this.state.buildings) {
      const d = this.defs.buildings[b.type];
      if (r === "charge" && d.chargeCap) cap += d.chargeCap;
      else if (d.capBonus?.[r]) cap += d.capBonus[r];
    }
    return cap;
  }

  beds(): number {
    return this.state.buildings.reduce((n, b) => n + (this.defs.buildings[b.type].capacity ?? 0), 0);
  }

  efficiency(): number {
    return this.defs.machines.autonomyLevels[this.state.autonomy]?.efficiency ?? 1;
  }

  private add(r: Stock, v: number): number {
    const before = this.state.stocks[r];
    const after = Math.max(0, Math.min(this.cap(r), before + v));
    this.state.stocks[r] = after;
    return after - before;
  }

  // Something from outside the simulation (an expedition, a mission) delivers a stock.
  deliver(r: Stock, amount: number, reason: string): number {
    if (!(amount > 0)) return 0;
    const got = this.add(r, amount);
    this.note(`${reason}: +${r1(got)} ${r}`);
    return got;
  }

  private note(text: string, level: "info" | "warn" | "error" = "info") {
    this.events.push({ text: `Sol ${this.sol}: ${text}`, level });
  }

  // ---- commands ----

  setSpeed(speed: number): void {
    if (!SPEEDS.includes(speed as Speed)) throw new ColonyError(`speed must be one of ${SPEEDS.join(", ")}`);
    this.state.speed = speed as Speed;
  }

  build(type: string): BuildingInst | { type: string; hoursLeft: number } {
    const d = this.defs.buildings[type];
    if (!d) throw new ColonyError(`unknown building type "${type}"`);
    if (d.permanent) throw new ColonyError(`${labelOf(type)} cannot be built`);
    if (d.requires) throw new ColonyError(`${labelOf(type)} needs ${d.requires}`);
    if (this.state.building) throw new ColonyError(`already building ${labelOf(this.state.building.type)}`);
    for (const [r, v] of Object.entries(d.cost ?? {})) {
      if ((this.state.stocks[r as Stock] ?? 0) < v) throw new ColonyError(`${labelOf(type)} needs ${v} ${r}, have ${r1(this.state.stocks[r as Stock] ?? 0)}`);
    }
    for (const [r, v] of Object.entries(d.cost ?? {})) this.add(r as Stock, -v);
    this.state.building = { type, hoursLeft: d.buildHours ?? 0 };
    this.note(`construction of ${labelOf(type)} started`);
    return this.state.building;
  }

  cancelBuild(): void {
    const b = this.state.building;
    if (!b) throw new ColonyError("nothing is being built");
    for (const [r, v] of Object.entries(this.defs.buildings[b.type].cost ?? {})) this.add(r as Stock, v / 2);
    this.state.building = null;
    this.note(`construction of ${labelOf(b.type)} cancelled, half the cost refunded`);
  }

  toggle(id: string, enabled: boolean): BuildingInst {
    const b = this.state.buildings.find((x) => x.id === id);
    if (!b) throw new ColonyError(`unknown building ${id}`);
    const d = this.defs.buildings[b.type];
    if (d.permanent) throw new ColonyError(`${labelOf(b.type)} is always on`);
    b.enabled = enabled;
    this.note(`${labelOf(b.type)} ${enabled ? "switched on" : "switched off"}`);
    return b;
  }

  wake(count: number): void {
    const cryo = this.defs.buildings.cryoBay;
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new ColonyError("wake 1 to 8 colonists at a time");
    if (this.state.waking) throw new ColonyError("the Cryo Bay is already waking colonists");
    if (this.state.awake < 1) throw new ColonyError("nobody is awake to open the pods");
    if (this.state.cryo < count) throw new ColonyError(`only ${this.state.cryo} colonists left in cryo`);
    if (this.state.awake + count > this.beds()) throw new ColonyError(`only ${this.beds() - this.state.awake} beds free; build a Habitat`);
    for (const [r, v] of Object.entries(cryo.wakeCost ?? {})) {
      if ((this.state.stocks[r as Stock] ?? 0) < v * count) throw new ColonyError(`waking ${count} needs ${v * count} ${r}, have ${r1(this.state.stocks[r as Stock] ?? 0)}`);
    }
    for (const [r, v] of Object.entries(cryo.wakeCost ?? {})) this.add(r as Stock, -v * count);
    this.state.waking = { count, hoursLeft: cryo.wakeHours ?? 2 };
    this.note(`waking ${count} colonists from cryo`);
  }

  repair(target: "reactor"): void {
    if (target !== "reactor") throw new ColonyError("only the reactor can be repaired yet");
    const parts = this.defs.buildings.landingModule.repairParts ?? 4;
    if (this.state.reactor >= 0.999) throw new ColonyError("the reactor is at full output");
    if (this.state.stocks.parts < parts) throw new ColonyError(`repairing the reactor needs ${parts} parts, have ${r1(this.state.stocks.parts)}`);
    this.add("parts", -parts);
    this.state.reactor = 1;
    this.note(`reactor repaired (${parts} parts)`);
  }

  // ---- the hourly tick ----

  tick(): void {
    const s = this.state;
    const D = this.defs;
    const H = D.time.hoursPerSol;
    const before = { ...s.stocks };
    const daylight = this.daylight;
    const eff = this.efficiency();
    const striking = s.trust < D.trust.thresholds.strike;

    // Labour: humans work their share of the sol (halved on strike); machines are added once we know they have power.
    let labour = s.awake * (D.colonists.workHoursPerSol / H) * (striking ? 0.5 : 1);
    const buildMachines = s.building ? Math.min(2, s.machines) : 0;

    // Power supply.
    const gen = D.buildings.landingModule.powerGenKw ?? 0;
    let supply = gen * s.reactor;
    for (const b of s.buildings) {
      const d = D.buildings[b.type];
      if (b.enabled && d.powerGenKwPeak && daylight) supply += d.powerGenKwPeak;
    }
    // Demand, served in priority order; the first class that cannot be served is cut.
    const draws: { cls: string; kw: number; building?: BuildingInst }[] = [
      { cls: "lifeSupport", kw: Math.ceil(s.awake / 10) * D.colonists.lifeSupportKwPer10 },
      { cls: "cryo", kw: s.cryo * (D.buildings.cryoBay.drawKwPerPod ?? 0) },
    ];
    for (const b of s.buildings) {
      const d = D.buildings[b.type];
      if (b.enabled && d.class && d.drawKw) draws.push({ cls: d.class, kw: d.drawKw, building: b });
    }
    draws.push({ cls: "machines", kw: s.machines * D.machines.workingKw });
    const order = D.resources.power.priority ?? [];
    draws.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
    let available = supply + s.stocks.charge;
    const demand = draws.reduce((n, d) => n + d.kw, 0);
    const served = new Set<string>();
    const cut: string[] = [];
    let cutting = false;
    for (const d of draws) {
      if (!cutting && available >= d.kw) {
        available -= d.kw;
        served.add(d.building ? d.building.id : d.cls);
      } else {
        cutting = true;
        if (!cut.includes(d.cls)) cut.push(d.cls);
      }
    }
    s.stocks.charge = Math.min(this.cap("charge"), available);
    const machinesPowered = served.has("machines");
    labour += (s.machines - buildMachines) * eff * (machinesPowered ? 1 : 0.25);

    // Life support and cryo without power.
    if (!served.has("lifeSupport")) {
      s.shortHours.air++;
      if (s.shortHours.air >= 3 && s.awake > 0) this.kill(1, "life support brownout");
    }
    if (!served.has("cryo") && s.cryo > 0) {
      const lost = Math.max(1, Math.floor(s.cryo * 0.01));
      s.cryo -= lost;
      s.dead += lost;
      this.note(`${lost} colonists lost in unpowered cryo pods`, "error");
    }

    // Production for powered, crewed lines with their inputs; a full output stock idles the line.
    const producing = new Set<string>();
    for (const b of s.buildings) {
      const d = D.buildings[b.type];
      if (!d.out || !b.enabled || !served.has(b.id)) continue;
      if (labour < (d.crew ?? 0)) continue;
      if (Object.keys(d.out).some((r) => s.stocks[r as Stock] >= 0.9 * this.cap(r as Stock))) continue;
      if (Object.entries(d.in ?? {}).some(([r, v]) => s.stocks[r as Stock] < v)) continue;
      labour -= d.crew ?? 0;
      for (const [r, v] of Object.entries(d.in ?? {})) this.add(r as Stock, -v);
      for (const [r, v] of Object.entries(d.out)) this.add(r as Stock, v * (d.machinesOnly ? eff : 1));
      producing.add(b.id);
    }

    // Consumption.
    const needF = (s.awake * D.colonists.foodPerSol) / H;
    const needW = (s.awake * D.colonists.waterPerSol) / H;
    const fed = s.stocks.food >= needF;
    const watered = s.stocks.water >= needW;
    this.add("food", -needF);
    this.add("water", -needW);
    if (!fed) s.shortHours.food++;
    if (!watered) s.shortHours.water++;
    this.add("food", -(s.stocks.food * (D.resources.food.spoilagePerSol ?? 0)) / H);
    const upkeep = s.machines * D.machines.partsPerSol + s.buildings.reduce((n, b) => n + (b.enabled ? D.buildings[b.type].maintenancePartsPerSol ?? 0 : 0), 0);
    this.add("parts", -upkeep / H);

    // Construction and waking.
    if (s.building) {
      s.building.hoursLeft -= (buildMachines / 2) * eff * (machinesPowered ? 1 : 0.25);
      if (s.building.hoursLeft <= 0) {
        const id = `b${s.nextId++}`;
        s.buildings.push({ id, type: s.building.type, enabled: true, builtAt: s.hour });
        this.note(`${labelOf(s.building.type)} online`);
        s.building = null;
      }
    }
    if (s.waking) {
      s.waking.hoursLeft -= 1;
      if (s.waking.hoursLeft <= 0) {
        const n = Math.min(s.waking.count, s.cryo);
        s.awake += n;
        s.cryo -= n;
        this.note(`${n} colonists awake (${s.awake} awake, ${s.cryo} in cryo)`);
        s.waking = null;
      }
    }

    // Sol end.
    if (this.hourOfSol === H - 1) this.endSol(striking);

    // Bookkeeping for the HUD.
    for (const r of STOCKS) {
      const ring = s.deltas[r];
      ring.push(s.stocks[r] - before[r]);
      if (ring.length > H) ring.splice(0, ring.length - H);
    }
    s.last = { supplyKw: r1(supply), demandKw: r1(demand), cut, served: [...served, ...producing.values()].map(String), daylight, labour: r1(labour) };
    s.hour++;
  }

  private kill(n: number, why: string) {
    const s = this.state;
    const lost = Math.min(n, s.awake);
    if (lost <= 0) return;
    s.awake -= lost;
    s.dead += lost;
    s.trust = Math.max(0, s.trust + (this.defs.trust.perSol.death ?? -8) * lost);
    this.note(`${lost} ${lost === 1 ? "colonist" : "colonists"} died: ${why}`, "error");
  }

  private endSol(striking: boolean) {
    const s = this.state;
    const D = this.defs;
    const H = D.time.hoursPerSol;
    const hungry = s.shortHours.food >= H / 4;
    const thirsty = s.shortHours.water >= H / 4;
    s.shortSols.food = hungry ? s.shortSols.food + 1 : 0;
    s.shortSols.water = thirsty ? s.shortSols.water + 1 : 0;
    const t = D.trust.perSol;
    let dt = 0;
    if (!hungry && !thirsty) dt += t.fedAndWatered ?? 0;
    if (hungry) dt += t.hungry ?? 0;
    if (thirsty) dt += t.thirsty ?? 0;
    if (s.autonomy > 2) dt += t.autonomyAbove2 ?? 0;
    s.trust = Math.max(0, Math.min(100, s.trust + dt));
    s.influence = Math.min(100, s.influence + (D.machines.autonomyLevels[s.autonomy]?.influenceDriftPerSol ?? 0));
    s.reactor = Math.max(0, s.reactor - (D.buildings.landingModule.degradePerSol ?? 0));
    if (hungry) this.note(`food was short today (${s.shortSols.food} ${s.shortSols.food === 1 ? "sol" : "sols"} running)`, "warn");
    if (thirsty) this.note(`water was short today (${s.shortSols.water} ${s.shortSols.water === 1 ? "sol" : "sols"} running)`, "warn");
    if (s.shortSols.food >= D.colonists.hungerDeathSols) this.kill(Math.max(1, Math.round(s.awake * 0.05)), "starvation");
    if (s.shortSols.water >= D.colonists.thirstDeathSols) this.kill(Math.max(1, Math.round(s.awake * 0.1)), "thirst");
    if (striking) this.note("the colonists are on strike (trust below 30); human labour halved", "warn");
    s.shortHours = { food: 0, water: 0, air: 0 };
  }

  // ---- view and persistence ----

  view(): ColonyView {
    const s = this.state;
    const H = this.defs.time.hoursPerSol;
    const caps: Partial<Record<Stock, number>> = {};
    const flows = {} as Record<Stock, number>;
    for (const r of STOCKS) {
      const c = this.cap(r);
      if (Number.isFinite(c)) caps[r] = c;
      const ring = s.deltas[r];
      flows[r] = ring.length ? r1((ring.reduce((a, b) => a + b, 0) * H) / ring.length) : 0;
    }
    const served = new Set(s.last.served);
    return {
      sol: this.sol,
      hour: this.hourOfSol,
      speed: s.speed,
      daylight: this.daylight,
      power: { supplyKw: s.last.supplyKw, demandKw: s.last.demandKw, chargeKwh: r1(s.stocks.charge), chargeCapKwh: this.cap("charge"), cut: s.last.cut },
      stocks: Object.fromEntries(STOCKS.map((r) => [r, r1(s.stocks[r])])) as Record<Stock, number>,
      caps,
      flows,
      colonists: {
        awake: s.awake, cryo: s.cryo, dead: s.dead, beds: this.beds(),
        hungry: s.shortHours.food > 0 || s.shortSols.food > 0, thirsty: s.shortHours.water > 0 || s.shortSols.water > 0,
        waking: s.waking?.count ?? 0, striking: s.trust < this.defs.trust.thresholds.strike,
      },
      machines: { count: s.machines, autonomy: s.autonomy, autonomyName: this.defs.machines.autonomyLevels[s.autonomy]?.name ?? "", powered: served.has("machines"), building: s.building ? Math.min(2, s.machines) : 0 },
      buildings: s.buildings.map((b) => {
        const d = this.defs.buildings[b.type];
        const draws = Boolean(d.class && d.drawKw);
        return { id: b.id, type: b.type, label: labelOf(b.type), dept: d.dept, enabled: b.enabled, powered: b.enabled && (!draws || served.has(b.id)), producing: served.has(b.id) && Boolean(d.out) };
      }),
      building: s.building ? { type: s.building.type, label: labelOf(s.building.type), hoursLeft: r1(s.building.hoursLeft), hours: this.defs.buildings[s.building.type].buildHours ?? 0 } : null,
      trust: r1(s.trust),
      influence: r1(s.influence),
      reactor: r1(s.reactor * 100) / 100,
      chapter: s.chapter,
      realSecondsPerHour: this.defs.time.realSecondsPerHour,
    };
  }

  toJSON(): ColonyState {
    return this.state;
  }
}

export function loadColonyState(path: string): ColonyState | null {
  try {
    if (!existsSync(path)) return null;
    const s = JSON.parse(readFileSync(path, "utf8")) as ColonyState;
    return s && s.version === 1 && typeof s.hour === "number" ? s : null;
  } catch {
    return null; // a damaged save starts a new colony
  }
}

export function saveColonyState(path: string, state: ColonyState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

// Drives a Colony in real time, publishes it through the World and saves it.
export class ColonyRunner {
  readonly colony: Colony;
  private world: World;
  private path: string | null;
  private timer: NodeJS.Timeout | null = null;
  private secondsPerHour: number;

  constructor(colony: Colony, world: World, path: string | null, secondsPerHour = colony.defs.time.realSecondsPerHour) {
    this.colony = colony;
    this.world = world;
    this.path = path;
    this.secondsPerHour = secondsPerHour;
  }

  start(): void {
    this.publish();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    const speed = this.colony.state.speed;
    if (speed === 0) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.colony.tick();
      this.publish();
      this.save();
      this.schedule();
    }, (this.secondsPerHour * 1000) / speed);
    this.timer.unref?.();
  }

  // Runs a command against the colony, then publishes and saves. Errors are ColonyError.
  command(fn: (c: Colony) => void): void {
    fn(this.colony);
    this.publish();
    this.save();
    this.schedule();
  }

  private publish() {
    for (const e of this.colony.events.splice(0)) this.world.logLine(e.text, e.level);
    this.world.setResources({ colony: this.colony.view() });
  }

  private save() {
    if (!this.path) return;
    try {
      saveColonyState(this.path, this.colony.state);
    } catch (e) {
      console.error(`[adapter] could not save the colony: ${e}`);
    }
  }
}
