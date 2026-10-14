import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Arena, colonyValue } from "../src/arena.ts";
import { startArenaServer } from "../src/arena-server.ts";
import { Colony, ColonyRunner, loadDefs } from "../src/economy.ts";
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
