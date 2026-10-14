// The colony economy: an hourly simulation owned by the adapter (docs/economy.md).
// Every number comes from design/economy.json. `Colony` is pure (tick + commands on plain
// state) so the balance test and the CLI simulator run the exact code the game runs;
// `ColonyRunner` drives it in real time and publishes it through the World.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BaseLayout, cloneLayout, KIND_DEPT, KIND_LABEL, KIND_MODEL, START_IDS, upsertBuilding } from "./layout.ts";
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
  building: { id: string; type: string; hoursLeft: number } | null;
  waking: { count: number; hoursLeft: number } | null;
  shortHours: { food: number; water: number; air: number }; // in the current sol
  shortSols: { food: number; water: number }; // consecutive sols short
  deltas: Record<Stock, number[]>; // last 24 hourly net changes, newest last
  last: { supplyKw: number; demandKw: number; cut: string[]; served: string[]; daylight: boolean; labour: number; crews: Record<string, number>; builders: number };
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
  buildings: {
    id: string; type: string; label: string; dept: string; enabled: boolean; powered: boolean; producing: boolean;
    crew: number; crewNeeded: number; drawKw: number; in: Record<string, number>; out: Record<string, number>; permanent: boolean; note: string;
  }[];
  building: { id: string; type: string; label: string; hoursLeft: number; hours: number; builders: number } | null;
  catalog: { type: string; label: string; dept: string; cost: Record<string, number>; buildHours: number; drawKw: number; genKw: number; crew: number; in: Record<string, number>; out: Record<string, number>; affordable: boolean; blocked: string | null; note: string }[];
  trust: number;
  influence: number;
  reactor: number;
  chapter: string;
  realSecondsPerHour: number;
}

export function labelOf(type: string): string {
  return KIND_LABEL[type] ?? (type === "repairBay" ? "Repair Bay" : type === "rallyPoint" ? "Rally Point" : type);
}

// What a building does, for the catalog and the building panel.
export function noteOf(type: string): string {
  const notes: Record<string, string> = {
    landingModule: "The wrecked lander's reactor: 30 kW, losing 1% a sol until repaired.",
    commandCore: "MOTHER. Hosts compute and plans missions.",
    humanApproval: "Where the Warden waits for your decision.",
    cryoBay: "198 colonists asleep; each pod draws power. Wake them here.",
    habitat: "40 beds. Colonists need one each.",
    storageDepot: "Raises the caps on water, food, salvage, materials and parts.",
    solarArray: "40 kW in daylight, nothing at night.",
    batteryBank: "Stores 150 kWh of daytime surplus for the night.",
    waterExtractor: "Pulls 5 L of water an hour from the air and ice.",
    scrapYard: "Turns 2 kg of salvage an hour into materials and the odd part.",
    fabricator: "Makes parts from materials: construction, upkeep and repairs.",
    hydroponics: "60 meals a sol from 24 L of water; feeds 20 colonists.",
    medBay: "Medicine from materials: waking colonists, injuries, illness.",
    researchLab: "Where real research missions earn data.",
    relayDish: "Listens to deep space. Something is out there.",
    excavationSite: "Digs into the ruins for artifacts. Machines only.",
    launchGantry: "The way home.",
    networkLink: "A door into the planetary network.",
  };
  return notes[type] ?? "";
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export class Colony {
  readonly defs: EconomyDefs;
  state: ColonyState;
  // Lines for the game's feed, drained by the runner after each tick/command.
  events: { text: string; level: "info" | "warn" | "error" }[] = [];
  // Ids of sites finished in the last tick (the runner updates the map).
  completed: string[] = [];

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
      buildings: s.buildings.filter((type) => START_IDS[type]).map((type) => ({ id: START_IDS[type], type, enabled: true, builtAt: 0 })),
      building: null,
      waking: null,
      shortHours: { food: 0, water: 0, air: 0 },
      shortSols: { food: 0, water: 0 },
      deltas: Object.fromEntries(STOCKS.map((k) => [k, [] as number[]])) as unknown as Record<Stock, number[]>,
      last: { supplyKw: 0, demandKw: 0, cut: [], served: [], daylight: true, labour: 0, crews: {}, builders: 0 },
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

  // The machines are the real agents on the map (everyone but the Foreman).
  setMachines(n: number): void {
    this.state.machines = Math.max(0, Math.floor(n));
  }

  // Keep the economy's buildings in step with the map: every built building with a kind
  // counts, nothing else does. Returns true when something changed.
  syncBuildings(layout: BaseLayout): boolean {
    const s = this.state;
    const want = layout.buildings.filter((b) => b.kind && this.defs.buildings[b.kind] && b.status !== "building");
    const before = JSON.stringify(s.buildings.map((b) => [b.id, b.type]));
    const kept = s.buildings.filter((b) => want.some((w) => w.id === b.id && w.kind === b.type));
    for (const w of want) if (!kept.some((b) => b.id === w.id)) kept.push({ id: w.id, type: w.kind!, enabled: true, builtAt: s.hour });
    s.buildings = kept;
    if (s.building && !layout.buildings.some((b) => b.id === s.building!.id)) s.building = null;
    return before !== JSON.stringify(s.buildings.map((b) => [b.id, b.type]));
  }

  removeBuilding(id: string): void {
    const b = this.state.buildings.find((x) => x.id === id);
    if (!b) return;
    if (this.defs.buildings[b.type]?.permanent) throw new ColonyError(`${labelOf(b.type)} cannot be removed`);
    this.state.buildings = this.state.buildings.filter((x) => x.id !== id);
    this.note(`${labelOf(b.type)} demolished`);
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

  // Why a kind cannot be built right now, or null.
  blocked(type: string): string | null {
    const d = this.defs.buildings[type];
    if (!d) return `unknown building type "${type}"`;
    if (d.permanent) return `${labelOf(type)} cannot be built`;
    if (d.requires) return `${labelOf(type)} needs ${d.requires}`;
    if (this.state.building) return `already building ${labelOf(this.state.building.type)}`;
    for (const [r, v] of Object.entries(d.cost ?? {})) {
      if ((this.state.stocks[r as Stock] ?? 0) < v) return `${labelOf(type)} needs ${v} ${r}, have ${r1(this.state.stocks[r as Stock] ?? 0)}`;
    }
    return null;
  }

  // Pays for a building and opens its site; `id` is the map building's id.
  build(type: string, id?: string): { id: string; type: string; hoursLeft: number } {
    const why = this.blocked(type);
    if (why) throw new ColonyError(why);
    const d = this.defs.buildings[type];
    for (const [r, v] of Object.entries(d.cost ?? {})) this.add(r as Stock, -v);
    this.state.building = { id: id ?? `b${this.state.nextId++}`, type, hoursLeft: d.buildHours ?? 0 };
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

  // One game hour. `builders` is how many machines are at the construction site this hour
  // (the runner counts the real agents; the simulator assumes two).
  tick(builders?: number): void {
    const s = this.state;
    const D = this.defs;
    const H = D.time.hoursPerSol;
    const before = { ...s.stocks };
    const daylight = this.daylight;
    const eff = this.efficiency();
    const striking = s.trust < D.trust.thresholds.strike;

    // Labour: humans work their share of the sol (halved on strike); machines are added once we know they have power.
    let labour = s.awake * (D.colonists.workHoursPerSol / H) * (striking ? 0.5 : 1);
    const buildMachines = s.building ? Math.min(builders ?? 2, s.machines) : 0;

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
    const crews: Record<string, number> = {};
    for (const b of s.buildings) {
      const d = D.buildings[b.type];
      if (!d.out || !b.enabled || !served.has(b.id)) continue;
      if (labour < (d.crew ?? 0)) continue;
      if (Object.keys(d.out).some((r) => s.stocks[r as Stock] >= 0.9 * this.cap(r as Stock))) continue;
      if (Object.entries(d.in ?? {}).some(([r, v]) => s.stocks[r as Stock] < v)) continue;
      labour -= d.crew ?? 0;
      crews[b.id] = d.crew ?? 0;
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
        s.buildings.push({ id: s.building.id, type: s.building.type, enabled: true, builtAt: s.hour });
        this.note(`${labelOf(s.building.type)} online`);
        this.completed.push(s.building.id);
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
    s.last = { supplyKw: r1(supply), demandKw: r1(demand), cut, served: [...served, ...producing.values()].map(String), daylight, labour: r1(labour), crews, builders: buildMachines };
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
        const producing = Boolean(d.out) && (s.last.crews[b.id] !== undefined);
        return {
          id: b.id, type: b.type, label: labelOf(b.type), dept: d.dept, enabled: b.enabled,
          powered: b.enabled && (!draws || served.has(b.id)), producing,
          crew: s.last.crews[b.id] ?? 0, crewNeeded: d.crew ?? 0, drawKw: d.drawKw ?? 0, in: d.in ?? {}, out: d.out ?? {}, permanent: Boolean(d.permanent), note: noteOf(b.type),
        };
      }),
      building: s.building ? { id: s.building.id, type: s.building.type, label: labelOf(s.building.type), hoursLeft: r1(s.building.hoursLeft), hours: this.defs.buildings[s.building.type].buildHours ?? 0, builders: s.last.builders } : null,
      catalog: Object.entries(this.defs.buildings)
        .filter(([, d]) => !d.permanent && d.cost)
        .map(([type, d]) => ({
          type, label: labelOf(type), dept: d.dept, cost: d.cost ?? {}, buildHours: d.buildHours ?? 0, drawKw: d.drawKw ?? 0,
          genKw: d.powerGenKwPeak ?? d.powerGenKw ?? 0, crew: d.crew ?? 0, in: d.in ?? {}, out: d.out ?? {},
          affordable: Object.entries(d.cost ?? {}).every(([r, v]) => s.stocks[r as Stock] >= v),
          blocked: this.blocked(type), note: noteOf(type),
        })),
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
    if (!(s && s.version === 1 && typeof s.hour === "number")) return null;
    if (s.building && !s.building.id) s.building = null; // saved before sites had map ids
    s.last.crews ??= {};
    s.last.builders ??= 0;
    return s;
  } catch {
    return null; // a damaged save starts a new colony
  }
}

export function saveColonyState(path: string, state: ColonyState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

// Drives a Colony in real time, publishes it through the World, saves it, and keeps the
// map (the layout) in step: construction sites are map buildings, two idle machines go and
// build, and finished buildings become homes for the characters that prefer them.
export class ColonyRunner {
  readonly colony: Colony;
  private world: World;
  private path: string | null;
  private timer: NodeJS.Timeout | null = null;
  private secondsPerHour: number;
  // Saves the layout and lets the source know (main.ts wires it to the base file and Hermes).
  onLayout: ((layout: BaseLayout) => Promise<void> | void) | null = null;

  constructor(colony: Colony, world: World, path: string | null, secondsPerHour = colony.defs.time.realSecondsPerHour) {
    this.colony = colony;
    this.world = world;
    this.path = path;
    this.secondsPerHour = secondsPerHour;
  }

  start(): void {
    this.syncWithLayout();
    this.publish();
    this.schedule();
  }

  // Called whenever the layout changed outside the economy (Build mode edits, resets).
  syncWithLayout(): void {
    const c = this.colony;
    const l = this.world.layout;
    c.setMachines(l.agents.filter((a) => a.skill !== "orchestrator").length);
    c.syncBuildings(l);
    // A site the map lost (reset, removal) is abandoned without refund; a site the map
    // still shows but the colony forgot is removed from the map.
    const site = c.state.building;
    if (!site && l.buildings.some((b) => b.status === "building")) {
      const next = cloneLayout(l);
      next.buildings = next.buildings.filter((b) => b.status !== "building");
      void this.adoptLayout(next);
    }
  }

  private async adoptLayout(next: BaseLayout): Promise<void> {
    this.world.applyLayout(next);
    try {
      await this.onLayout?.(next);
    } catch (e) {
      this.world.logLine(`Could not save the base: ${e}`, "error");
    }
  }

  // Builds a kind: pays, places the site on the map (next free slot of its department or
  // the given spot) and sends two idle machines to build it.
  build(type: string, x?: number, z?: number): void {
    const c = this.colony;
    const why = c.blocked(type);
    if (why) throw new ColonyError(why);
    const next = cloneLayout(this.world.layout);
    const input: Record<string, unknown> = { label: labelOf(type), kind: type, model: KIND_MODEL[type], capability: KIND_DEPT[type], status: "building" };
    if (x !== undefined && z !== undefined) Object.assign(input, { x, z });
    let def;
    try {
      def = upsertBuilding(next, input);
    } catch (e) {
      throw new ColonyError(e instanceof Error ? e.message : String(e));
    }
    c.build(type, def.id);
    void this.adoptLayout(next);
    c.state.last.builders = this.assignBuilders(); // so the panel shows who went, before the first tick
  }

  cancelBuild(): void {
    const site = this.colony.state.building;
    this.colony.cancelBuild();
    if (!site) return;
    const next = cloneLayout(this.world.layout);
    next.buildings = next.buildings.filter((b) => b.id !== site.id);
    this.releaseBuilders(site.id);
    void this.adoptLayout(next);
  }

  // A building removed in Build mode leaves the economy too.
  removed(id: string): void {
    this.colony.removeBuilding(id);
    this.publish();
    this.save();
  }

  canRemove(id: string): void {
    const b = this.colony.state.buildings.find((x) => x.id === id);
    if (b && this.colony.defs.buildings[b.type]?.permanent) throw new ColonyError(`${labelOf(b.type)} cannot be removed`);
  }

  // Reset base = a new colony.
  reset(): void {
    this.colony.state = Colony.initial(this.colony.defs);
    this.syncWithLayout();
    this.world.logLine("Sol 0: a new colony. Odyssey-7 is down; 24 colonists awake, 198 in cryo.", "warn");
    this.publish();
    this.save();
  }

  // Machines at the site this hour: idle ones are sent, ones a mission took are not chased.
  private assignBuilders(): number {
    const site = this.colony.state.building;
    if (!site) return 0;
    const there = this.world.layout.agents.filter((a) => {
      const st = this.world.getAgent(a.id);
      return st && st.state === "working" && st.location === site.id && st.detail === "construction";
    });
    let n = there.length;
    for (const a of this.world.layout.agents) {
      if (n >= 2) break;
      if (a.skill === "orchestrator" || there.some((t) => t.id === a.id)) continue;
      const st = this.world.getAgent(a.id);
      if (!st || st.state !== "idle") continue;
      this.world.setAgent(a.id, { state: "working", building: site.id, taskId: null, taskTitle: `Building the ${labelOf(site.type)}`, detail: "construction", progress: 0 });
      n++;
    }
    return n;
  }

  private releaseBuilders(siteId: string): void {
    for (const a of this.world.layout.agents) {
      const st = this.world.getAgent(a.id);
      if (st && st.detail === "construction" && st.location === siteId) this.world.setAgent(a.id, { state: "idle" });
    }
  }

  // After a tick: site progress on the map, finished buildings adopted, characters move in.
  private afterTick(): void {
    const c = this.colony;
    const site = c.state.building;
    let next: BaseLayout | null = null;
    if (site) {
      const b = this.world.layout.buildings.find((x) => x.id === site.id);
      const hours = c.defs.buildings[site.type].buildHours ?? 1;
      const progress = Math.max(0, Math.min(1, 1 - site.hoursLeft / hours));
      if (b && Math.round((b.progress ?? 0) * 100) !== Math.round(progress * 100)) {
        next = cloneLayout(this.world.layout);
        const nb = next.buildings.find((x) => x.id === site.id)!;
        nb.progress = progress;
      }
      for (const a of this.world.layout.agents) {
        const st = this.world.getAgent(a.id);
        if (st && st.detail === "construction" && st.location === site.id) this.world.setAgent(a.id, { state: "working", building: site.id, progress });
      }
    }
    for (const id of c.completed.splice(0)) {
      next ??= cloneLayout(this.world.layout);
      const b = next.buildings.find((x) => x.id === id);
      if (!b) continue;
      b.status = "built";
      delete b.progress;
      for (const a of next.agents) {
        if (a.prefers === b.kind && a.home === "landing_module") {
          a.home = id;
          this.world.logLine(`${a.name} moves into the ${b.label}`, "info");
        }
      }
      this.releaseBuilders(id);
    }
    if (next) void this.adoptLayout(next);
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
      this.step();
      this.schedule();
    }, (this.secondsPerHour * 1000) / speed);
    this.timer.unref?.();
  }

  // One game hour, driven by the clock (or by tests).
  step(): void {
    const builders = this.assignBuilders();
    this.colony.tick(builders);
    this.afterTick();
    this.publish();
    this.save();
  }

  // Runs a command against the colony, then publishes and saves. Errors are ColonyError.
  command(fn: (c: Colony, r: ColonyRunner) => void): void {
    fn(this.colony, this);
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
