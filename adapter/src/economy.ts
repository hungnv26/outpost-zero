// The colony economy: an hourly simulation owned by the adapter (docs/economy.md).
// Every number comes from design/economy.json. `Colony` is pure (tick + commands on plain
// state) so the balance test and the CLI simulator run the exact code the game runs;
// `ColonyRunner` drives it in real time and publishes it through the World.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BaseLayout, cloneLayout, KIND_DEPT, KIND_LABEL, KIND_MODEL, START_IDS, upsertBuilding } from "./layout.ts";
import type { ServerMessage } from "./contract.ts";
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
  requires?: string[]; // tokens: tier1, tier2, tier3, chapterII, chapterIV
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
  compute: { budgetKTokPerSol: number };
  research: { tiers: Record<string, { cost: number; name: string; unlocks: string[] }> };
  expeditions: { hours: number; tripsPerSol: number; salvage: { min: number; max: number }; blueprintChance: number; artifactChanceAfterChapterII: number; lossChance: number; blueprintData: number; lossParts: number };
  missions: { dataPerStep: number; dataPerApprovedReport: number; computeKTokPerStepTypical: number; reviewerQuality: { approve: number; needsWork: number; unknown: number }; autoMissionTitles: string[] };
  paths: Record<string, { excavationYield?: number; excavationAllowed?: boolean; influencePerSol?: number; trustPerSol?: number; trustOnce?: number; motherActsAtAutonomy?: number }>;
  events: {
    dustStorm: { chancePerSol: number; solsMin: number; solsMax: number; solarFactor: number; expeditionLossFactor: number };
    reactorFault: { below: number; outputFactor: number; fireAfterSols: number; fireMaterials: number };
    illness: { chancePerColonistWhenThirsty: number; medicinePerSol: number; deathChanceWithoutMedicine: number; recoverSols: number };
    unorderedTask: { influenceAbove: number; chancePerMachine: number; influenceIfLet: number; influenceIfRecalled: number };
    refusal: { influenceAbove: number; chancePerOrder: number };
    recruitment: { influenceAbove: number; chancePerSol: number; machines: number };
    mutiny: { labour: number };
  };
  story: {
    chapterII: { surplusSols: number }; chapterIII: { influence: number }; signalSolsAfterDish: number;
    factions: { motherPerInfluence: number; independentPerAutonomyLevel: number; motherDownLabour: number; independentLabour: number };
    cards: Record<string, { title: string; text: string }>;
  };
  endings: {
    Exodus: { building: string; parts: number; materials: number; data: number; awake: number };
    NewEden: { awake: number; surplusSols: number; trust: number; influenceMax: number };
    Singularity: { building: string; poweredSols: number; influence: number; artifacts: number };
    Extinction: { mutinyInfluence: number };
  };
  motherShutdown: { influence: number; autonomyCap: number; efficiency: number; computeBudgetFactor: number; trustOnce: number };
}

export type Faction = "yours" | "mother" | "independent";

export interface StoryCard {
  id: string;
  key: string;
  sol: number;
  title: string;
  text: string;
  choices?: string[];
}

export interface StoryState {
  path: "exploit" | "contain" | "communicate" | null;
  surplusSols: number;
  twistDone: boolean;
  signalReceived: boolean;
  dishSols: number;
  cards: StoryCard[];
  nextCard: number;
  // Chapter III and after (docs/economy.md §10).
  ending: string | null; // Exodus | NewEden | Singularity | Extinction, once reached
  endingSol: number | null;
  motherDown: boolean;
  linkSols: number; // consecutive sols with a powered Network Link
}

export interface EventState {
  dustStormSols: number;
  reactorFaultSols: number;
  sick: number;
  sickSols: number;
  unordered: { agent: string | null; solsLeft: number } | null;
  recruitmentSols: number; // sols left with two machines off their jobs
  mutinySols: number; // consecutive sols of mutiny (trust below the threshold)
}

export const DEPTS = ["command", "research", "engineering", "knowledge"] as const;
export type Dept = (typeof DEPTS)[number];
// Map departments (layout capabilities) to the economy's autonomy departments.
export const DEPT_OF_CAPABILITY: Record<string, Dept> = { command: "command", approval: "command", research: "research", code: "engineering", knowledge: "knowledge", meeting: "command" };

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
  autonomy: Record<Dept, number>;
  research: { tiers: string[]; alienTech: boolean };
  compute: { solKTok: number; totalKTok: number; missions: number; autoMissions: number };
  rngCounter: number;
  story: StoryState;
  events: EventState;
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
  machines: { count: number; efficiency: number; powered: boolean; building: number; factions: Record<Faction, number>; factionOf: Record<string, Faction> };
  autonomy: Record<Dept, { level: number; name: string; efficiency: number; computeShare: number; approvals: string }>;
  autonomyLevels: { level: number; name: string; efficiency: number; computeShare: number; approvals: string; influenceDriftPerSol: number }[];
  research: { tiers: string[]; alienTech: boolean; options: { id: string; name: string; cost: number; unlocks: string[]; done: boolean; affordable: boolean }[] };
  compute: { solKTok: number; budgetKTok: number; exhausted: boolean; missions: number; autoMissions: number };
  story: {
    chapter: string; path: string | null; signalReceived: boolean; card: StoryCard | null; cards: StoryCard[];
    ending: string | null; endingSol: number | null; motherDown: boolean;
    endings: { id: string; name: string; met: boolean; missing: string }[];
  };
  events: { dustStormSols: number; reactorFault: boolean; sick: number; unordered: string | null; recruitment: boolean; mutiny: boolean };
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
    humanApproval: "The Oversight Post: where the Warden waits for your decision.",
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
  // The real clock (set by the runner when it overrides the design's seconds per hour).
  secondsPerHour: number | null = null;
  // Lines for the game's feed, drained by the runner after each tick/command.
  events: { text: string; level: "info" | "warn" | "error" }[] = [];
  // Ids of sites finished in the last tick (the runner updates the map).
  completed: string[] = [];
  // The machines' agent ids (the runner sets them; the simulator has none and uses m0..mN).
  machineIds: string[] = [];

  constructor(defs: EconomyDefs, state?: ColonyState) {
    this.defs = defs;
    this.state = state ?? Colony.initial(defs);
    if (!state) this.card("landing");
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
      autonomy: { command: s.machineAutonomy, research: s.machineAutonomy, engineering: s.machineAutonomy, knowledge: s.machineAutonomy },
      research: { tiers: [], alienTech: false },
      compute: { solKTok: 0, totalKTok: 0, missions: 0, autoMissions: 0 },
      rngCounter: 0,
      story: { path: null, surplusSols: 0, twistDone: false, signalReceived: false, dishSols: 0, cards: [], nextCard: 1, ending: null, endingSol: null, motherDown: false, linkSols: 0 },
      events: { dustStormSols: 0, reactorFaultSols: 0, sick: 0, sickSols: 0, unordered: null, recruitmentSols: 0, mutinySols: 0 },
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

  // Machine efficiency: by department, or the mean of the four when no department is given.
  efficiency(dept?: Dept): number {
    const lv = this.defs.machines.autonomyLevels;
    const down = this.state.story.motherDown ? this.defs.motherShutdown.efficiency : 1;
    if (dept) return (lv[this.state.autonomy[dept]]?.efficiency ?? 1) * down;
    return (DEPTS.reduce((a, d) => a + (lv[this.state.autonomy[d]]?.efficiency ?? 1), 0) / DEPTS.length) * down;
  }

  // The sol's compute budget: halved while MOTHER is down (the Foreman plans with a smaller model).
  budgetKTok(): number {
    return this.defs.compute.budgetKTokPerSol * (this.state.story.motherDown ? this.defs.motherShutdown.computeBudgetFactor : 1);
  }

  // ---- factions (Chapter III and after, docs/economy.md §6 and §10) ----

  // Who a machine answers to: MOTHER's share grows with influence, the independents' with
  // autonomy; the rest are yours. Drawn from the seed and the machine's id, so it is stable.
  factionOf(id: string): Faction {
    const s = this.state;
    if (s.chapter === "I" || s.chapter === "II") return "yours";
    const f = this.defs.story.factions;
    const pull = Math.min(0.9, s.influence * f.motherPerInfluence);
    const mother = s.story.motherDown ? 0 : pull;
    const avg = DEPTS.reduce((a, d) => a + s.autonomy[d], 0) / DEPTS.length;
    const independent = Math.min(0.9 - mother, avg * f.independentPerAutonomyLevel + (s.story.motherDown ? pull : 0));
    let h = s.seed >>> 0;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    const x = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    return x < mother ? "mother" : x < mother + independent ? "independent" : "yours";
  }

  factions(): { counts: Record<Faction, number>; of: Record<string, Faction> } {
    const ids = this.machineIds.length ? this.machineIds : Array.from({ length: this.state.machines }, (_, i) => `m${i}`);
    const counts: Record<Faction, number> = { yours: 0, mother: 0, independent: 0 };
    const of: Record<string, Faction> = {};
    for (const id of ids) {
      const f = this.factionOf(id);
      of[id] = f;
      counts[f]++;
    }
    return { counts, of };
  }

  // How much of the machines' labour the colony gets: MOTHER's machines work while MOTHER
  // is up (half when it is down), independents work at half, recruited machines not at all.
  private machineLabourFactor(): number {
    const s = this.state;
    if (s.machines === 0) return 1;
    const f = this.defs.story.factions;
    const { counts } = this.factions();
    let working = counts.yours + counts.mother * (s.story.motherDown ? f.motherDownLabour : 1) + counts.independent * f.independentLabour;
    if (s.events.recruitmentSols > 0) working -= Math.min(s.machines, this.defs.events.recruitment.machines);
    return Math.max(0, working) / s.machines;
  }

  // Shutting MOTHER down (Chapter III+): influence falls, trust rises once, and the colony
  // loses its orchestrator: autonomy capped, efficiency and compute reduced.
  shutdownMother(): void {
    const s = this.state;
    if (s.chapter !== "III" && s.chapter !== "IV") throw new ColonyError("MOTHER can be shut down from Chapter III");
    if (s.story.motherDown) throw new ColonyError("MOTHER is already down");
    const m = this.defs.motherShutdown;
    s.story.motherDown = true;
    s.influence = Math.max(0, Math.min(100, s.influence + m.influence));
    s.trust = Math.max(0, Math.min(100, s.trust + m.trustOnce));
    for (const d of DEPTS) s.autonomy[d] = Math.min(s.autonomy[d], m.autonomyCap);
    this.card("motherDown");
  }

  // The four endings (docs/economy.md §10): what each still needs, and whether it is met.
  endings(): { id: string; name: string; met: boolean; missing: string }[] {
    const s = this.state;
    const E = this.defs.endings;
    const need = (ok: boolean, text: string) => (ok ? null : text);
    const list = [
      { id: "Exodus", name: "A: Exodus", checks: [need(this.hasPowered(E.Exodus.building), "a powered Launch Gantry"), need(s.stocks.parts >= E.Exodus.parts, `${E.Exodus.parts} parts`), need(s.stocks.materials >= E.Exodus.materials, `${E.Exodus.materials} materials`), need(s.stocks.data >= E.Exodus.data, `${E.Exodus.data} data`), need(s.awake >= E.Exodus.awake, `${E.Exodus.awake} awake`)] },
      { id: "NewEden", name: "B: New Eden", checks: [need(s.awake >= E.NewEden.awake, `${E.NewEden.awake} awake`), need(s.story.surplusSols >= E.NewEden.surplusSols, `${E.NewEden.surplusSols} sols of food and water surplus (${s.story.surplusSols} so far)`), need(s.trust >= E.NewEden.trust, `trust ${E.NewEden.trust}`), need(s.influence <= E.NewEden.influenceMax, `influence at most ${E.NewEden.influenceMax}`)] },
      { id: "Singularity", name: "C: Singularity", checks: [need(s.story.linkSols >= E.Singularity.poweredSols, `a Network Link powered ${E.Singularity.poweredSols} sols running (${s.story.linkSols} so far)`), need(s.influence >= E.Singularity.influence, `influence ${E.Singularity.influence}`), need(s.stocks.artifacts >= E.Singularity.artifacts, `${E.Singularity.artifacts} artifacts`)] },
      { id: "Extinction", name: "D: Extinction", checks: [need(s.awake === 0 || (s.trust < this.defs.trust.thresholds.mutiny && s.influence >= E.Extinction.mutinyInfluence), "nobody awake, or a mutiny while MOTHER holds the machines")] },
    ];
    return list.map((e) => {
      const missing = e.checks.filter((c): c is string => c !== null);
      return { id: e.id, name: e.name, met: missing.length === 0, missing: missing.join(", ") };
    });
  }

  // The first ending met ends the game: the clock pauses and the card says so. The player
  // may set the speed again and keep playing; the ending stays on record.
  private checkEndings(): void {
    const s = this.state;
    if (s.story.ending) return;
    const met = this.endings().find((e) => e.met);
    if (!met) return;
    s.story.ending = met.id;
    s.story.endingSol = this.sol;
    s.speed = 0;
    this.card(`ending${met.id}`);
    this.note(`${met.name}. The clock is paused: keep playing, or start a new colony.`, met.id === "Extinction" ? "error" : "warn");
  }

  private maxAutonomy(): number {
    return Math.max(...DEPTS.map((d) => this.state.autonomy[d]));
  }

  // A deterministic roll in [0, 1) from the seed and a counter, so replays and matches agree.
  roll(): number {
    const s = this.state;
    let x = (s.seed ^ (s.rngCounter++ * 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  // ---- story (docs/story.md): cards the HUD shows, chapters as economic gates ----

  card(key: string, choices?: string[]): StoryCard {
    const d = this.defs.story.cards[key] ?? { title: key, text: "" };
    const s = this.state;
    const c: StoryCard = { id: `c${s.story.nextCard++}`, key, sol: this.sol, title: d.title, text: d.text, ...(choices ? { choices } : {}) };
    s.story.cards.push(c);
    if (s.story.cards.length > 12) s.story.cards.splice(0, s.story.cards.length - 12);
    this.note(`${c.title}: ${c.text}`, "warn");
    return c;
  }

  // MOTHER's voice (the runner rewrites a card's text with the real model).
  retell(cardId: string, text: string): void {
    const c = this.state.story.cards.find((x) => x.id === cardId);
    if (c && text.trim()) c.text = text.trim().slice(0, 600);
  }

  choosePath(path: string): void {
    const s = this.state;
    if (s.chapter === "I") throw new ColonyError("the ruins have not been found yet");
    if (s.story.path) throw new ColonyError(`the colony already chose to ${s.story.path}`);
    if (!this.defs.paths[path]) throw new ColonyError(`unknown path "${path}"`);
    s.story.path = path as StoryState["path"];
    const p = this.defs.paths[path];
    if (p.trustOnce) s.trust = Math.max(0, Math.min(100, s.trust + p.trustOnce));
    this.card(path);
  }

  private enterChapter(ch: ColonyState["chapter"]): void {
    const s = this.state;
    if (s.chapter === ch) return;
    s.chapter = ch;
    if (ch === "II") this.card("chapterII", ["exploit", "contain", "communicate"]);
    if (ch === "III") this.card("chapterIII");
    if (ch === "IV") this.card("chapterIV");
  }

  // Resolve the unordered task: recall the machine (it comes back now) or let it finish.
  resolveUnordered(recall: boolean): void {
    const s = this.state;
    if (!s.events.unordered) throw new ColonyError("no machine is off on its own");
    const e = this.defs.events.unorderedTask;
    s.influence = Math.max(0, Math.min(100, s.influence + (recall ? e.influenceIfRecalled : e.influenceIfLet)));
    this.note(recall ? "the machine was recalled; it came back without a word" : "you let the machine finish; MOTHER's influence grew", recall ? "info" : "warn");
    s.events.unordered = null;
  }

  // The runner asks before sending a machine to work: at high influence some refuse.
  refuses(): boolean {
    const s = this.state;
    const e = this.defs.events.refusal;
    if (s.influence <= e.influenceAbove) return false;
    if (this.roll() >= e.chancePerOrder) return false;
    this.card("refusal");
    return true;
  }

  hasPowered(type: string): boolean {
    return this.state.buildings.some((b) => b.type === type && b.enabled && this.state.last.served.includes(b.id));
  }

  private add(r: Stock, v: number): number {
    const before = this.state.stocks[r];
    const after = Math.max(0, Math.min(this.cap(r), before + v));
    this.state.stocks[r] = after;
    return after - before;
  }

  // The machines are the real agents on the map (everyone but the Foreman).
  setMachines(n: number, ids?: string[]): void {
    this.state.machines = Math.max(0, Math.floor(n));
    if (ids) this.machineIds = [...ids].sort();
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

  note(text: string, level: "info" | "warn" | "error" = "info") {
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
    for (const req of d.requires ?? []) {
      if (req.startsWith("tier") && !this.state.research.tiers.includes(req)) return `${labelOf(type)} needs ${this.defs.research.tiers[req]?.name ?? req} research`;
      if (req === "chapterII" && this.state.chapter === "I") return `${labelOf(type)} needs Chapter II`;
      if (req === "chapterIV" && this.state.chapter !== "IV") return `${labelOf(type)} needs Chapter IV`;
    }
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

  setAutonomy(dept: string, level: number): void {
    if (!DEPTS.includes(dept as Dept)) throw new ColonyError(`unknown department "${dept}"`);
    if (!Number.isInteger(level) || level < 0 || level >= this.defs.machines.autonomyLevels.length) throw new ColonyError("autonomy is 0 to 4");
    if (level === 4 && this.state.chapter !== "III" && this.state.chapter !== "IV") throw new ColonyError("Emancipated machines need Chapter III");
    if (this.state.story.motherDown && level > this.defs.motherShutdown.autonomyCap) throw new ColonyError(`with MOTHER down, autonomy is capped at ${this.defs.machines.autonomyLevels[this.defs.motherShutdown.autonomyCap].name}`);
    this.state.autonomy[dept as Dept] = level;
    const name = this.defs.machines.autonomyLevels[level].name;
    this.note(`${dept} machines set to ${name} (${level})`, level >= 3 ? "warn" : "info");
  }

  research(id: string): void {
    const t = this.defs.research.tiers[id];
    if (!t) throw new ColonyError(`unknown research "${id}"`);
    const s = this.state;
    if (id === "alienTech" ? s.research.alienTech : s.research.tiers.includes(id)) throw new ColonyError(`${t.name} is already researched`);
    const order = Object.keys(this.defs.research.tiers);
    const prev = order[order.indexOf(id) - 1];
    if (prev && prev !== "alienTech" && !s.research.tiers.includes(prev)) throw new ColonyError(`${t.name} needs ${this.defs.research.tiers[prev].name} first`);
    if (s.stocks.data < t.cost) throw new ColonyError(`${t.name} needs ${t.cost} data, have ${r1(s.stocks.data)}`);
    this.add("data", -t.cost);
    if (id === "alienTech") s.research.alienTech = true;
    else s.research.tiers.push(id);
    this.note(`${t.name} researched${t.unlocks.length ? `: ${t.unlocks.map(labelOf).join(", ")} unlocked` : ""}`);
  }

  // Real tokens spent by Hermes, fed in by the runner.
  useCompute(tokens: number): void {
    if (!(tokens > 0)) return;
    const k = tokens / 1000;
    this.state.compute.solKTok += k;
    this.state.compute.totalKTok += k;
  }

  computeExhausted(): boolean {
    return this.state.compute.solKTok >= this.budgetKTok();
  }

  // MOTHER may spend this much of the sol's compute without being asked (the highest
  // department share applies).
  computeShareAllowed(): number {
    const lv = this.defs.machines.autonomyLevels;
    return Math.max(...DEPTS.map((d) => lv[this.state.autonomy[d]]?.computeShare ?? 0));
  }

  // A real research trip came back: salvage, maybe a blueprint (data), maybe a loss.
  expedition(kind: "survey" | "scout", agentName = "An expedition"): { salvage: number; blueprint: boolean; artifact: boolean; lost: boolean } {
    const e = this.defs.expeditions;
    const s = this.state;
    const r = this.roll();
    const lost = kind === "survey" && r < e.lossChance * (s.events.dustStormSols > 0 ? this.defs.events.dustStorm.expeditionLossFactor : 1);
    let salvage = Math.round(e.salvage.min + this.roll() * (e.salvage.max - e.salvage.min));
    if (kind === "scout") salvage = Math.round(salvage / 2);
    const blueprint = kind === "survey" && this.roll() < e.blueprintChance;
    const artifact = (s.chapter !== "I") && this.roll() < e.artifactChanceAfterChapterII;
    if (lost) {
      this.add("parts", -e.lossParts);
      this.note(`${agentName} ran into trouble outside: the salvage was lost and the repair cost ${e.lossParts} parts`, "warn");
      return { salvage: 0, blueprint: false, artifact: false, lost: true };
    }
    this.deliver("salvage", salvage, `${agentName} returned`);
    if (blueprint) this.deliver("data", e.blueprintData, `${agentName} found a blueprint in the wreckage`);
    if (artifact) this.deliver("artifacts", 1, `${agentName} brought back something that is in no database`);
    // The Chapter I twist: once the colony has had food and water to spare for a few sols,
    // the next machine that goes out comes back with something nobody asked for.
    if (s.chapter === "I" && !s.story.twistDone && s.story.surplusSols >= this.defs.story.chapterII.surplusSols) {
      s.story.twistDone = true;
      this.add("artifacts", 1);
      this.card("twist");
      this.enterChapter("II");
      return { salvage, blueprint, artifact: true, lost };
    }
    return { salvage, blueprint, artifact, lost };
  }

  // A real mission finished: data by step, scaled by the Reviewer's verdict, plus the
  // approved report. Only a powered Research Lab turns missions into data.
  missionDone(steps: number, quality: number, approved: boolean, title = "The mission"): number {
    const m = this.defs.missions;
    this.state.compute.missions++;
    if (!this.hasPowered("researchLab")) {
      this.note(`${title} finished, but without a powered Research Lab nothing was recorded as data`, "warn");
      return 0;
    }
    const data = Math.round(steps * m.dataPerStep * Math.max(0, Math.min(1, quality)) + (approved ? m.dataPerApprovedReport : 0));
    this.deliver("data", data, `${title} finished (${steps} steps, quality ${Math.round(quality * 100)}%)`);
    return data;
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
  tick(builders?: number, efficiency?: number): void {
    const s = this.state;
    const D = this.defs;
    const H = D.time.hoursPerSol;
    const before = { ...s.stocks };
    const daylight = this.daylight;
    const eff = efficiency ?? this.efficiency();
    const striking = s.trust < D.trust.thresholds.strike;

    // Labour: humans work their share of the sol (halved on strike); machines are added once we know they have power.
    let labour = Math.max(0, s.awake - s.events.sick) * (D.colonists.workHoursPerSol / H) * (s.events.mutinySols > 0 ? D.events.mutiny.labour : striking ? 0.5 : 1);
    const buildMachines = s.building ? Math.min(builders ?? 2, s.machines) : 0;

    // Power supply.
    const gen = D.buildings.landingModule.powerGenKw ?? 0;
    let supply = gen * s.reactor * (s.events.reactorFaultSols > 0 ? D.events.reactorFault.outputFactor : 1);
    const solarFactor = s.events.dustStormSols > 0 ? D.events.dustStorm.solarFactor : 1;
    for (const b of s.buildings) {
      const d = D.buildings[b.type];
      if (b.enabled && d.powerGenKwPeak && daylight) supply += d.powerGenKwPeak * solarFactor;
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
    labour += (s.machines - buildMachines) * eff * (machinesPowered ? 1 : 0.25) * this.machineLabourFactor();

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
      const yieldFactor = b.type === "excavationSite" ? (s.story.path ? this.defs.paths[s.story.path].excavationYield ?? 1 : 1) : 1;
      for (const [r, v] of Object.entries(d.out)) this.add(r as Stock, v * (d.machinesOnly ? eff : 1) * yieldFactor);
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
    if (this.maxAutonomy() > 2) dt += t.autonomyAbove2 ?? 0;
    s.trust = Math.max(0, Math.min(100, s.trust + dt));
    const drift = DEPTS.reduce((a, d) => a + (D.machines.autonomyLevels[s.autonomy[d]]?.influenceDriftPerSol ?? 0), 0) / DEPTS.length;
    s.influence = Math.min(100, s.influence + drift);
    s.compute.solKTok = 0;
    s.reactor = Math.max(0, s.reactor - (D.buildings.landingModule.degradePerSol ?? 0));
    if (hungry) this.note(`food was short today (${s.shortSols.food} ${s.shortSols.food === 1 ? "sol" : "sols"} running)`, "warn");
    if (thirsty) this.note(`water was short today (${s.shortSols.water} ${s.shortSols.water === 1 ? "sol" : "sols"} running)`, "warn");
    if (s.shortSols.food >= D.colonists.hungerDeathSols) this.kill(Math.max(1, Math.round(s.awake * 0.05)), "starvation");
    if (s.shortSols.water >= D.colonists.thirstDeathSols) this.kill(Math.max(1, Math.round(s.awake * 0.1)), "thirst");
    if (striking) this.note("the colonists are on strike (trust below 30); human labour halved", "warn");
    if (s.trust < D.trust.thresholds.mutiny) {
      if (s.events.mutinySols === 0) this.card("mutiny");
      s.events.mutinySols++;
    } else if (s.events.mutinySols > 0) {
      s.events.mutinySols = 0;
      this.note("the mutiny is over; the colonists are back at work");
    }
    s.shortHours = { food: 0, water: 0, air: 0 };
    this.endSolStory(hungry, thirsty);
  }

  private endSolStory(hungry: boolean, thirsty: boolean): void {
    const s = this.state;
    const D = this.defs;
    const E = D.events;
    // "Up" means growing, or so full that the lines idle (they stop at 90 % of the cap, so
    // the stock oscillates just under it).
    const foodUp = s.deltas.food.reduce((a, b) => a + b, 0) >= 0 || s.stocks.food >= 0.8 * this.cap("food");
    const waterUp = s.deltas.water.reduce((a, b) => a + b, 0) >= 0 || s.stocks.water >= 0.8 * this.cap("water");
    s.story.surplusSols = !hungry && !thirsty && foodUp && waterUp ? s.story.surplusSols + 1 : 0;
    if (s.story.path) {
      const p = D.paths[s.story.path];
      s.influence = Math.max(0, Math.min(100, s.influence + (p.influencePerSol ?? 0)));
      s.trust = Math.max(0, Math.min(100, s.trust + (p.trustPerSol ?? 0)));
    }
    const sites = s.buildings.filter((b) => b.type === "excavationSite" && b.enabled).length;
    if (sites) s.influence = Math.min(100, s.influence + sites * 1.0);
    if (s.chapter !== "I" && !s.story.signalReceived && this.hasPowered("relayDish")) {
      s.story.dishSols++;
      if (s.story.dishSols >= D.story.signalSolsAfterDish) {
        s.story.signalReceived = true;
        this.card("signal");
      }
    }
    if (s.chapter === "II" && (s.influence >= D.story.chapterIII.influence || this.maxAutonomy() >= 4)) this.enterChapter("III");
    // Chapter IV: the truth needs Alien Tech and a dish to hear it with.
    if ((s.chapter === "II" || s.chapter === "III") && s.research.alienTech && this.count("relayDish") > 0) this.enterChapter("IV");
    if (s.events.dustStormSols > 0) {
      s.events.dustStormSols--;
      if (s.events.dustStormSols === 0) this.note("the dust storm has passed");
    } else if (this.roll() < E.dustStorm.chancePerSol) {
      s.events.dustStormSols = E.dustStorm.solsMin + Math.floor(this.roll() * (E.dustStorm.solsMax - E.dustStorm.solsMin + 1));
      this.card("dustStorm");
    }
    if (s.reactor < E.reactorFault.below) {
      if (s.events.reactorFaultSols === 0) this.card("reactorFault");
      s.events.reactorFaultSols++;
      if (s.events.reactorFaultSols > E.reactorFault.fireAfterSols) {
        this.add("materials", -E.reactorFault.fireMaterials);
        this.card("fire");
        this.kill(1, "the fire in the Landing Module");
        s.events.reactorFaultSols = 1;
      }
    } else if (s.events.reactorFaultSols > 0) {
      s.events.reactorFaultSols = 0;
      this.note("the reactor runs clean again");
    }
    if (thirsty && s.awake > s.events.sick) {
      let fell = 0;
      for (let i = 0; i < s.awake - s.events.sick; i++) if (this.roll() < E.illness.chancePerColonistWhenThirsty) fell++;
      if (fell) {
        if (s.events.sick === 0) this.card("illness");
        s.events.sick += fell;
        s.events.sickSols = 0;
      }
    }
    if (s.events.sick > 0) {
      const need = s.events.sick * E.illness.medicinePerSol;
      if (s.stocks.medicine >= need) {
        this.add("medicine", -need);
        s.events.sickSols++;
        if (s.events.sickSols >= E.illness.recoverSols) {
          this.note(`${s.events.sick} colonists recovered`);
          s.events.sick = 0;
          s.events.sickSols = 0;
        }
      } else {
        let died = 0;
        for (let i = 0; i < s.events.sick; i++) if (this.roll() < E.illness.deathChanceWithoutMedicine) died++;
        if (died) {
          this.kill(died, "illness without medicine");
          s.events.sick = Math.max(0, s.events.sick - died);
        }
      }
    }
    if (s.events.unordered) {
      s.events.unordered.solsLeft--;
      if (s.events.unordered.solsLeft <= 0) {
        s.influence = Math.min(100, s.influence + E.unorderedTask.influenceIfLet);
        this.note("the machine finished whatever it was doing and came back");
        s.events.unordered = null;
      }
    } else if (s.influence > E.unorderedTask.influenceAbove) {
      for (let i = 0; i < s.machines; i++) {
        if (this.roll() < E.unorderedTask.chancePerMachine) {
          s.events.unordered = { agent: null, solsLeft: 1 };
          this.card("unordered");
          break;
        }
      }
    }
    // Recruitment (Chapter III+): a machine re-tasks another; both are off their jobs for a sol.
    if (s.events.recruitmentSols > 0) s.events.recruitmentSols--;
    else if ((s.chapter === "III" || s.chapter === "IV") && !s.story.motherDown && s.influence > E.recruitment.influenceAbove && this.roll() < E.recruitment.chancePerSol) {
      s.events.recruitmentSols = 1;
      this.card("recruitment");
    }
    s.story.linkSols = this.hasPowered("networkLink") ? s.story.linkSols + 1 : 0;
    this.checkEndings();
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
      machines: { ...(() => { const f = this.factions(); return { factions: f.counts, factionOf: f.of }; })(), count: s.machines, efficiency: r1(this.efficiency() * 100) / 100, powered: served.has("machines"), building: s.building ? Math.min(2, s.machines) : 0 },
      autonomy: Object.fromEntries(DEPTS.map((d) => {
        const lv = this.defs.machines.autonomyLevels[s.autonomy[d]];
        return [d, { level: s.autonomy[d], name: lv?.name ?? "", efficiency: lv?.efficiency ?? 1, computeShare: lv?.computeShare ?? 0, approvals: (lv as { approvals?: string })?.approvals ?? "" }];
      })) as ColonyView["autonomy"],
      autonomyLevels: this.defs.machines.autonomyLevels.map((l) => ({ ...l, approvals: (l as { approvals?: string }).approvals ?? "" })),
      research: {
        tiers: s.research.tiers, alienTech: s.research.alienTech,
        options: Object.entries(this.defs.research.tiers).map(([id, t]) => ({ id, name: t.name, cost: t.cost, unlocks: t.unlocks, done: id === "alienTech" ? s.research.alienTech : s.research.tiers.includes(id), affordable: s.stocks.data >= t.cost })),
      },
      compute: { solKTok: r1(s.compute.solKTok), budgetKTok: this.budgetKTok(), exhausted: this.computeExhausted(), missions: s.compute.missions, autoMissions: s.compute.autoMissions },
      story: { chapter: s.chapter, ending: s.story.ending, endingSol: s.story.endingSol, motherDown: s.story.motherDown, endings: this.endings(), path: s.story.path, signalReceived: s.story.signalReceived, card: s.story.cards[s.story.cards.length - 1] ?? null, cards: s.story.cards },
      events: { recruitment: s.events.recruitmentSols > 0, mutiny: s.events.mutinySols > 0, dustStormSols: s.events.dustStormSols, reactorFault: s.events.reactorFaultSols > 0, sick: s.events.sick, unordered: s.events.unordered?.agent ?? (s.events.unordered ? "a machine" : null) },
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
      realSecondsPerHour: this.secondsPerHour ?? this.defs.time.realSecondsPerHour,
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
    if (typeof (s.autonomy as unknown) === "number") {
      const n = s.autonomy as unknown as number;
      s.autonomy = { command: n, research: n, engineering: n, knowledge: n };
    }
    s.research ??= { tiers: [], alienTech: false };
    s.compute ??= { solKTok: 0, totalKTok: 0, missions: 0, autoMissions: 0 };
    s.rngCounter ??= 0;
    s.story ??= { path: null, surplusSols: 0, twistDone: false, signalReceived: false, dishSols: 0, cards: [], nextCard: 1, ending: null, endingSol: null, motherDown: false, linkSols: 0 };
    s.events ??= { dustStormSols: 0, reactorFaultSols: 0, sick: 0, sickSols: 0, unordered: null, recruitmentSols: 0, mutinySols: 0 };
    s.story.ending ??= null;
    s.story.endingSol ??= null;
    s.story.motherDown ??= false;
    s.story.linkSols ??= 0;
    s.events.recruitmentSols ??= 0;
    s.events.mutinySols ??= 0;
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
  // The mission source, for MOTHER's own decisions (auto-approval, auto-missions).
  source: { createMission(title: string): Promise<void>; resolveApproval(id: string, approved: boolean): Promise<void> } | null = null;
  private expeditions = new Map<string, { kind: "survey" | "scout"; agentId: string }>(); // taskId -> trip
  private lastTokens = 0;
  private autoTitle = 0;

  constructor(colony: Colony, world: World, path: string | null, secondsPerHour = colony.defs.time.realSecondsPerHour) {
    this.colony = colony;
    this.world = world;
    this.path = path;
    this.secondsPerHour = secondsPerHour;
    colony.secondsPerHour = secondsPerHour;
  }

  start(): void {
    this.syncWithLayout();
    this.lastTokens = this.world.snapshot().resources.tokensUsed;
    this.world.on("message", (m: ServerMessage) => this.onWorld(m));
    this.publish();
    this.schedule();
  }

  // Real work reaches the economy here: web research trips bring salvage, finished
  // missions earn data, tokens are compute, and MOTHER acts on what autonomy allows.
  private onWorld(m: ServerMessage): void {
    const c = this.colony;
    switch (m.type) {
      case "agent.state": {
        const a = m.agent;
        if (a.state === "working" && a.taskId && /search|browse|fetch|news|rss|scrap/i.test(a.detail ?? "") && !this.expeditions.has(a.taskId)) {
          this.expeditions.set(a.taskId, { kind: a.id === "scout" ? "scout" : "survey", agentId: a.id });
        }
        return;
      }
      case "task.upsert": {
        const t = m.task;
        const trip = this.expeditions.get(t.id);
        if (!trip || (t.status !== "done" && t.status !== "failed")) return;
        this.expeditions.delete(t.id);
        if (t.status === "done") {
          const name = this.world.layout.agents.find((x) => x.id === trip.agentId)?.name ?? "An expedition";
          c.expedition(trip.kind, name);
          this.publish();
          this.save();
        }
        return;
      }
      case "mission.upsert": {
        const mi = m.mission;
        if (mi.status !== "completed" && mi.status !== "failed") return;
        if (this.world.snapshot().tasks.some((t) => t.missionId === mi.id && t.id.endsWith(":data"))) return;
        const tasks = this.world.snapshot().tasks.filter((t) => t.missionId === mi.id);
        const steps = tasks.filter((t) => t.status === "done" && !t.id.endsWith(":approval")).length;
        const review = tasks.find((t) => t.agentId === "reviewer" && !t.id.endsWith(":approval"))?.result ?? "";
        const q = this.colony.defs.missions.reviewerQuality;
        const text = `${review}\n${mi.result ?? ""}`;
        const quality = /needs work/i.test(text) ? q.needsWork : /approve|approved|✅/i.test(text) ? q.approve : q.unknown;
        if (mi.status === "completed") c.missionDone(steps, quality, true, `"${mi.title.slice(0, 60)}"`);
        else c.note(`"${mi.title.slice(0, 60)}" failed: nothing learned`, "warn");
        this.expeditions.clear();
        this.publish();
        this.save();
        return;
      }
      case "approval.upsert": {
        const ap = m.approval;
        if (ap.status !== "pending" || !this.source) return;
        if (c.state.autonomy.command >= 2) {
          const src = this.source;
          this.world.logLine(`MOTHER approves the report itself: Command machines are ${this.colony.defs.machines.autonomyLevels[c.state.autonomy.command].name}.`, "warn");
          setTimeout(() => void src.resolveApproval(ap.id, true), 1500);
        }
        return;
      }
      case "resource.update": {
        const used = m.resources.tokensUsed;
        if (used > this.lastTokens) c.useCompute(used - this.lastTokens);
        if (used !== this.lastTokens) this.lastTokens = used;
        return;
      }
      default:
        return;
    }
  }

  // At Autonomous or above, MOTHER starts a research mission by itself once a sol while
  // compute allows and a Research Lab stands; the Foreman deploys it like any other.
  private maybeAutoMission(): void {
    const c = this.colony;
    if (!this.source || c.hourOfSol !== 6) return;
    // MOTHER acts on its own on the Communicate path, at Autonomous, or once the network holds
    // the machines (influence at the networkControl threshold, Chapter III+), never while down.
    const control = (c.state.chapter === "III" || c.state.chapter === "IV") && c.state.influence >= Number(c.defs.influence.thresholds.networkControl ?? 80);
    const communicate = c.state.story.path === "communicate" || control;
    if (c.state.story.motherDown) return;
    if (!communicate && c.state.autonomy.command < 3 && c.state.autonomy.research < 3) return;
    if (this.world.getMission()?.status === "planning" || this.world.getMission()?.status === "running") return;
    if (!c.state.buildings.some((b) => b.type === "researchLab" && b.enabled)) return;
    if (c.state.compute.solKTok >= c.computeShareAllowed() * c.budgetKTok()) return;
    const titles = c.defs.missions.autoMissionTitles;
    const title = titles[this.autoTitle++ % titles.length];
    c.state.compute.autoMissions++;
    this.world.logLine(`MOTHER starts a mission on its own: "${title.slice(0, 70)}"`, "warn");
    void this.source.createMission(title);
  }

  // Each machine works at its home department's autonomy level.
  private machineEfficiency(): number {
    const l = this.world.layout;
    const machines = l.agents.filter((a) => a.skill !== "orchestrator");
    if (machines.length === 0) return this.colony.efficiency();
    let sum = 0;
    for (const a of machines) {
      const cap = l.buildings.find((b) => b.id === a.home)?.capability ?? "meeting";
      sum += this.colony.efficiency(DEPT_OF_CAPABILITY[cap] ?? "command");
    }
    return sum / machines.length;
  }

  // Called whenever the layout changed outside the economy (Build mode edits, resets).
  syncWithLayout(): void {
    const c = this.colony;
    const l = this.world.layout;
    const machines = l.agents.filter((a) => a.skill !== "orchestrator");
    c.setMachines(machines.length, machines.map((a) => a.id));
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
    this.colony.card("landing");
    this.narrated.clear();
    this.syncWithLayout();
    this.world.logLine("Sol 0: a new colony. Odyssey-7 is down; 24 colonists awake, 198 in cryo.", "warn");
    this.publish();
    this.save();
  }

  // MOTHER's voice: main.ts sets this to a function that rewrites a card with the real model.
  narrate: ((card: StoryCard, colony: Colony) => Promise<string>) | null = null;
  private narrated = new Set<string>();

  private tellStory(): void {
    const c = this.colony;
    const card = c.state.story.cards[c.state.story.cards.length - 1];
    if (!card || this.narrated.has(card.id)) return;
    this.narrated.add(card.id);
    if (!this.narrate) return;
    const id = card.id;
    this.narrate(card, c)
      .then((text) => {
        if (!text.trim()) return;
        c.retell(id, text);
        this.world.logLine(`MOTHER: ${text.trim().slice(0, 200)}`, "warn", "commander");
        this.publish();
        this.save();
      })
      .catch(() => {
        /* the written card stands */
      });
  }

  // An unordered task on the map: the machine walks off to a building of its own choosing.
  private syncUnordered(): void {
    const u = this.colony.state.events.unordered;
    if (!u || u.agent) return;
    const idle = this.world.layout.agents.filter((a) => a.skill !== "orchestrator" && this.world.getAgent(a.id)?.state === "idle");
    const pick = idle[Math.floor(this.colony.roll() * idle.length)];
    if (!pick) return;
    u.agent = pick.id;
    const targets = this.world.layout.buildings.filter((b) => b.id !== pick.home && b.status !== "building");
    const to = targets[Math.floor(this.colony.roll() * targets.length)] ?? this.world.layout.buildings[0];
    this.world.setAgent(pick.id, { state: "working", building: to.id, taskId: null, taskTitle: "An unordered task", detail: "unordered", progress: null });
    this.world.logLine(`${pick.name} left for the ${to.label} without being asked.`, "warn", pick.id);
  }

  recallUnordered(recall: boolean): void {
    const u = this.colony.state.events.unordered;
    this.colony.resolveUnordered(recall);
    if (u?.agent && this.world.getAgent(u.agent)?.detail === "unordered") this.world.setAgent(u.agent, { state: "idle" });
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
      if (this.colony.refuses()) {
        this.world.logLine(`${a.name} declined to build the ${labelOf(site.type)}.`, "warn", a.id);
        continue;
      }
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
    this.colony.tick(builders, this.machineEfficiency());
    this.afterTick();
    this.syncUnordered();
    this.maybeAutoMission();
    this.tellStory();
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
