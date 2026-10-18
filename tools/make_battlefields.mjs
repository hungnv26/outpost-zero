#!/usr/bin/env node
// Generates the ten battlefields in design/maps.json (docs/arena.md §8d): a terrain, where the
// bases stand, structures and obstacles in the wild between them, and the conditions every team
// plays under. Placement is random from a seed, mirrored through the point between bases A and B
// so neither side of a duel gets the better ground. Re-run with another seed for a new set:
//   node tools/make_battlefields.mjs [seed]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "design", "maps.json");
const BASE = 44; // a team's base is 44 x 44 units, walls included
const seed = Number(process.argv[2] ?? 7310);

// mulberry32: small, seeded, good enough for placement.
function rng(s) {
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where the four bases stand. Duels use A and B; trio and quad add C and D.
const LAYOUTS = {
  ew: (g) => ({ A: [0, 0], B: [g, 0], C: [0, g], D: [g, g] }),
  ns: (g) => ({ A: [0, 0], B: [0, g], C: [g, 0], D: [g, g] }),
  diag: (g) => ({ A: [0, 0], B: [g, g], C: [g, 0], D: [0, g] }),
  offset: (g) => ({ A: [0, 0], B: [g, 30], C: [0, g + 14], D: [g, g + 44] }),
};

// Footprint radius of each kind, for spacing.
const RADIUS = { wreck: 4, wreckLarge: 5.5, relay: 2.5, ruins: 5, hangar: 4.5, rocket: 2.5, turret: 2, generator: 2.5, crater: 0, crystals: 3.5, meteors: 4, mesa: 0, lake: 0 };

const THEMES = [
  { id: "red-basin", name: "Red Basin", terrain: "mars", layout: "ew", gap: 84,
    brief: "Dust-choked lowland where the Odyssey-7 debris rained down.",
    conditions: { solar: 1.0, water: 0.9, salvage: 1.2, storms: 1.5 },
    centre: { kind: "crater", r: 9 }, structures: ["wreck", "wreck", "wreckLarge", "turret"], obstacles: ["ridge", "crater", "meteors", "crater"] },
  { id: "glass-dunes", name: "Glass Dunes", terrain: "sahara", layout: "ns", gap: 88,
    brief: "Hot, bright and dry: the sun is generous, the ground water is not.",
    conditions: { solar: 1.25, water: 0.75, salvage: 1.0, storms: 1.3 },
    centre: { kind: "ruins" }, structures: ["wreck", "pipeline", "generator"], obstacles: ["ridge", "mesa", "ridge"] },
  { id: "whiteout-shelf", name: "Whiteout Shelf", terrain: "arctic", layout: "diag", gap: 80,
    brief: "Ice everywhere and a weak sun low on the horizon.",
    conditions: { solar: 0.75, water: 1.3, salvage: 0.9, storms: 0.8 },
    centre: { kind: "lake", liquid: "ice", r: 10 }, structures: ["hangar", "relay", "wreck"], obstacles: ["chasm", "lake:ice", "ridge"] },
  { id: "tidewater", name: "Tidewater Landing", terrain: "beach", layout: "offset", gap: 90,
    brief: "A coastal flat; the tide brings water and washes salvage away.",
    conditions: { solar: 1.1, water: 1.25, salvage: 0.85, storms: 0.9 },
    centre: { kind: "lake", liquid: "water", r: 9 }, structures: ["wreck", "relay", "monorail"], obstacles: ["lake:water", "ridge"] },
  { id: "broken-mesa", name: "Broken Mesa", terrain: "canyon", layout: "ew", gap: 96,
    brief: "Mesas and a deep rift; old machinery lies at the canyon floor.",
    conditions: { solar: 1.0, water: 0.85, salvage: 1.25, storms: 1.0 },
    centre: { kind: "chasm", len: 30, w: 4 }, structures: ["ruins", "monorail", "generator"], obstacles: ["mesa", "mesa", "ridge"] },
  { id: "tranquility-rim", name: "Tranquility Rim", terrain: "moon", layout: "diag", gap: 88,
    brief: "No air, no storms, full sun; water has to be dug out of the regolith.",
    conditions: { solar: 1.3, water: 0.8, salvage: 1.0, storms: 0 },
    centre: { kind: "crater", r: 12 }, structures: ["rocket", "relay", "wreckLarge"], obstacles: ["crater", "crater", "meteors"] },
  { id: "sulphur-fields", name: "Sulphur Fields", terrain: "venus", layout: "ns", gap: 84,
    brief: "Lava vents under a thick sky; rich wreckage, poor light.",
    conditions: { solar: 0.75, water: 0.8, salvage: 1.3, storms: 1.2 },
    centre: { kind: "lake", liquid: "lava", r: 8 }, structures: ["wreck", "turret", "pipeline"], obstacles: ["lake:lava", "ridge", "meteors"] },
  { id: "fracture-ice", name: "Fracture Ice", terrain: "europa", layout: "ew", gap: 80,
    brief: "Cracked ice crust over an ocean: water is easy, light is not.",
    conditions: { solar: 0.7, water: 1.4, salvage: 0.9, storms: 0.6 },
    centre: { kind: "crystals" }, structures: ["hangar", "relay", "monorail"], obstacles: ["chasm", "crystals", "lake:ice"] },
  { id: "methane-shore", name: "Methane Shore", terrain: "titan", layout: "offset", gap: 92,
    brief: "An orange haze over methane lakes and strange growth.",
    conditions: { solar: 0.7, water: 1.1, salvage: 1.15, storms: 0.7 },
    centre: { kind: "lake", liquid: "methane", r: 11 }, structures: ["ruins", "wreck", "generator"], obstacles: ["lake:methane", "ridge", "crater"] },
  { id: "verdant-valley", name: "Verdant Valley", terrain: "grassland", layout: "ns", gap: 92,
    brief: "A green valley with a lake and ruins nobody on Earth built.",
    conditions: { solar: 1.0, water: 1.25, salvage: 0.8, storms: 0.5 },
    centre: { kind: "ruins" }, structures: ["ruins", "relay", "wreck"], obstacles: ["lake:water", "ridge", "mesa"] },
];

const round = (v) => Math.round(v * 10) / 10;

function build(theme, rand) {
  const bases = LAYOUTS[theme.layout](theme.gap);
  const rects = Object.values(bases).map(([x, z]) => ({ x0: x - 8, z0: z - 8, x1: x + BASE + 8, z1: z + BASE + 8 }));
  // The dirt roads leave each base through its gates at 15 and 29 along every wall.
  const onRoad = (x, z) => Object.values(bases).some(([bx, bz]) => {
    const inX = x > bx - 22 && x < bx + BASE + 22;
    const inZ = z > bz - 22 && z < bz + BASE + 22;
    return (inZ && (x < bx || x > bx + BASE) && [15, 29].some((v) => Math.abs(z - (bz + v)) < 3)) ||
      (inX && (z < bz || z > bz + BASE) && [15, 29].some((v) => Math.abs(x - (bx + v)) < 3));
  });
  const clear = (x, z, r) => !rects.some((q) => x + r > q.x0 && x - r < q.x1 && z + r > q.z0 && z - r < q.z1) && !onRoad(x, z);
  const ca = [bases.A[0] + BASE / 2, bases.A[1] + BASE / 2];
  const cb = [bases.B[0] + BASE / 2, bases.B[1] + BASE / 2];
  const mid = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2];
  const mirror = ([x, z]) => [2 * mid[0] - x, 2 * mid[1] - z];
  const axis = Math.atan2(cb[1] - ca[1], cb[0] - ca[0]);
  // The wild: the box around both duel bases, with room on every side.
  const box = { x0: Math.min(bases.A[0], bases.B[0]) - 34, z0: Math.min(bases.A[1], bases.B[1]) - 34, x1: Math.max(bases.A[0], bases.B[0]) + BASE + 34, z1: Math.max(bases.A[1], bases.B[1]) + BASE + 34 };
  const placed = []; // [x, z, r] to keep things apart
  const free = (x, z, r) => placed.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + r + 2.5);
  const structures = [];
  const obstacles = [];

  // The centrepiece stands between the two bases and mirrors onto itself.
  const c = theme.centre;
  const deg = (a) => Math.round((a * 180) / Math.PI);
  if (c.kind === "chasm") {
    const across = axis + Math.PI / 2;
    const h = c.len / 2;
    obstacles.push({ kind: "chasm", x: round(mid[0] - Math.cos(across) * h), z: round(mid[1] - Math.sin(across) * h), x2: round(mid[0] + Math.cos(across) * h), z2: round(mid[1] + Math.sin(across) * h), w: c.w });
    placed.push([mid[0], mid[1], h]);
  } else if (c.kind === "crater" || c.kind === "lake") {
    obstacles.push({ kind: c.kind, x: round(mid[0]), z: round(mid[1]), r: c.r, ...(c.liquid ? { liquid: c.liquid } : {}) });
    placed.push([mid[0], mid[1], c.r]);
  } else if (c.kind === "crystals") {
    obstacles.push({ kind: "crystals", x: round(mid[0]), z: round(mid[1]), r: 6 });
    placed.push([mid[0], mid[1], 6]);
  } else {
    structures.push({ kind: c.kind, x: round(mid[0]), z: round(mid[1]), rot: deg(axis), size: 10 });
    placed.push([mid[0], mid[1], 7]);
  }

  // Everything else comes in mirrored pairs.
  const pair = (r, make) => {
    for (let tries = 0; tries < 400; tries++) {
      const x = box.x0 + rand() * (box.x1 - box.x0);
      const z = box.z0 + rand() * (box.z1 - box.z0);
      const [mx, mz] = mirror([x, z]);
      if (Math.hypot(mx - x, mz - z) < 2 * r + 4) continue; // too close to its own mirror
      if (!clear(x, z, r) || !clear(mx, mz, r) || !free(x, z, r) || !free(mx, mz, r)) continue;
      const rot = rand() * 360;
      const a = make(x, z, rot, rand);
      if (!a) continue;
      const b = a.x2 !== undefined
        ? { ...a, x: round(mirror([a.x, a.z])[0]), z: round(mirror([a.x, a.z])[1]), x2: round(mirror([a.x2, a.z2])[0]), z2: round(mirror([a.x2, a.z2])[1]) }
        : { ...a, x: round(mx), z: round(mz), rot: a.rot !== undefined ? Math.round((a.rot + 180) % 360) : undefined };
      if (b.rot === undefined) delete b.rot;
      if (a.x2 !== undefined) {
        // A line must stay clear along its whole length, on both sides.
        const ok = [a, b].every((l) => [0, 0.25, 0.5, 0.75, 1].every((t) => clear(l.x + (l.x2 - l.x) * t, l.z + (l.z2 - l.z) * t, (l.w ?? 2) / 2 + 1)));
        if (!ok) continue;
      }
      placed.push([x, z, r], [mx, mz, r]);
      return [a, b];
    }
    return [];
  };
  const line = (kind, len, extra = {}) => (x, z, rot) => {
    const a = (rot * Math.PI) / 180;
    return { kind, x: round(x), z: round(z), x2: round(x + Math.cos(a) * len), z2: round(z + Math.sin(a) * len), ...extra };
  };

  for (const kind of theme.structures) {
    if (kind === "monorail") structures.push(...pair(10, line("monorail", 18)));
    else if (kind === "pipeline") structures.push(...pair(9, line("pipeline", 16)));
    else structures.push(...pair(RADIUS[kind] ?? 4, (x, z, rot, r) => ({ kind, x: round(x), z: round(z), rot: Math.round(rot), size: Math.round((RADIUS[kind] ?? 4) * 2 * (0.85 + r() * 0.3)) })));
  }
  for (const spec of theme.obstacles) {
    const [kind, liquid] = spec.split(":");
    if (kind === "ridge") obstacles.push(...pair(10, line("ridge", 14 + Math.round(rand() * 8), { w: 3 })));
    else if (kind === "chasm") obstacles.push(...pair(9, line("chasm", 16, { w: 3 })));
    else if (kind === "lake") obstacles.push(...pair(7, (x, z) => ({ kind: "lake", liquid, x: round(x), z: round(z), r: 5 + Math.round(rand() * 3) })));
    else if (kind === "crater") obstacles.push(...pair(6, (x, z) => ({ kind: "crater", x: round(x), z: round(z), r: 4 + Math.round(rand() * 3) })));
    else if (kind === "mesa") obstacles.push(...pair(5, (x, z) => ({ kind: "mesa", x: round(x), z: round(z), r: 3 + Math.round(rand() * 2), h: 4 + Math.round(rand() * 3) })));
    else obstacles.push(...pair(RADIUS[kind] ?? 4, (x, z) => ({ kind, x: round(x), z: round(z), r: RADIUS[kind] ?? 4 })));
  }
  const { id, name, terrain, brief, conditions, layout } = theme;
  return { name, terrain, brief, layout, world: Math.round(Math.max(box.x1 - box.x0, box.z1 - box.z0)), conditions, bases, structures, obstacles, $id: id };
}

const maps = JSON.parse(readFileSync(PATH, "utf8"));
const rand = rng(seed);
const battlefields = {};
for (const t of THEMES) {
  const b = build(t, rand);
  delete b.$id;
  battlefields[t.id] = b;
}
maps.$battlefields = `Ten battlefields from tools/make_battlefields.mjs (seed ${seed}); the director picks one with --map random or by id. Structures and obstacles are scenery in the wild, mirrored between A and B; conditions scale solar output, water production, expedition salvage and the dust-storm chance for every team alike.`;
maps.battlefields = battlefields;
writeFileSync(PATH, JSON.stringify(maps, null, 2) + "\n");
for (const [id, b] of Object.entries(battlefields)) console.log(`${id.padEnd(16)} ${b.terrain.padEnd(9)} ${b.layout.padEnd(6)} ${String(b.structures.length).padStart(2)} structures ${String(b.obstacles.length).padStart(2)} obstacles  B at ${b.bases.B}`);
