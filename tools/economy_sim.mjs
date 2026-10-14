#!/usr/bin/env node
// Balance check for design/economy.json: plays the first sols of Outpost Zero hour by hour
// with the default plan (adapter/src/economy-plan.ts) on the adapter's own Colony code and prints
// the stock curves. Exits 1 if anyone dies.   Usage: node tools/economy_sim.mjs [sols] [--quiet]
import { Colony, loadDefs } from "../adapter/src/economy.ts";
import { playDefaultPlan } from "../adapter/src/economy-plan.ts";

const SOLS = Number(process.argv[2] ?? 40);
const QUIET = process.argv.includes("--quiet");
const defs = loadDefs(new URL("../design/economy.json", import.meta.url));
const c = new Colony(defs);
const f = (n, w = 4) => String(Math.round(n)).padStart(w);
const r = playDefaultPlan(c, SOLS, (col) => {
  const v = col.view();
  const s = v.stocks;
  if (!QUIET) console.log(`sol ${f(v.sol, 2)}  awake ${f(v.colonists.awake, 3)}  pwr ${f(v.power.supplyKw, 3)}/${f(v.power.demandKw, 3)}kW chg ${f(v.power.chargeKwh, 3)}  water ${f(s.water)}  food ${f(s.food)}  salv ${f(s.salvage)}  mat ${f(s.materials)}  parts ${f(s.parts, 3)}  med ${f(s.medicine, 3)}  trust ${f(v.trust, 3)}  infl ${f(v.influence, 2)}${v.colonists.hungry ? "  HUNGRY" : ""}${v.colonists.thirsty ? "  THIRSTY" : ""}`);
  for (const e of col.events.splice(0)) if (!QUIET && /online|awake|died|short|repaired/.test(e.text)) console.log("   " + e.text);
});
if (r.fail) {
  console.error("FAIL:", r.fail);
  process.exit(1);
}
console.log(`OK: ${SOLS} sols, ${c.state.awake} awake, ${c.state.buildings.length} buildings, trust ${c.state.trust.toFixed(0)}, influence ${c.state.influence.toFixed(0)}`);
