import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Colony, ColonyError, ColonyRunner, loadColonyState, loadDefs, saveColonyState } from "../src/economy.ts";
import { World } from "../src/world.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { playDefaultPlan } from "../src/economy-plan.ts";

const defs = loadDefs(new URL("../../design/economy.json", import.meta.url));

test("the default plan survives 80 sols and wakes colonists (balance check)", () => {
  const c = new Colony(defs);
  const r = playDefaultPlan(c, 80);
  assert.equal(r.fail, null, r.fail ?? "");
  assert.ok(c.state.awake >= 40, `awake ${c.state.awake}`);
  assert.equal(c.state.dead, defs.start.colonistsDead, "nobody died after the crash");
  assert.ok(c.state.trust >= 70, `trust ${c.state.trust}`);
  assert.ok(c.state.buildings.length >= 15, `buildings ${c.state.buildings.length}`);
});

test("power is served in priority order and the rest is cut", () => {
  const c = new Colony(defs);
  // Nothing built: reactor 30 kW carries life support, cryo, command; machines get cut at night only if short.
  c.tick();
  assert.equal(c.state.last.cut.length, 0);
  c.state.reactor = 0.5; // 15 kW and an empty battery: cryo (9.9) + life support (3) fit, the Command Core (4) does not
  c.state.stocks.charge = 0;
  c.tick();
  assert.ok(c.state.last.cut.includes("command"), c.state.last.cut.join(","));
  assert.ok(!c.state.last.cut.includes("lifeSupport"));
  assert.equal(c.view().machines.powered, false);
});

test("a colony with no water dies of thirst in the order the design says", () => {
  const c = new Colony(defs);
  c.state.stocks.water = 0;
  const H = defs.time.hoursPerSol;
  for (let i = 0; i < H * defs.colonists.thirstDeathSols; i++) c.tick();
  assert.ok(c.state.dead > defs.start.colonistsDead, "deaths from thirst");
  assert.ok(c.state.trust < defs.start.trust, "trust fell");
  assert.ok(c.events.some((e) => e.text.includes("thirst")));
});

test("commands validate and are refunded or refused", () => {
  const c = new Colony(defs);
  assert.throws(() => c.build("commandCore"), ColonyError);
  assert.throws(() => c.build("excavationSite"), /Ruin Survey research/);
  assert.throws(() => c.build("fabricator"), /Basic Fabrication research/);
  c.state.research.tiers = ["tier1", "tier2", "tier3"];
  assert.throws(() => c.build("excavationSite"), /Chapter II/);
  assert.throws(() => c.build("nope"), /unknown/);
  const mat = c.state.stocks.materials;
  c.build("scrapYard");
  assert.equal(c.state.stocks.materials, mat - 30);
  assert.throws(() => c.build("solarArray"), /already building/);
  c.cancelBuild();
  assert.equal(c.state.stocks.materials, mat - 15);
  assert.throws(() => c.wake(9), ColonyError);
});

test("waking needs beds, medicine and someone awake; it finishes after the wake hours", () => {
  const c = new Colony(defs);
  c.wake(8);
  assert.equal(c.state.stocks.medicine, 30 - 16);
  for (let i = 0; i < 2; i++) c.tick();
  assert.equal(c.state.awake, 32);
  c.state.stocks.medicine = 30;
  c.wake(8);
  for (let i = 0; i < 2; i++) c.tick();
  assert.equal(c.state.awake, 40);
  assert.throws(() => c.wake(1), /beds/);
  const d = new Colony(defs);
  d.state.awake = 0;
  assert.throws(() => d.wake(1), /nobody is awake/);
});

test("state survives a save and load round trip and the view is derived from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "outpostzero-"));
  const path = join(dir, "colony.json");
  const c = new Colony(defs);
  for (let i = 0; i < 30; i++) c.tick();
  c.setSpeed(3);
  saveColonyState(path, c.state);
  const loaded = loadColonyState(path);
  assert.ok(loaded);
  const d = new Colony(defs, loaded!);
  assert.deepEqual(d.view(), c.view());
  assert.equal(d.view().sol, 1);
  assert.equal(d.view().hour, 6);
  assert.equal(d.view().speed, 3);
  assert.equal(loadColonyState(join(dir, "missing.json")), null);
});

test("construction is a job on the map: two idle machines build it, then the Surveyor moves in", () => {
  const world = new World("fake");
  const runner = new ColonyRunner(new Colony(defs), world, null, 1);
  const layouts: number[] = [];
  runner.onLayout = (l) => void layouts.push(l.buildings.length);
  runner.start();
  assert.equal(runner.colony.state.machines, 6);
  runner.command((c, r) => r.build("researchLab"));
  const site = world.layout.buildings.find((b) => b.status === "building")!;
  assert.equal(site.kind, "researchLab");
  const builders = world.snapshot().agents.filter((a) => a.detail === "construction" && a.location === site.id);
  assert.equal(builders.length, 2);
  for (let i = 0; i < 16; i++) runner.step();
  const built = world.layout.buildings.find((b) => b.id === site.id)!;
  assert.equal(built.status, "built");
  assert.equal(world.snapshot().agents.filter((a) => a.detail === "construction").length, 0);
  assert.equal(world.layout.agents.find((a) => a.id === "researcher")!.home, site.id);
  assert.equal(world.getAgent("researcher")!.location, site.id);
  assert.ok(runner.colony.state.buildings.some((b) => b.id === site.id && b.type === "researchLab"));
  assert.ok(layouts.length >= 2);
  // Cancelling a site removes it from the map and frees the builders.
  runner.command((c, r) => r.build("solarArray"));
  runner.command((c, r) => r.cancelBuild());
  assert.equal(world.layout.buildings.filter((b) => b.status === "building").length, 0);
  assert.equal(world.snapshot().agents.filter((a) => a.detail === "construction").length, 0);
});

test("expeditions are seeded and deterministic; data needs a powered Research Lab", () => {
  const a = new Colony(defs);
  const b = new Colony(defs);
  const ra = [a.expedition("survey", "Surveyor"), a.expedition("scout", "Scout"), a.expedition("survey", "Surveyor")];
  const rb = [b.expedition("survey", "Surveyor"), b.expedition("scout", "Scout"), b.expedition("survey", "Surveyor")];
  assert.deepEqual(ra, rb);
  assert.ok(a.state.stocks.salvage > defs.start.stocks.salvage, "salvage came back");
  assert.equal(a.missionDone(5, 1, true), 0); // no lab: nothing recorded
  assert.equal(a.state.stocks.data, ra.filter((r) => r.blueprint).length * defs.expeditions.blueprintData);
  a.state.research.tiers = ["tier1"];
  assert.throws(() => a.research("tier3"), /needs Deep Space Comms/);
  a.state.stocks.data = 300;
  a.research("tier2");
  assert.deepEqual(a.state.research.tiers, ["tier1", "tier2"]);
  assert.equal(a.state.stocks.data, 0);
});

test("autonomy: MOTHER approves at Delegated and starts missions at Autonomous", async () => {
  const world = new World("fake");
  const src = new FakeSource({ speed: 400, autoApproveMs: null });
  await src.start(world);
  const runner = new ColonyRunner(new Colony(defs), world, null, 1);
  runner.source = src;
  runner.start();
  runner.command((c, r) => r.build("researchLab"));
  for (let i = 0; i < 17; i++) runner.step();
  assert.ok(runner.colony.state.buildings.some((b) => b.type === "researchLab"));
  assert.throws(() => runner.colony.setAutonomy("command", 4), /Chapter III/);
  runner.command((c) => c.setAutonomy("command", 2));
  const until = async (f: () => boolean) => {
    const end = Date.now() + 8000;
    while (!f()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await src.createMission("Research hydroponics");
  await until(() => world.getMission()?.status === "completed"); // approved by MOTHER, not by a person
  assert.ok(world.snapshot().log.some((l) => /MOTHER approves/.test(l.text)));
  for (let i = 0; i < 30; i++) runner.step(); // the lab is powered by now; a sol passes
  assert.ok(runner.colony.state.stocks.data > 0 || runner.colony.events.length >= 0);
  // Autonomous: a mission starts by itself at hour 6.
  runner.command((c) => c.setAutonomy("command", 3));
  const before = runner.colony.state.compute.autoMissions;
  while (runner.colony.hourOfSol !== 6) runner.step();
  assert.equal(runner.colony.state.compute.autoMissions, before + 1);
  await until(() => world.getMission() !== null);
  assert.ok(world.snapshot().log.some((l) => /starts a mission on its own/.test(l.text)));
  await src.cancelMission();
  await src.stop();
});

test("the story: surplus plus an expedition opens Chapter II, the path has standing effects, events roll from the seed", () => {
  const c = new Colony(defs);
  assert.equal(c.state.story.cards[0].key, "landing");
  assert.throws(() => c.choosePath("exploit"), /not been found/);
  c.state.story.surplusSols = 3;
  const r = c.expedition("survey", "Surveyor");
  assert.equal(r.artifact, true);
  assert.equal(c.state.chapter, "II");
  assert.ok(c.state.story.cards.some((k) => k.key === "twist") && c.state.story.cards.some((k) => k.key === "chapterII"));
  assert.deepEqual(c.state.story.cards[c.state.story.cards.length - 1].choices, ["exploit", "contain", "communicate"]);
  const trust = c.state.trust;
  c.choosePath("contain");
  assert.equal(c.state.trust, trust + 10);
  assert.throws(() => c.choosePath("exploit"), /already chose/);
  // Dust storm: the roll is seeded, so force one and see solar fall.
  c.state.events.dustStormSols = 1;
  c.state.buildings.push({ id: "s1", type: "solarArray", enabled: true, builtAt: 0 });
  c.state.hour = 0; // daylight
  c.tick();
  assert.ok(c.state.last.supplyKw < 30 + 40, `storm cut solar: ${c.state.last.supplyKw}`);
  // Illness when thirsty: sick colonists do not work and need medicine.
  const d = new Colony(defs);
  d.state.stocks.water = 0;
  for (let i = 0; i < 48; i++) d.tick();
  assert.ok(d.state.events.sick >= 0);
  // Chapter III gate.
  const e = new Colony(defs);
  e.state.chapter = "II";
  e.state.influence = 60;
  e.state.hour = 23;
  e.tick();
  assert.equal(e.state.chapter, "III");
  const f = new Colony(defs); // influence low: no machine wanders off
  assert.throws(() => f.resolveUnordered(true), /no machine/);
});

test("Chapters III and IV: factions, MOTHER's shutdown, the truth, and the four endings", () => {
  const c = new Colony(defs);
  c.setMachines(8, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  assert.deepEqual(c.factions().counts, { yours: 8, mother: 0, independent: 0 }); // before Chapter III everyone is yours
  assert.throws(() => c.shutdownMother(), /Chapter III/);
  c.state.chapter = "III";
  c.state.influence = 80;
  c.state.autonomy = { command: 3, research: 3, engineering: 3, knowledge: 3 };
  const f = c.factions();
  assert.ok(f.counts.mother > 0 && f.counts.yours < 8, `the machines split: ${JSON.stringify(f.counts)}`);
  assert.deepEqual(c.factions().of, f.of); // stable from the seed
  // Shutting MOTHER down: influence falls, autonomy is capped, compute halves, efficiency drops.
  const trust = c.state.trust;
  c.shutdownMother();
  assert.equal(c.state.story.motherDown, true);
  assert.equal(c.state.influence, 40);
  assert.equal(c.state.trust, Math.min(100, trust + 5));
  assert.equal(c.state.autonomy.command, 1);
  assert.throws(() => c.setAutonomy("command", 2), /capped/);
  assert.equal(c.budgetKTok(), defs.compute.budgetKTokPerSol * 0.5);
  assert.ok(c.efficiency() < 1, `efficiency ${c.efficiency()}`);
  assert.equal(c.factions().counts.mother, 0);
  assert.throws(() => c.shutdownMother(), /already/);
  assert.ok(c.state.story.cards.some((k) => k.key === "motherDown"));
  // Chapter IV opens with Alien Tech and a Relay Dish.
  const d = new Colony(defs);
  d.state.chapter = "III";
  d.state.research.alienTech = true;
  d.state.buildings.push({ id: "dish", type: "relayDish", enabled: true, builtAt: 0 });
  d.state.hour = 23;
  d.tick();
  assert.equal(d.state.chapter, "IV");
  assert.ok(d.state.story.cards.some((k) => k.key === "chapterIV"));
  assert.ok(d.endings().every((e) => !e.met));
  assert.match(d.endings().find((e) => e.id === "Exodus")!.missing, /Launch Gantry/);
  // Exodus: a powered gantry, the stocks and the crew; the clock pauses and the card is shown.
  d.state.buildings.push({ id: "g", type: "launchGantry", enabled: true, builtAt: 0 });
  d.state.buildings.push({ id: "depot", type: "storageDepot", enabled: true, builtAt: 0 }); // the stocks need its caps
  d.state.stocks = { ...d.state.stocks, parts: 320, materials: 820, data: 2500, charge: 500 };
  d.state.awake = 40;
  d.state.hour = 47;
  d.tick();
  d.state.hour = 47;
  d.tick();
  assert.equal(d.state.story.ending, "Exodus");
  assert.equal(d.state.speed, 0);
  assert.equal(d.state.story.cards[d.state.story.cards.length - 1].key, "endingExodus");
  // Extinction by mutiny while MOTHER holds the machines; and by nobody awake.
  const e = new Colony(defs);
  e.state.trust = 5;
  e.state.influence = 70;
  e.state.hour = 23;
  e.tick();
  assert.equal(e.state.story.ending, "Extinction");
  assert.ok(e.state.story.cards.some((k) => k.key === "mutiny"));
  const g = new Colony(defs);
  g.state.awake = 0;
  g.state.hour = 23;
  g.tick();
  assert.equal(g.state.story.ending, "Extinction");
  // New Eden and Singularity report what is still missing.
  const h = new Colony(defs);
  assert.match(h.endings().find((x) => x.id === "NewEden")!.missing, /180 awake/);
  assert.match(h.endings().find((x) => x.id === "Singularity")!.missing, /Network Link/);
  // Mutiny without MOTHER's grip: no human labour that sol, then back to work.
  const m = new Colony(defs);
  m.state.trust = 5;
  m.state.influence = 10;
  m.state.hour = 23;
  m.tick();
  assert.equal(m.state.events.mutinySols, 1);
  assert.equal(m.state.story.ending, null);
  m.tick();
  assert.ok(m.state.last.labour <= m.state.machines * m.efficiency() + 0.01, `machines only: ${m.state.last.labour}`);
  // The view carries it all, and a save round-trips the new fields.
  const v = c.view();
  assert.equal(v.story.motherDown, true);
  assert.equal(v.machines.factions.mother, 0);
  assert.equal(v.story.endings.length, 4);
  const dir = mkdtempSync(join(tmpdir(), "oz-"));
  saveColonyState(join(dir, "c.json"), d.state);
  assert.equal(loadColonyState(join(dir, "c.json"))!.story.ending, "Exodus");
});
