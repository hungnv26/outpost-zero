import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Base } from "../src/base.ts";
import type { ServerMessage } from "../src/contract.ts";
import { buildingForTool, cloneLayout, DEFAULT_LAYOUT, DEPARTMENTS, DISTRICTS, departmentOf, LayoutError, loadLayout, organiseLayout, upsertAgent, upsertBuilding } from "../src/layout.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { HermesSource } from "../src/sources/hermes.ts";
import { World } from "../src/world.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "outpostzero-"));
  const path = join(dir, "base.json");
  const world = new World("fake", Date.now, loadLayout(path));
  const src = new FakeSource({ speed: 400, autoApproveMs: null });
  const base = new Base(world, src, path);
  const msgs: ServerMessage[] = [];
  world.on("message", (m: ServerMessage) => msgs.push(m));
  return { world, src, base, path, msgs };
}

test("placing a building validates position and saves the base", async () => {
  const { world, base, path, msgs } = setup();
  await src_start(world);
  await base.apply({ type: "layout.building.upsert", building: { label: "Data Mine", x: 28.7, z: 16.2, model: "hangar_smallA", color: "#aabbcc", capability: "code" } });
  const b = world.layout.buildings.find((x) => x.label === "Data Mine")!;
  assert.equal(b.id, "data_mine");
  assert.equal(b.x, 28.5); // snapped to the half-unit grid
  assert.equal(b.z, 16);
  assert.ok(msgs.some((m) => m.type === "layout.update"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).buildings.length, DEFAULT_LAYOUT.buildings.length + 1);

  await assert.rejects(
    base.apply({ type: "layout.building.upsert", building: { label: "Too close", x: 18, z: 21 } }),
    /Too close to Command Centre/,
  );
  await assert.rejects(base.apply({ type: "layout.building.remove", id: "command_centre" }), /can be moved but not removed/);
});

async function src_start(world: World) {
  /* the fake source needs no setup for layout tests */
  void world;
}

test("custom characters join the world and get a turn in missions", async () => {
  const { world, base, src, msgs } = setup();
  await src.start(world);
  await base.apply({ type: "layout.agent.upsert", agent: { name: "Market Watcher", job: "Tracks competitor pricing and product launches.", skill: "web", model: "craft_speederC", color: "#33ccaa", home: "research_lab" } });
  const a = world.layout.agents.find((x) => x.name === "Market Watcher")!;
  assert.equal(a.id, "market_watcher");
  assert.equal(a.hermesId, "rts_market_watcher");
  assert.equal(world.getAgent("market_watcher")?.state, "idle");

  await src.createMission("x");
  await assert.rejects(base.apply({ type: "layout.reset" }), /Finish or abort/);
  const until = async (c: () => boolean) => {
    const end = Date.now() + 5000;
    while (!c()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(() => world.snapshot().approvals.some((p) => p.status === "pending"));
  assert.ok(msgs.some((m) => m.type === "agent.state" && m.agent.id === "market_watcher" && m.agent.location === "research_lab"));
  await src.resolveApproval(world.snapshot().approvals[0].id, true);
  await until(() => world.getMission()?.status === "completed");
  await src.stop();

  await base.apply({ type: "layout.agent.remove", id: "market_watcher" });
  assert.equal(world.getAgent("market_watcher"), undefined);
  assert.ok(msgs.some((m) => m.type === "agent.removed" && m.agentId === "market_watcher"));
  await assert.rejects(base.apply({ type: "layout.agent.remove", id: "commander" }), /core team/);
});

test("removing a building sends its agents home and reroutes tools", () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  assert.equal(buildingForTool(l, "web_search"), "research_lab");
  l.buildings = l.buildings.filter((b) => b.id !== "research_lab");
  assert.equal(buildingForTool(l, "web_search"), null);
  upsertBuilding(l, { label: "Observatory", x: 6, z: 8, capability: "research" });
  assert.equal(buildingForTool(l, "web_search"), "observatory");
  assert.throws(() => upsertBuilding(l, { label: "" }), LayoutError);
});

test("Hermes source creates and deletes sub-agents for custom characters", async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  let agents: any[] = [{ id: "jarvis", model: "agentrts-qwen3", parent_id: null }, { id: "rts_old_one", parent_id: "jarvis" }];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify(agents));
    if (req.method === "DELETE") agents = agents.filter((a) => `/api/subagents/${a.id}` !== req.url);
    res.end("{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  try {
    const world = new World("hermes");
    const src = new HermesSource({ baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token: "t" });
    await src.start(world);
    const l = cloneLayout(world.layout);
    l.agents.push({ id: "watcher", name: "Watcher", hermesId: "rts_watcher", job: "Watches things closely.", skill: "web", model: "rover", color: "#ffffff", home: "research_lab" });
    await src.layoutChanged(l);
    const created = calls.find((c) => c.method === "POST" && c.body?.id === "rts_watcher")!;
    assert.equal(created.body.parent_id, "jarvis");
    assert.equal(created.body.skills, "web_search");
    assert.equal(created.body.model, "agentrts-qwen3");
    assert.match(created.body.system_prompt, /You are Watcher\. Watches things closely\./);
    assert.ok(calls.some((c) => c.method === "DELETE" && c.url === "/api/subagents/rts_old_one"));
  } finally {
    http.close();
  }
});

test("terrain is part of the base and can change during a mission", async () => {
  const { world, base, src, path } = setup();
  await src.start(world);
  assert.equal(world.layout.terrain, "mars");
  await src.createMission("x");
  await base.apply({ type: "layout.terrain", terrain: "europa" });
  assert.equal(world.layout.terrain, "europa");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).terrain, "europa");
  await assert.rejects(base.apply({ type: "layout.terrain", terrain: "pluto" }), /Unknown terrain/);
  await src.stop();
});

test("the base holds up to 32 buildings, 4.5 apart", () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  let n = 0;
  for (let z = 2; z <= l.size - 2; z += 0.5) {
    for (let x = 2; x <= l.size - 2; x += 0.5) {
      if (l.buildings.length >= 32) break;
      try {
        upsertBuilding(l, { label: `Block ${n++}`, x, z, model: "Rocket" });
      } catch (e) {
        if (!(e instanceof LayoutError) || !/Too close|at most/.test(e.message)) throw e;
      }
    }
  }
  assert.equal(l.buildings.length, 32);
  assert.throws(() => upsertBuilding(l, { label: "One more", x: 5, z: 5 }), /at most 32/);
});

test("up to 24 custom characters on top of the built-ins", () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  for (let i = 0; i < 24; i++) upsertAgent(l, { name: `Helper ${i}`, job: "Helps the team with one small task." });
  assert.equal(l.agents.filter((a) => !a.builtin).length, 24);
  assert.throws(() => upsertAgent(l, { name: "One more", job: "Helps the team with one small task." }), /At most 24/);
});

// District of a map position (3x3 grid of ~10-unit cells).
function districtAt(x: number, z: number) {
  const cell = (v: number) => Math.min(2, Math.max(0, Math.floor((v - 1) / 14)));
  return DISTRICTS[cell(z)][cell(x)];
}

test("organise puts every building in its department's district, in department colours", () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  const caps = ["research", "code", "knowledge", "meeting"] as const;
  for (let i = 0; i < 20; i++) upsertBuilding(l, { label: `B${i}`, capability: caps[i % 4] });
  l.buildings.forEach((b, i) => Object.assign(b, { x: (i * 7) % 40 + 2, z: (i * 11) % 40 + 2, color: "#000000" })); // scramble
  organiseLayout(l);
  for (const b of l.buildings) {
    assert.equal(districtAt(b.x, b.z), departmentOf(b.capability), `${b.label} at ${b.x},${b.z}`);
    assert.equal(b.color, DEPARTMENTS[departmentOf(b.capability)].color);
  }
});

test("a new building without a position drops into its district; tools prefer the agent's own building", () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  const b = upsertBuilding(l, { label: "Market Desk", capability: "research" });
  assert.equal(districtAt(b.x, b.z), "research");
  upsertAgent(l, { name: "Watcher", job: "Watches the market for changes.", skill: "web", home: b.id });
  assert.equal(buildingForTool(l, "web_search", "watcher"), b.id);
  assert.equal(buildingForTool(l, "web_search", "researcher"), "research_lab");
});
