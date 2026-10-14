import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Colony, ColonyError, ColonyRunner, loadColonyState, loadDefs, saveColonyState } from "../src/economy.ts";
import { World } from "../src/world.ts";
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
