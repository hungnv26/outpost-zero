#!/usr/bin/env node
// Plays the default build order against a running adapter through the same HTTP commands
// the game sends, and reports when the first colonists wake. Used for the Phase 2 check.
//   COLONY_SECONDS_PER_HOUR=0.1 node adapter/src/main.ts   (a fast clock), then
//   node tools/play_default.mjs [sols] [adapterUrl]
import { PLAN } from "../adapter/src/economy-plan.ts";

const SOLS = Number(process.argv[2] ?? 12);
const URL_ = process.argv[3] ?? "http://127.0.0.1:8771";
const post = async (cmd) => {
  const r = await fetch(`${URL_}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });
  return r.json();
};
const state = async () => (await (await fetch(`${URL_}/state`)).json()).world.resources.colony;

let planIdx = 0;
let lastHour = -1;
let firstWake = null;
const log = [];
await post({ type: "colony.set_speed", speed: 3 });
for (;;) {
  const c = await state();
  const hour = c.sol * 24 + c.hour;
  if (c.sol >= SOLS) break;
  if (hour !== lastHour) {
    lastHour = hour;
    const stocks = c.stocks;
    // Build the next affordable thing in the plan.
    if (!c.building && planIdx < PLAN.length) {
      const p = PLAN[planIdx];
      const fake = { stocks, awake: c.colonists.awake };
      const entry = c.catalog.find((k) => k.type === p.b);
      if (p.when(fake) && entry && !entry.blocked) {
        const r = await post({ type: "colony.build", building: p.b });
        if (r.ok) { planIdx++; log.push(`sol ${c.sol} h${c.hour}: build ${p.b}`); }
      }
    }
    for (const b of c.buildings) {
      if (b.type !== "fabricator") continue;
      if (b.enabled && stocks.parts >= 60) await post({ type: "colony.toggle", id: b.id, enabled: false });
      else if (!b.enabled && stocks.parts < 40) await post({ type: "colony.toggle", id: b.id, enabled: true });
    }
    if (c.reactor < 0.95 && stocks.parts >= 8) await post({ type: "colony.repair", target: "reactor" });
    const rate = (type, out) => c.buildings.filter((b) => b.type === type && b.enabled).length * out * 24;
    const awake = c.colonists.awake;
    if (c.hour === 0 && !c.colonists.waking && c.colonists.cryo > 0 && awake + 8 <= c.colonists.beds && rate("hydroponics", 2.5) > (awake + 8) * 3 && rate("waterExtractor", 5) > (awake + 8) * 4 + 24 && stocks.medicine >= 16) {
      const r = await post({ type: "colony.wake", count: 8 });
      if (r.ok) log.push(`sol ${c.sol}: wake 8`);
    }
    if (firstWake === null && awake > 24) firstWake = c.sol;
    if (c.hour === 0) console.log(`sol ${c.sol}: awake ${awake} water ${stocks.water.toFixed(0)} food ${stocks.food.toFixed(0)} salv ${stocks.salvage.toFixed(0)} mat ${stocks.materials.toFixed(0)} parts ${stocks.parts.toFixed(0)} power ${c.power.supplyKw}/${c.power.demandKw} dead ${c.colonists.dead} buildings ${c.buildings.length}`);
  }
  await new Promise((r) => setTimeout(r, 40));
}
await post({ type: "colony.set_speed", speed: 1 });
const c = await state();
for (const l of log) console.log("  " + l);
console.log(`END sol ${c.sol}: awake ${c.colonists.awake}, dead ${c.colonists.dead}, first wake sol ${firstWake}, buildings ${c.buildings.map((b) => b.type).join(",")}`);
