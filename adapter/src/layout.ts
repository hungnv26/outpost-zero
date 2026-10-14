import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The player-editable base: where buildings and spots are, what work each building hosts,
// and which characters (real Hermes agents) exist. Owned and persisted by the adapter; the
// game renders it and edits it through commands.

export type Capability = "command" | "research" | "code" | "knowledge" | "approval" | "meeting";
export type Skill = "web" | "reasoning" | "code" | "orchestrator";

export interface BuildingDef {
  id: string;
  label: string;
  x: number;
  z: number;
  model: string; // Kenney model name, e.g. "hangar_largeA"
  color: string; // "#rrggbb" accent
  capability: Capability;
  builtin?: boolean;
}

export interface SpotDef {
  id: "rally_point" | "repair_bay";
  label: string;
  x: number;
  z: number;
}

export interface AgentDef {
  id: string; // unit id on the map
  name: string;
  hermesId: string; // Hermes sub-agent id ("jarvis" for the Commander)
  job: string; // what the agent does (Hermes system prompt for custom agents)
  skill: Skill;
  model: string; // vehicle model name
  color: string;
  home: string; // building id it works at by default
  builtin?: boolean;
}

// Ground and light themes. Purely visual, so they can change at any time.
export const TERRAINS = [
  "grassland", "sahara", "arctic", "beach", "canyon", // Earth
  "mars", "moon", "venus", "europa", "titan", // other worlds
] as const;
export type Terrain = (typeof TERRAINS)[number];

export interface BaseLayout {
  version: 1;
  size: number; // map is size x size, centred on size/2
  terrain: Terrain;
  buildings: BuildingDef[];
  spots: SpotDef[];
  agents: AgentDef[];
}

// Tool name keywords that send an agent to a building of this capability.
export const CAPABILITY_TOOLS: Record<Capability, RegExp | null> = {
  research: /search|weather|rss|github|news|browse|fetch/i,
  code: /execute|python|sandbox|code|command|shell/i,
  knowledge: /obsidian|rag|memory|document|knowledge|note/i,
  command: null,
  approval: null,
  meeting: null,
};

export const MAX_BUILDINGS = 32; // = the district slots plus the two in the centre
export const MAX_CUSTOM_AGENTS = 24; // on top of the 7 built-in characters
const BUILDING_SPACING = 4.5; // centre to centre; footprints are ~3.6

export const BUILDING_MODELS = [
  "satelliteDish_large", "satelliteDish_detailed", "hangar_largeA", "hangar_largeB", "hangar_roundA",
  "hangar_roundB", "hangar_roundGlass", "hangar_smallA", "hangar_smallB", "gate_complex", "gate_simple",
  "structure", "structure_detailed", "structure_closed", "machine_generatorLarge", "machine_barrelLarge",
  "rocket_baseA", "turret_double", "CommandCenter",
  // Open RTS's own structures and the rest of the kit's standalone buildings
  "VehicleFactory", "AircraftFactory", "AntiGroundTurret", "AntiAirTurret", "turret_single", "satelliteDish",
  "structure_diagonal", "machine_generator", "machine_wireless", "machine_wirelessCable", "machine_barrel", "Rocket",
  // KayKit Space Base Bits (CC0)
  "basemodule_A", "basemodule_B", "basemodule_C", "basemodule_D", "basemodule_E", "basemodule_garage",
  "cargodepot_A", "cargodepot_B", "cargodepot_C", "drill_structure", "lander_A", "lander_B",
  "landingpad_large", "structure_low", "structure_tall", "windturbine_tall", "containers_A", "solarpanel",
  // Quaternius Ultimate Space Kit (CC0)
  "GeodesicDome", "BaseLarge", "BuildingL", "HouseCylinder", "HouseLong", "HouseSingle", "SolarPanelStructure",
];
export const VEHICLE_MODELS = [
  "rover", "craft_speederA", "craft_speederB", "craft_speederC", "craft_speederD", "craft_racer",
  "craft_miner", "craft_cargoA", "craft_cargoB", "astronautA", "astronautB", "alien",
  "Tank", "MonorailTrain", // assembled from several parts
  // Quaternius Ultimate Space Kit (CC0): animated characters that walk, and two rovers
  "Astronaut_A", "Astronaut_B", "Astronaut_C", "Mech_A", "Mech_B", "Mech_C", "Mech_D",
  "EnemyLarge", "EnemySmall", "EnemyFlying", "Rover_A", "RoundRover",
];

// ---- departments and districts ----
// Every building belongs to a department (its capability; Human Approval sits with Command)
// and every character to its home building's department. The map is a 3x3 grid of districts
// separated by streets; each district has 2x2 building slots on a 7-unit lattice, which
// leaves room around every building for its characters to park.
//
//   Research   | Commons (Rally Point) | Engineering
//   Research   | Command + Approval    | Engineering
//   Knowledge  | Knowledge             | Commons (Repair Bay)

export type Department = "command" | "research" | "code" | "knowledge" | "meeting";

export const DEPARTMENTS: Record<Department, { name: string; color: string }> = {
  command: { name: "Command", color: "#b48cff" },
  research: { name: "Research", color: "#4fb3ff" },
  code: { name: "Engineering", color: "#ff9940" },
  knowledge: { name: "Knowledge", color: "#5fd98a" },
  meeting: { name: "Commons", color: "#ff7fae" },
};

export function departmentOf(capability: Capability): Department {
  return capability === "approval" ? "command" : capability;
}

export const MAP_SIZE = 44;
const PITCH = 7;
const LATTICE = [0, 1, 2, 3, 4, 5].map((i) => PITCH / 2 + 1 + i * PITCH); // 4.5 .. 39.5
// DISTRICTS[row][col], rows north (low z) to south.
export const DISTRICTS: Department[][] = [
  ["research", "meeting", "code"],
  ["research", "command", "code"],
  ["knowledge", "knowledge", "meeting"],
];
// Fixed places in the Command district and for the two spots (each spot takes one slot).
const FIXED: Record<string, { x: number; z: number }> = {
  command_centre: { x: LATTICE[2], z: MAP_SIZE / 2 },
  human_approval: { x: LATTICE[3], z: MAP_SIZE / 2 },
  rally_point: { x: LATTICE[2], z: LATTICE[1] },
  repair_bay: { x: LATTICE[5], z: LATTICE[5] },
};

interface Slot { x: number; z: number; dept: Department }

const SLOTS: Slot[] = (() => {
  const out: Slot[] = [];
  for (let zi = 0; zi < 6; zi++) {
    for (let xi = 0; xi < 6; xi++) {
      const dept = DISTRICTS[zi >> 1][xi >> 1];
      const x = LATTICE[xi];
      const z = LATTICE[zi];
      if (dept === "command") continue; // the centre holds only the Command Centre and Approval
      if (Object.values(FIXED).some((f) => f.x === x && f.z === z)) continue;
      out.push({ x, z, dept });
    }
  }
  // Inner slots first, so a small department hugs the centre.
  const d = (s: Slot) => Math.hypot(s.x - MAP_SIZE / 2, s.z - MAP_SIZE / 2);
  return out.sort((a, b) => d(a) - d(b) || a.z - b.z || a.x - b.x);
})();

function districtCentre(dept: Department): { x: number; z: number } {
  const cells: { x: number; z: number }[] = [];
  const cell = 2 * PITCH;
  DISTRICTS.forEach((row, r) => row.forEach((d, c) => d === dept && cells.push({ x: 1 + cell / 2 + c * cell, z: 1 + cell / 2 + r * cell })));
  return { x: cells.reduce((a, b) => a + b.x, 0) / cells.length, z: cells.reduce((a, b) => a + b.z, 0) / cells.length };
}

function slotFree(slot: { x: number; z: number }, buildings: BuildingDef[], ignore?: BuildingDef, spots: SpotDef[] = []): boolean {
  if (spots.some((s) => Math.hypot(s.x - slot.x, s.z - slot.z) < 4.5)) return false;
  return buildings.every((b) => b === ignore || Math.hypot(b.x - slot.x, b.z - slot.z) >= BUILDING_SPACING);
}

// Next free slot in the department's district; if that's full, the free slot nearest to it.
export function freeSlot(l: BaseLayout, dept: Department, ignore?: BuildingDef): { x: number; z: number } | null {
  const own = SLOTS.find((s) => s.dept === dept && slotFree(s, l.buildings, ignore, l.spots));
  if (own) return { x: own.x, z: own.z };
  const c = districtCentre(dept);
  const rest = SLOTS.filter((s) => slotFree(s, l.buildings, ignore, l.spots)).sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
  return rest[0] ? { x: rest[0].x, z: rest[0].z } : null;
}

// Moves every building into its department's district (keeping each department's order,
// built-ins first), puts the spots in their places and paints buildings in department colours.
export function organiseLayout(l: BaseLayout): BaseLayout {
  const placed: BuildingDef[] = [];
  for (const id of ["command_centre", "human_approval"]) {
    const b = l.buildings.find((x) => x.id === id);
    if (b) Object.assign(b, FIXED[id]), placed.push(b);
  }
  for (const s of l.spots) Object.assign(s, FIXED[s.id]);
  const order = (Object.keys(DEPARTMENTS) as Department[]).filter((d) => d !== "command");
  const rest = l.buildings.filter((b) => !placed.includes(b));
  const byDept = (d: Department) => rest.filter((b) => departmentOf(b.capability) === d).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin));
  const queue = [...order.flatMap(byDept), ...rest.filter((b) => departmentOf(b.capability) === "command")];
  for (const b of queue) {
    const slot = freeSlot({ ...l, buildings: placed }, departmentOf(b.capability));
    if (slot) Object.assign(b, slot);
    placed.push(b);
  }
  for (const b of l.buildings) b.color = DEPARTMENTS[departmentOf(b.capability)].color;
  return l;
}

export const DEFAULT_LAYOUT: BaseLayout = organiseLayout({
  version: 1,
  size: MAP_SIZE,
  terrain: "mars",
  buildings: [
    { id: "command_centre", label: "Command Centre", x: 16, z: 16, model: "CommandCenter", color: "#66ccff", capability: "command", builtin: true },
    { id: "research_lab", label: "Research Lab", x: 6.5, z: 6.5, model: "lander_B", color: "#59bfff", capability: "research", builtin: true },
    { id: "code_factory", label: "Code Factory", x: 25.5, z: 6.5, model: "cargodepot_C", color: "#ff9940", capability: "code", builtin: true },
    { id: "knowledge_library", label: "Knowledge Library", x: 6.5, z: 25.5, model: "basemodule_A", color: "#73f299", capability: "knowledge", builtin: true },
    { id: "human_approval", label: "Human Approval", x: 25.5, z: 25.5, model: "gate_complex", color: "#d98cff", capability: "approval", builtin: true },
  ],
  spots: [
    { id: "rally_point", label: "Rally Point", x: 16, z: 6 },
    { id: "repair_bay", label: "Repair Bay", x: 16, z: 26.5 },
  ],
  agents: [
    { id: "commander", name: "Commander", hermesId: "jarvis", job: "Plans the mission, coordinates each step and writes the final summary.", skill: "orchestrator", model: "Mech_B", color: "#d9edff", home: "command_centre", builtin: true },
    { id: "researcher", name: "Researcher", hermesId: "research", job: "Deep research: searches the web and reads sources.", skill: "web", model: "Astronaut_A", color: "#59ccff", home: "research_lab", builtin: true },
    { id: "scout", name: "Scout", hermesId: "scout", job: "Quick scan of the latest news and announcements.", skill: "web", model: "EnemyFlying", color: "#ffe04d", home: "research_lab", builtin: true },
    { id: "analyst", name: "Analyst", hermesId: "insights", job: "Extracts key facts, numbers and trends from what was gathered.", skill: "reasoning", model: "Astronaut_B", color: "#8cf280", home: "knowledge_library", builtin: true },
    { id: "coder", name: "Coder", hermesId: "code", job: "Runs code in the sandbox: calculations and charts.", skill: "code", model: "Mech_D", color: "#ff9940", home: "code_factory", builtin: true },
    { id: "writer", name: "Writer", hermesId: "writer", job: "Drafts the report from the findings.", skill: "reasoning", model: "Astronaut_C", color: "#ff80bf", home: "knowledge_library", builtin: true },
    { id: "reviewer", name: "Reviewer", hermesId: "reviewer", job: "Checks the result for accuracy and gaps; always the last step.", skill: "reasoning", model: "Mech_A", color: "#d98cff", home: "knowledge_library", builtin: true },
  ],
});

export function cloneLayout(l: BaseLayout): BaseLayout {
  return structuredClone(l);
}

export function loadLayout(path: string): BaseLayout {
  if (!existsSync(path)) return cloneLayout(DEFAULT_LAYOUT);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.version !== 1) return cloneLayout(DEFAULT_LAYOUT);
    const l = raw as BaseLayout;
    // Built-ins the player deleted from an older file come back (they're load-bearing).
    for (const b of DEFAULT_LAYOUT.buildings) if (!l.buildings.some((x) => x.id === b.id) && isCore(b.id)) l.buildings.push(structuredClone(b));
    for (const a of DEFAULT_LAYOUT.agents) if (!l.agents.some((x) => x.id === a.id)) l.agents.push(structuredClone(a));
    for (const s of DEFAULT_LAYOUT.spots) if (!l.spots.some((x) => x.id === s.id)) l.spots.push(structuredClone(s));
    if (!TERRAINS.includes(l.terrain)) l.terrain = DEFAULT_LAYOUT.terrain;
    // A base saved on the older, smaller map is laid out again on the current one.
    if (l.size !== MAP_SIZE) {
      l.size = MAP_SIZE;
      organiseLayout(l);
    }
    return l;
  } catch {
    return cloneLayout(DEFAULT_LAYOUT);
  }
}

export function saveLayout(path: string, l: BaseLayout): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, path);
}

// Buildings the base cannot work without (can be moved and restyled, never deleted).
export function isCore(buildingId: string): boolean {
  return buildingId === "command_centre" || buildingId === "human_approval";
}

// The building an agent drives to for a tool: its own home if that hosts the work,
// otherwise the nearest building of the matching department.
export function buildingForTool(l: BaseLayout, tool: string, agentId?: string): string | null {
  const fits = l.buildings.filter((b) => CAPABILITY_TOOLS[b.capability]?.test(tool));
  if (fits.length === 0) return null;
  const home = l.buildings.find((b) => b.id === (agentId ? homeOf(l, agentId) : ""));
  if (!home) return fits[0].id;
  if (fits.includes(home)) return home.id;
  return fits.reduce((a, b) => (Math.hypot(b.x - home.x, b.z - home.z) < Math.hypot(a.x - home.x, a.z - home.z) ? b : a)).id;
}

export function homeOf(l: BaseLayout, agentId: string): string {
  const home = l.agents.find((a) => a.id === agentId)?.home;
  return home && l.buildings.some((b) => b.id === home) ? home : "command_centre";
}

// ---- validation of edit commands (input comes from game clients) ----

const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CAPABILITIES: Capability[] = ["research", "code", "knowledge", "meeting"];
const CUSTOM_SKILLS: Skill[] = ["web", "reasoning"];

export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return /^[a-z]/.test(s) ? s : `x_${s}`.slice(0, 24);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function coord(v: unknown, size: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : size / 2;
  return Math.round(Math.min(size - 2, Math.max(2, n)) * 2) / 2; // half-unit grid, inside the map
}

export class LayoutError extends Error {}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

// Create or update a building. Built-ins keep their id and capability.
export function upsertBuilding(l: BaseLayout, input: Record<string, unknown>): BuildingDef {
  const label = text(input.label, 40);
  const existing = typeof input.id === "string" ? l.buildings.find((b) => b.id === input.id) : undefined;
  if (!existing && !label) throw new LayoutError("A building needs a name.");
  if (!existing && l.buildings.length >= MAX_BUILDINGS) throw new LayoutError(`The base holds at most ${MAX_BUILDINGS} buildings.`);
  const model = typeof input.model === "string" && BUILDING_MODELS.includes(input.model) ? input.model : existing?.model ?? "hangar_smallA";
  const capability =
    existing?.builtin
      ? existing.capability
      : CAPABILITIES.includes(input.capability as Capability)
        ? (input.capability as Capability)
        : existing?.capability ?? "meeting";
  const color = DEPARTMENTS[departmentOf(capability)].color;
  let x: number;
  let z: number;
  if (input.x !== undefined || input.z !== undefined) {
    x = coord(input.x, l.size);
    z = coord(input.z, l.size);
  } else if (!existing || (input.auto === true && departmentOf(capability) !== departmentOf(existing.capability))) {
    // No position given: the next free slot in its department's district.
    const slot = freeSlot(l, departmentOf(capability), existing);
    if (!slot) throw new LayoutError(`No free slot left; choose a spot on the map for ${label || existing?.label}.`);
    ({ x, z } = slot);
  } else {
    ({ x, z } = existing);
  }
  for (const b of l.buildings) {
    if (b !== existing && Math.hypot(b.x - x, b.z - z) < BUILDING_SPACING) throw new LayoutError(`Too close to ${b.label}.`);
  }
  for (const s of l.spots) {
    if (Math.hypot(s.x - x, s.z - z) < 4.5) throw new LayoutError(`Too close to the ${s.label}.`);
  }
  if (existing) {
    Object.assign(existing, { label: label || existing.label, model, color, capability, x, z });
    return existing;
  }
  // Spot ids and the core buildings' ids are taken too (a building named "Rally Point"
  // must not become rally_point, or agents sent there would walk to the spot).
  const taken = new Set([...l.buildings.map((b) => b.id), ...l.spots.map((s) => s.id), "command_centre", "human_approval"]);
  const id = uniqueId(slug(label), taken);
  const b: BuildingDef = { id, label, x, z, model, color, capability };
  l.buildings.push(b);
  return b;
}

export function removeBuilding(l: BaseLayout, id: string): void {
  const b = l.buildings.find((x) => x.id === id);
  if (!b) throw new LayoutError("No such building.");
  if (isCore(id)) throw new LayoutError(`${b.label} can be moved but not removed.`);
  l.buildings = l.buildings.filter((x) => x.id !== id);
  for (const a of l.agents) if (a.home === id) a.home = "command_centre";
}

export function moveSpot(l: BaseLayout, id: string, x: unknown, z: unknown): SpotDef {
  const s = l.spots.find((p) => p.id === id);
  if (!s) throw new LayoutError("No such spot.");
  const nx = coord(x, l.size);
  const nz = coord(z, l.size);
  for (const b of l.buildings) if (Math.hypot(b.x - nx, b.z - nz) < 4.5) throw new LayoutError(`Too close to ${b.label}.`);
  for (const o of l.spots) if (o !== s && Math.hypot(o.x - nx, o.z - nz) < 4.5) throw new LayoutError(`Too close to the ${o.label}.`);
  s.x = nx;
  s.z = nz;
  return s;
}

// Create or update a character. Built-ins can be restyled (name, vehicle, colour, home),
// custom characters can also change their job and skill.
export function upsertAgent(l: BaseLayout, input: Record<string, unknown>): AgentDef {
  const existing = typeof input.id === "string" ? l.agents.find((a) => a.id === input.id) : undefined;
  const name = text(input.name, 24);
  if (!existing && !name) throw new LayoutError("A character needs a name.");
  const model = typeof input.model === "string" && VEHICLE_MODELS.includes(input.model) ? input.model : existing?.model ?? "rover";
  const color = typeof input.color === "string" && COLOR_RE.test(input.color) ? input.color : existing?.color ?? "#ffffff";
  const home = typeof input.home === "string" && l.buildings.some((b) => b.id === input.home) ? input.home : existing?.home ?? defaultHome(l, input.skill);
  if (existing) {
    existing.name = name || existing.name;
    existing.model = model;
    existing.color = color;
    existing.home = home;
    if (!existing.builtin) {
      const job = text(input.job, 600);
      if (job) existing.job = job;
      if (CUSTOM_SKILLS.includes(input.skill as Skill)) existing.skill = input.skill as Skill;
    }
    return existing;
  }
  const job = text(input.job, 600);
  if (job.length < 10) throw new LayoutError("Describe the character's job (at least a sentence).");
  if (l.agents.filter((a) => !a.builtin).length >= MAX_CUSTOM_AGENTS) throw new LayoutError(`At most ${MAX_CUSTOM_AGENTS} custom characters.`);
  const id = uniqueId(slug(name), new Set(l.agents.map((a) => a.id)));
  const skill = CUSTOM_SKILLS.includes(input.skill as Skill) ? (input.skill as Skill) : "reasoning";
  const a: AgentDef = { id, name, hermesId: `rts_${id}`.slice(0, 32), job, skill, model, color, home };
  if (!ID_RE.test(a.hermesId)) throw new LayoutError("Invalid character name.");
  l.agents.push(a);
  return a;
}

// Where a new character lives when none is chosen: a building of the department its skill uses.
function defaultHome(l: BaseLayout, skill: unknown): string {
  const want: Capability = skill === "web" ? "research" : "knowledge";
  return l.buildings.find((b) => b.capability === want)?.id ?? "command_centre";
}

export function setTerrain(l: BaseLayout, terrain: unknown): void {
  if (!TERRAINS.includes(terrain as Terrain)) throw new LayoutError("Unknown terrain.");
  l.terrain = terrain as Terrain;
}

export function removeAgent(l: BaseLayout, id: string): AgentDef {
  const a = l.agents.find((x) => x.id === id);
  if (!a) throw new LayoutError("No such character.");
  if (a.builtin) throw new LayoutError(`${a.name} is part of the core team and can't be removed.`);
  l.agents = l.agents.filter((x) => x.id !== id);
  return a;
}
