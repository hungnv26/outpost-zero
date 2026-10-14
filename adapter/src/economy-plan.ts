// A plain player's build order for the Outpost Zero colony, used by the balance test and by
// tools/economy_sim.mjs. Plays `sols` sols on a Colony. Not used by the game itself.
import type { Colony, ColonyState } from "./economy.ts";

export const PLAN: { b: string; when: (s: ColonyState) => boolean }[] = [
  { b: "waterExtractor", when: () => true },
  { b: "solarArray", when: () => true },
  { b: "scrapYard", when: () => true },
  { b: "hydroponics", when: () => true },
  { b: "hydroponics", when: () => true },
  { b: "waterExtractor", when: () => true },
  { b: "batteryBank", when: () => true },
  { b: "researchLab", when: () => true }, // data gates everything after this
  { b: "fabricator", when: (s) => s.stocks.materials >= 90 },
  { b: "hydroponics", when: (s) => s.awake >= 30 },
  { b: "waterExtractor", when: (s) => s.awake >= 30 },
  { b: "medBay", when: () => true },
  { b: "solarArray", when: () => true },
  { b: "storageDepot", when: () => true },
  { b: "waterExtractor", when: (s) => s.awake >= 40 },
  { b: "hydroponics", when: (s) => s.awake >= 48 },
  { b: "habitat", when: (s) => s.awake >= 40 },
  { b: "relayDish", when: () => true },
  { b: "solarArray", when: (s) => s.awake >= 60 },
  { b: "hydroponics", when: (s) => s.awake >= 64 },
  { b: "waterExtractor", when: (s) => s.awake >= 70 },
];

// Expeditions are real agent trips in the game (phase 3); here one trip a sol brings the
// average salvage, delivered through the same method the real trips will use.
export function playDefaultPlan(colony: Colony, sols: number, onSol: ((c: Colony) => void) | null = null): { fail: string | null; planIdx: number } {
  const D = colony.defs;
  const H = D.time.hoursPerSol;
  let planIdx = 0;
  let fail: string | null = null;
  const exp = (D as unknown as { expeditions?: { tripsPerSol: number; salvage: { min: number; max: number } } }).expeditions ?? { tripsPerSol: 1, salvage: { min: 30, max: 60 } };
  for (let hour = 0; hour < sols * H && !fail; hour++) {
    const s = colony.state;
    const hod = hour % H;
    const deadBefore = s.dead;
    // Build the next thing in the plan when it is affordable.
    if (!s.building && planIdx < PLAN.length) {
      const p = PLAN[planIdx];
      const d = D.buildings[p.b];
      const why = colony.blocked(p.b);
      if (why && /Chapter/.test(why)) planIdx++; // chapter-gated: the simulator never gets there
      else if (p.when(s) && !why) {
        colony.build(p.b);
        planIdx++;
      }
    }
    // The fabricator is switched off above 60 parts and on again below 40 (a player would).
    for (const b of s.buildings) {
      if (b.type !== "fabricator") continue;
      if (b.enabled && s.stocks.parts >= 60) colony.toggle(b.id, false);
      else if (!b.enabled && s.stocks.parts < 40) colony.toggle(b.id, true);
    }
    // Repair the reactor when it is worth 4 parts.
    if (s.reactor < 0.95 && s.stocks.parts >= 8) colony.repair("reactor");
    // Wake 8 when food and water production carry them, with a medicine reserve.
    const rate = (type: string, out: string) => s.buildings.filter((b) => b.type === type && b.enabled).length * (D.buildings[type].out?.[out] ?? 0) * H;
    if (hod === 0 && !s.waking && s.cryo > 0 && s.awake + 8 <= colony.beds() && rate("hydroponics", "food") > (s.awake + 8) * D.colonists.foodPerSol && rate("waterExtractor", "water") > (s.awake + 8) * D.colonists.waterPerSol + 24 && s.stocks.medicine >= 16) {
      colony.wake(8);
    }
    // The simulator has no Hermes: assume one real mission every two sols (5 steps, decent
    // quality, approved), which only counts once a powered Research Lab stands, and buy
    // research tiers as the data allows.
    if (hod === 12 && colony.sol % 2 === 0) colony.missionDone(5, 0.8, true, "an assumed mission");
    for (const [id, t] of Object.entries(D.research.tiers)) {
      const done = id === "alienTech" ? s.research.alienTech : s.research.tiers.includes(id);
      if (!done && s.stocks.data >= t.cost) {
        try {
          colony.research(id);
        } catch {
          /* needs the previous tier */
        }
      }
    }
    // Expedition salvage, spread over the sol.
    colony.deliver("salvage", (exp.tripsPerSol * (exp.salvage.min + exp.salvage.max)) / 2 / H, "expedition");
    colony.tick();
    if (colony.state.dead > deadBefore) fail = `sol ${colony.sol}: deaths (${colony.events.filter((e) => e.level === "error").map((e) => e.text).join("; ")})`;
    if (hod === H - 1 && onSol) onSol(colony);
  }
  return { fail, planIdx };
}
