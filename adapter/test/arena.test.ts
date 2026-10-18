import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Arena, battlefieldFrom, colonyValue } from "../src/arena.ts";
import { startArenaServer } from "../src/arena-server.ts";
import { readFileSync } from "node:fs";
import { Colony, ColonyRunner, conditionsFrom, loadDefs } from "../src/economy.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { World } from "../src/world.ts";

const defs = loadDefs(new URL("../../design/economy.json", import.meta.url));

async function setup() {
  const world = new World("fake");
  const src = new FakeSource({ speed: 400, autoApproveMs: null });
  await src.start(world);
  const runner = new ColonyRunner(new Colony(defs), world, null, 1);
  runner.source = src;
  runner.start();
  const arena = new Arena(runner, world);
  return { world, src, runner, arena };
}

test("the referee validates actions, enforces the hourly window and the budget, and scores", async () => {
  const { runner, arena } = await setup();
  assert.equal(arena.action("colony_build", { type: "waterExtractor" }).ok, false); // no match yet
  const m = arena.start({ mode: "timed", sols: 2, tokenBudget: 50_000, actionsPerHour: 3, model: "test" });
  assert.equal(m.status, "running");
  assert.equal(runner.colony.state.awake, 24, "a fresh colony from the seed");
  assert.equal(arena.action("colony_state").ok, true);
  assert.equal(arena.action("colony_build", { type: "waterExtractor" }).ok, true);
  const bad = arena.action("colony_build", { type: "solarArray" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /already building/);
  assert.equal(arena.action("colony_note", { text: "water first" }).ok, true);
  assert.equal(arena.action("colony_wake", { count: 8 }).ok, true);
  const over = arena.action("colony_note", { text: "one more" });
  assert.equal(over.ok, false);
  assert.match(over.reason!, /3 actions per game hour/);
  runner.step(); // a new hour resets the window
  assert.equal(arena.action("colony_note", { text: "new hour" }).ok, true);
  assert.equal(arena.action("colony_nope", {}).ok, false);
  const obs = arena.observation() as any;
  assert.equal(obs.budget.actionsLeftThisHour, 2);
  assert.ok(obs.site && obs.site.type === "waterExtractor");
  assert.equal(obs.scoreboard[0].team, "A");
  // Budget: spending past the limit freezes the team.
  runner.command((c) => c.useCompute(60_000));
  assert.equal(arena.match!.frozen, true);
  assert.match(arena.action("colony_note", { text: "x" }).reason!, /frozen/);
  // Timed: the match ends after its sols with a value.
  let valueAtEnd = -1;
  arena.once("finished", () => (valueAtEnd = colonyValue(runner.colony)));
  for (let i = 0; i < 48 && arena.match!.status === "running"; i++) runner.step();
  assert.equal(arena.match!.status, "finished");
  const r = arena.match!.result!;
  assert.equal(r.winner, "A");
  assert.equal(r.placings[0].value, valueAtEnd);
  assert.ok(r.placings[0].actions >= 4 && r.placings[0].rejected >= 3);
  assert.ok(r.placings[0].tokens >= 60_000);
});

test("race mode ends on the objective", async () => {
  const { runner, arena } = await setup();
  arena.start({ mode: "race", objective: "awakening", sols: 5 });
  runner.colony.state.awake = 100; // reached
  runner.step();
  assert.equal(arena.match!.status, "finished");
  assert.match(arena.match!.result!.reason, /Awakening/);
});

test("the arena API needs the token and serves observations and actions", async () => {
  const { arena } = await setup();
  arena.start({ mode: "timed", sols: 3 });
  const http = await startArenaServer(arena, 0, "secret", "127.0.0.1");
  const port = (http.address() as AddressInfo).port;
  try {
    const noToken = await fetch(`http://127.0.0.1:${port}/arena/A/observation`);
    assert.equal(noToken.status, 403);
    const obs = await fetch(`http://127.0.0.1:${port}/arena/A/observation`, { headers: { "x-arena-token": "secret" } });
    assert.equal(obs.status, 200);
    assert.equal(((await obs.json()) as any).match.mode, "timed");
    const act = await fetch(`http://127.0.0.1:${port}/arena/A/action`, { method: "POST", headers: { "x-arena-token": "secret", "content-type": "application/json" }, body: JSON.stringify({ tool: "colony_build", args: { type: "scrapYard" } }) });
    assert.equal(act.status, 200);
    const state = await fetch(`http://127.0.0.1:${port}/arena/A/action`, { method: "POST", headers: { "x-arena-token": "secret", "content-type": "application/json" }, body: JSON.stringify({ tool: "colony_state" }) });
    assert.ok(((await state.json()) as any).observation.site.type === "scrapYard");
  } finally {
    http.close();
  }
});

test("the match map places the teams' bases on opposite sides and the window learns them", async () => {
  const { arena, world } = await setup();
  arena.start({ mode: "timed", sols: 2 });
  const bases = [
    { team: "A", origin: { x: 0, z: 0 }, ws: "ws://127.0.0.1:8771/world" },
    { team: "B", origin: { x: 80, z: 0 }, ws: "ws://127.0.0.1:8781/world" },
  ];
  arena.setScoreboard([{ team: "B", model: "x", value: 1, awake: 24, tokens: 0, avgLatencyS: null, status: "running" }], bases, "duel");
  const info = arena.info()!;
  assert.equal(info.map, "duel");
  assert.deepEqual(info.bases.map((b) => [b.team, b.origin.x]), [["A", 0], ["B", 80]]);
  assert.equal(world.snapshot().arena?.bases.length, 2);
});

test("the ten battlefields: valid, mirrored, and their conditions change the colony for every team alike", async () => {
  const maps = JSON.parse(readFileSync(new URL("../../design/maps.json", import.meta.url), "utf8"));
  const ids = Object.keys(maps.battlefields);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids.map((id) => maps.battlefields[id].terrain)).size, 10, "one terrain per battlefield");
  for (const id of ids) {
    const raw = maps.battlefields[id];
    const b = battlefieldFrom({ id, ...raw })!;
    assert.ok(b, id);
    assert.equal(b.structures.length, raw.structures.length, `${id}: every structure survives the check`);
    assert.equal(b.obstacles.length, raw.obstacles.length, `${id}: every obstacle survives the check`);
    // Nothing stands inside a base (44 x 44, walls at the edge).
    for (const it of [...b.structures, ...b.obstacles]) {
      for (const [bx, bz] of Object.values(raw.bases) as [number, number][]) {
        assert.ok(!(it.x > bx && it.x < bx + 44 && it.z > bz && it.z < bz + 44), `${id}: ${it.kind} at ${it.x},${it.z} is inside a base`);
      }
    }
  }
  // Bad input is dropped, not trusted.
  assert.equal(battlefieldFrom({ terrain: "nowhere" }), undefined);
  assert.equal(battlefieldFrom({ terrain: "moon", structures: [{ kind: "nuke", x: 1, z: 1 }, { kind: "wreck", x: "a", z: 1 }] })!.structures.length, 0);
  assert.deepEqual(conditionsFrom({ solar: 9, water: -1, storms: "x" }), { solar: 2, water: 0.25, salvage: 1, storms: 1 });

  // The same seed on a bright, dry map against a dark, wet one: more power, less water.
  const run = async (id: string) => {
    const { arena, runner } = await setup();
    arena.start({ mode: "timed", sols: 5, seed: 99, battlefield: { id, ...maps.battlefields[id] } as never });
    assert.deepEqual(runner.colony.view().conditions, conditionsFrom(maps.battlefields[id].conditions));
    assert.equal(arena.info()!.battlefield!.id, id);
    assert.equal(arena.info()!.map, id);
    assert.ok((arena.observation().match as { battlefield: { name: string } }).battlefield.name);
    runner.colony.state.buildings.push({ id: "test-solar", type: "solarArray", enabled: true, builtAt: 0 }, { id: "test-water", type: "waterExtractor", enabled: true, builtAt: 0 });
    let solar = 0;
    for (let h = 0; h < 48; h++) {
      runner.colony.tick();
      solar = Math.max(solar, runner.colony.view().power.supplyKw);
    }
    arena.stop();
    return { solar, water: runner.colony.state.stocks.water };
  };
  const bright = await run("glass-dunes"); // solar 1.25, water 0.75
  const dark = await run("fracture-ice"); // solar 0.7, water 1.4
  assert.ok(bright.solar > dark.solar, `solar ${bright.solar} > ${dark.solar}`);
  assert.ok(dark.water > bright.water, `water ${dark.water} > ${bright.water}`);
});

test("a sprint starts every team from the crash site and ends on 44 awake; every window shows the winner", async () => {
  const { arena, runner, world } = await setup();
  // A base with extra buildings from earlier play goes back to the crash site.
  runner.colony.state.buildings.push({ id: "old-hydro", type: "hydroponics", enabled: true, builtAt: 0 });
  world.applyLayout({ ...world.layout, buildings: [...world.layout.buildings, { id: "old-hydro", label: "Hydroponics Bay", x: 6, z: 6, model: "GeodesicDome", color: "#fff", capability: "knowledge", kind: "hydroponics", status: "built" } as never] });
  arena.start({ mode: "race", objective: "sprint", sols: 10 });
  assert.ok(!world.layout.buildings.some((b) => b.id === "old-hydro"), "extra buildings removed at match start");
  assert.ok(!runner.colony.state.buildings.some((b) => b.type === "hydroponics"), "the colony starts without them");
  assert.equal(arena.info()!.objectiveText, "first to 44 colonists awake, nobody hungry or thirsty");
  runner.colony.state.awake = 44;
  runner.colony.tick();
  (runner as unknown as { publish(): void }).publish();
  assert.equal(arena.match!.status, "finished");
  assert.equal(arena.match!.result!.winner, "A");
  // The losing team's window learns the real winner from the director.
  const other = await setup();
  other.arena.start({ mode: "race", objective: "sprint", sols: 10, team: "B" });
  other.arena.stop("stopped by request");
  other.arena.setScoreboard([], undefined, undefined, { winner: "A", reason: "Sprint: first to 44 colonists awake" });
  assert.deepEqual(other.arena.info()!.result, { winner: "A", reason: "Sprint: first to 44 colonists awake" });
});

test("lifeline: the race ends when water, food, power, materials and medicine all run at home", async () => {
  const { arena, runner } = await setup();
  arena.start({ mode: "race", objective: "lifeline", sols: 10 });
  const types = ["waterExtractor", "hydroponics", "solarArray", "scrapYard"];
  for (const t of types) runner.colony.state.buildings.push({ id: `t-${t}`, type: t, enabled: true, builtAt: 0 });
  runner.colony.tick();
  (runner as unknown as { publish(): void }).publish();
  assert.equal(arena.match!.status, "running", "four of five is not enough");
  runner.colony.state.buildings.push({ id: "t-med", type: "medBay", enabled: true, builtAt: 0 });
  runner.colony.tick();
  (runner as unknown as { publish(): void }).publish();
  assert.equal(arena.match!.status, "finished");
  assert.equal(arena.match!.result!.winner, "A");
});

test("real token counts from the key gateway replace Hermes' estimates and drive the budget", async () => {
  const { arena, runner } = await setup();
  arena.start({ mode: "race", objective: "lifeline", sols: 10, tokenBudget: 20_000 });
  // Before any report, the Governor's estimate counts.
  arena.roundEnded({ text: "", tokens: 1_000, latencyS: 1, timedOut: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(arena.tokensUsed(), 1_000);
  // The provider's real count arrives: it is charged, and estimates stop counting.
  arena.providerUsage(15_000);
  arena.roundEnded({ text: "", tokens: 9_000, latencyS: 1, timedOut: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(arena.tokensUsed(), 16_000);
  assert.equal(runner.realTokens, true);
  // Past the budget the team freezes on the next game hour.
  arena.providerUsage(5_000);
  await new Promise((r) => setTimeout(r, 20));
  runner.colony.tick();
  (runner as unknown as { publish(): void }).publish();
  assert.equal(arena.match!.frozen, true);
  // Bad reports are ignored; a new match starts on estimates again.
  arena.providerUsage(Number.NaN);
  arena.stop();
  arena.start({ mode: "race", objective: "lifeline", sols: 10 });
  assert.equal(runner.realTokens, false);
});
