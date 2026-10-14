#!/usr/bin/env node
// Balance check for design/economy.json: plays the first sols of Outpost Zero hour by hour with a
// sensible build order and prints the stock curves. Fails (exit 1) if anyone starves, dies of
// thirst, or life support browns out.   Usage: node tools/economy_sim.mjs [sols] [--quiet]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const E = JSON.parse(readFileSync(join(here, "..", "design", "economy.json"), "utf8"));
const SOLS = Number(process.argv[2] ?? 40);
const QUIET = process.argv.includes("--quiet");
const H = E.time.hoursPerSol;

// A plain player's build order: name, then the condition that starts it (stocks must cover the cost).
const PLAN = [
  { b: "waterExtractor", when: () => true },
  { b: "solarArray",     when: () => true },
  { b: "scrapYard",      when: () => true },
  { b: "hydroponics",    when: () => true },
  { b: "hydroponics",    when: () => true },
  { b: "waterExtractor", when: () => true },
  { b: "batteryBank",    when: () => true },
  { b: "fabricator",     when: s => s.stocks.materials >= 90 },
  { b: "hydroponics",    when: s => s.awake >= 30 },
  { b: "waterExtractor", when: s => s.awake >= 30 },
  { b: "medBay",         when: () => true },
  { b: "solarArray",     when: () => true },
  { b: "storageDepot",   when: () => true },
  { b: "researchLab",    when: () => true },
  { b: "waterExtractor", when: s => s.awake >= 40 },
  { b: "hydroponics",    when: s => s.awake >= 48 },
  { b: "habitat",        when: s => s.awake >= 40 },
  { b: "relayDish",      when: () => true },
  { b: "solarArray",     when: s => s.awake >= 60 },
  { b: "hydroponics",    when: s => s.awake >= 64 },
  { b: "waterExtractor", when: s => s.awake >= 70 },
];

const s = {
  hour: 0, awake: E.start.colonistsAwake, cryo: E.start.colonistsCryo, dead: 0,
  machines: E.start.machines, autonomy: E.start.machineAutonomy,
  stocks: { ...E.start.stocks }, trust: E.start.trust, influence: E.start.influence,
  built: E.start.buildings.map(b => ({ type: b, hp: 1 })), reactor: 1.0,
  building: null, planIdx: 0, hungrySols: 0, thirstySols: 0, log: [], fail: null,
};
const cap = r => (E.resources[r].cap ?? Infinity) + s.built.filter(b => b.type === "storageDepot").length * (E.buildings.storageDepot.capBonus[r] ?? 0);
const add = (r, v) => { s.stocks[r] = Math.max(0, Math.min(cap(r), (s.stocks[r] ?? 0) + v)); };
const eff = E.machines.autonomyLevels[s.autonomy].efficiency;

function tick() {
  const sol = Math.floor(s.hour / H), hod = s.hour % H, day = hod < E.time.daylightHours;
  // Workers: colonists work workHours/sol, machines always (minus the ones building).
  const humanHours = s.awake * (E.colonists.workHoursPerSol / H);
  const buildMachines = s.building ? Math.min(2, s.machines) : 0;
  let labour = humanHours; // machine hours are added once we know they have power
  // Power supply.
  const solar = s.built.filter(b => b.type === "solarArray").length * E.buildings.solarArray.powerGenKwPeak * (day ? 1 : 0);
  let supply = E.buildings.landingModule.powerGenKw * s.reactor + solar;
  // Demand, in priority order; each class is served or cut.
  const draws = [];
  draws.push(["lifeSupport", Math.ceil(s.awake / 10) * E.colonists.lifeSupportKwPer10]);
  draws.push(["cryo", s.cryo * E.buildings.cryoBay.drawKwPerPod]);
  const prod = {};
  for (const b of s.built) {
    const d = E.buildings[b.type]; if (!d.class || !d.drawKw) continue;
    draws.push([d.class, d.drawKw, b]);
  }
  draws.push(["machines", s.machines * E.machines.workingKw]);
  const order = E.resources.power.priority;
  draws.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const chargeCap = E.resources.charge.cap + s.built.filter(b => b.type === "batteryBank").length * E.buildings.batteryBank.chargeCap;
  let available = supply + s.stocks.charge; // kWh this hour
  const served = new Set();
  for (const [cls, kw, b] of draws) {
    if (available >= kw) { available -= kw; if (b) served.add(b); else served.add(cls); }
    else if (cls === "lifeSupport") s.fail = `sol ${sol}: life support brownout`;
  }
  s.stocks.charge = Math.min(chargeCap, available);
  labour += (s.machines - buildMachines) * eff * (served.has("machines") ? 1 : 0.25);
  // Production for served buildings with crew and inputs.
  for (const b of s.built) {
    const d = E.buildings[b.type]; if (!d.out || !served.has(b)) continue;
    if (labour < (d.crew ?? 0)) continue;
    // A player idles a full line: parts lines stop at 30% of the cap, everything else at 90%.
    if (Object.keys(d.out).some(r => s.stocks[r] >= (r === "parts" && d.in?.materials ? 0.3 : 0.9) * cap(r))) continue;
    labour -= d.crew ?? 0;
    let ok = true; for (const [r, v] of Object.entries(d.in ?? {})) if (s.stocks[r] < v) ok = false;
    if (!ok) continue;
    for (const [r, v] of Object.entries(d.in ?? {})) add(r, -v);
    for (const [r, v] of Object.entries(d.out)) add(r, v * (d.machinesOnly ? eff : 1));
  }
  // Expeditions: tripsPerSol machines go out for salvage (spread evenly over the sol).
  add("salvage", E.expeditions.tripsPerSol * (E.expeditions.salvage.min + E.expeditions.salvage.max) / 2 / H);
  // Consumption.
  const needF = s.awake * E.colonists.foodPerSol / H, needW = s.awake * E.colonists.waterPerSol / H;
  const fed = s.stocks.food >= needF, watered = s.stocks.water >= needW;
  add("food", -needF); add("water", -needW);
  add("food", -s.stocks.food * E.resources.food.spoilagePerSol / H);
  add("parts", -(s.machines * E.machines.partsPerSol + s.built.reduce((a, b) => a + (E.buildings[b.type].maintenancePartsPerSol ?? 0), 0)) / H);
  // Building work.
  if (!s.building && s.planIdx < PLAN.length) {
    const p = PLAN[s.planIdx], d = E.buildings[p.b];
    if (p.when(s) && Object.entries(d.cost).every(([r, v]) => s.stocks[r] >= v)) {
      for (const [r, v] of Object.entries(d.cost)) add(r, -v);
      s.building = { type: p.b, left: d.buildHours }; s.planIdx++;
    }
  }
  if (s.building) { s.building.left -= buildMachines / 2 * eff; if (s.building.left <= 0) { s.built.push({ type: s.building.type, hp: 1 }); s.log.push(`sol ${sol}: ${s.building.type} online`); s.building = null; } }
  // Wake colonists when there is 10 sols of food and water margin and habitat room.
  const habitat = s.built.filter(b => b.type === "habitat").length * E.buildings.habitat.capacity;
  const foodRate = s.built.filter(b => b.type === "hydroponics" && served.has(b)).length * E.buildings.hydroponics.out.food * H, waterRate = s.built.filter(b => b.type === "waterExtractor" && served.has(b)).length * 5 * H;
  if (hod === 0 && s.cryo > 0 && s.awake < habitat && foodRate > (s.awake + 8) * 3 && waterRate > (s.awake + 8) * 4 + 24 && s.stocks.medicine >= 16) {
    s.awake += 8; s.cryo -= 8; add("medicine", -16); s.log.push(`sol ${sol}: woke 8 (awake ${s.awake})`);
  }
  // Sol end: trust, deaths, reactor wear.
  if (hod === H - 1) {
    s.hungrySols = fed ? 0 : s.hungrySols + 1; s.thirstySols = watered ? 0 : s.thirstySols + 1;
    s.trust += fed && watered ? E.trust.perSol.fedAndWatered : (fed ? 0 : E.trust.perSol.hungry) + (watered ? 0 : E.trust.perSol.thirsty);
    s.trust += s.autonomy > 2 ? E.trust.perSol.autonomyAbove2 : 0; s.trust = Math.max(0, Math.min(100, s.trust));
    s.influence = Math.min(100, s.influence + E.machines.autonomyLevels[s.autonomy].influenceDriftPerSol);
    s.reactor = Math.max(0, s.reactor - E.buildings.landingModule.degradePerSol);
    if (s.reactor < 0.95 && s.stocks.parts >= E.buildings.landingModule.repairParts) { add("parts", -E.buildings.landingModule.repairParts); s.reactor = 1.0; }
    if (s.hungrySols >= E.colonists.hungerDeathSols) s.fail = `sol ${sol}: starvation`;
    if (s.thirstySols >= E.colonists.thirstDeathSols) s.fail = `sol ${sol}: death by thirst`;
    if (!QUIET) console.log(`sol ${String(sol).padStart(2)}  awake ${String(s.awake).padStart(3)}  pwr ${supply.toFixed(0).padStart(3)}kW chg ${s.stocks.charge.toFixed(0).padStart(3)}  water ${s.stocks.water.toFixed(0).padStart(4)}  food ${s.stocks.food.toFixed(0).padStart(4)}  salv ${s.stocks.salvage.toFixed(0).padStart(4)}  mat ${s.stocks.materials.toFixed(0).padStart(4)}  parts ${s.stocks.parts.toFixed(0).padStart(3)}  med ${s.stocks.medicine.toFixed(0).padStart(3)}  trust ${s.trust.toFixed(0)}  infl ${s.influence.toFixed(0)}${fed ? "" : "  HUNGRY"}${watered ? "" : "  THIRSTY"}`);
  }
  s.hour++;
}

while (s.hour < SOLS * H && !s.fail) tick();
for (const l of s.log) console.log("  " + l);
if (s.fail) { console.error("FAIL:", s.fail); process.exit(1); }
console.log(`OK: ${SOLS} sols, ${s.awake} awake, ${s.built.length} buildings, trust ${s.trust.toFixed(0)}, influence ${s.influence.toFixed(0)}`);
