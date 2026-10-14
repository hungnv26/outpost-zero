import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "../src/contract.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { World } from "../src/world.ts";

function collect(world: World): ServerMessage[] {
  const out: ServerMessage[] = [];
  world.on("message", (m: ServerMessage) => out.push(m));
  return out;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("fake mission visits every agent state and completes after approval", async () => {
  const world = new World("fake");
  const msgs = collect(world);
  const src = new FakeSource({ speed: 400, autoApproveMs: null });
  await src.start(world);
  await src.createMission("Research the Australian EV market");

  await until(() => world.snapshot().approvals.some((a) => a.status === "pending"));
  const reviewer = world.getAgent("reviewer")!;
  assert.equal(reviewer.state, "approval");
  assert.equal(reviewer.location, "human_approval");

  const approval = world.snapshot().approvals[0];
  await src.resolveApproval(approval.id, true);
  await until(() => world.getMission()?.status === "completed");
  await until(() => world.snapshot().agents.every((a) => a.state === "idle"));

  const states = new Set(msgs.filter((m) => m.type === "agent.state").map((m) => (m.type === "agent.state" ? m.agent.state : "")));
  for (const s of ["thinking", "working", "waiting", "approval", "error", "complete", "idle"]) assert.ok(states.has(s as never), `missing state ${s}`);

  const locations = new Set(msgs.flatMap((m) => (m.type === "agent.state" ? [m.agent.location] : [])));
  for (const l of ["command_centre", "research_lab", "code_factory", "knowledge_library", "human_approval", "rally_point", "repair_bay"])
    assert.ok(locations.has(l as never), `missing location ${l}`);

  // seq is strictly increasing
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].seq > msgs[i - 1].seq);
  assert.ok(world.snapshot().resources.tokensUsed > 0);
  assert.ok(world.snapshot().tasks.every((t) => t.status === "done"));

  // the finished mission is remembered with its task count
  const h = world.snapshot().history;
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "completed");
  assert.ok(h[0].tasksTotal > 0 && h[0].tasksDone === h[0].tasksTotal);
});

test("rejecting the approval fails the mission", async () => {
  const world = new World("fake");
  const src = new FakeSource({ speed: 400, autoApproveMs: null, injectError: false });
  await src.start(world);
  await src.createMission("x");
  await until(() => world.snapshot().approvals.some((a) => a.status === "pending"));
  await src.resolveApproval(world.snapshot().approvals[0].id, false);
  await until(() => world.getMission()?.status === "failed");
});

test("cancel resets agents and marks mission cancelled", async () => {
  const world = new World("fake");
  const src = new FakeSource({ speed: 50, autoApproveMs: null });
  await src.start(world);
  await src.createMission("x");
  await until(() => world.getAgent("researcher")!.state === "working");
  await src.cancelMission();
  assert.equal(world.getMission()?.status, "cancelled");
  // Idle agents wait at their home building.
  assert.ok(world.snapshot().agents.every((a) => a.state === "idle"));
  assert.equal(world.getAgent("researcher")!.location, "research_lab");
  assert.equal(world.getAgent("commander")!.location, "command_centre");
});

test("missions are recorded for replay, including the walk home", async () => {
  const world = new World("fake");
  const src = new FakeSource({ speed: 400, autoApproveMs: null, injectError: false });
  await src.start(world);
  await src.createMission("Replay me");
  await until(() => world.snapshot().approvals.some((a) => a.status === "pending"));
  await src.resolveApproval(world.snapshot().approvals[0].id, true);
  await until(() => world.snapshot().agents.every((a) => a.state === "idle") && world.getMission()?.status === "completed");

  const replay = world.replay()!;
  assert.equal(replay.mission.title, "Replay me");
  assert.equal(replay.mission.status, "completed");
  assert.equal(replay.agents.length, 7);
  const types = new Set(replay.events.map((e) => e.type));
  for (const t of ["agent.state", "task.upsert", "mission.upsert", "approval.upsert", "log"]) assert.ok(types.has(t as never), t);
  for (let i = 1; i < replay.events.length; i++) assert.ok(replay.events[i].ts >= replay.events[i - 1].ts);
  const last = replay.events.filter((e) => e.type === "agent.state").at(-1)!;
  assert.equal(last.type === "agent.state" && last.agent.state, "idle"); // the walk home is included
  assert.equal(world.replay(replay.mission.id), replay);
  assert.equal(world.replay("nope"), null);
});
