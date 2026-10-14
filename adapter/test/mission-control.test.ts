import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { MissionControlSink } from "../src/sinks/mission-control.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { World } from "../src/world.ts";

// Records the REST calls the sink makes, answering like Mission Control does.
async function mockMissionControl() {
  const calls: { method: string; url: string; body: any }[] = [];
  let nextTask = 100;
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const parsed = body ? JSON.parse(body) : undefined;
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/events") {
      res.setHeader("content-type", "text/event-stream");
      return; // keep open, never send
    }
    calls.push({ method: req.method!, url: req.url!, body: parsed });
    assert.ok(req.headers["x-api-key"] === "k", "api key sent");
    if (req.method === "GET" && req.url?.startsWith("/api/agents")) return res.end(JSON.stringify({ agents: [{ name: "rts-coder" }] }));
    if (req.method === "POST" && req.url === "/api/tasks") return res.end(JSON.stringify({ task: { id: nextTask++ } }));
    res.end(JSON.stringify({ success: true }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

let activeSink: MissionControlSink | null = null;

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("sink mirrors a mission into Mission Control and accepts approval from it", async () => {
  const mc = await mockMissionControl();
  try {
    const world = new World("fake");
    const src = new FakeSource({ speed: 400, autoApproveMs: null, injectError: false });
    await src.start(world);
    const approvals: [string, boolean][] = [];
    const sink = new MissionControlSink({
      url: mc.url,
      apiKey: "k",
      onApproval: (id, ok) => {
        approvals.push([id, ok]);
        void src.resolveApproval(id, ok);
      },
    });
    activeSink = sink;
    await sink.start(world);
    await sink.flush();

    // Registers the commander and the roster, skipping agents that already exist.
    const registered = mc.calls.filter((c) => c.url === "/api/agents/register").map((c) => c.body.name);
    assert.deepEqual(registered.sort(), ["rts-analyst", "rts-commander", "rts-researcher", "rts-reviewer", "rts-scout", "rts-writer"]);

    await src.createMission("Research the Australian EV market");
    await until(() => world.snapshot().approvals.some((a) => a.status === "pending"));
    await sink.flush();

    const created = mc.calls.filter((c) => c.method === "POST" && c.url === "/api/tasks").map((c) => c.body);
    assert.equal(created[0].title, "Mission: Research the Australian EV market");
    assert.equal(created[0].assigned_to, "rts-commander");
    assert.ok(created.some((t) => t.assigned_to === "rts-researcher"));
    assert.match(world.getMission()!.link ?? "", /\/tasks\?taskId=100$/);

    // Steps reach "done" through an Aegis quality review, never a direct PUT.
    assert.ok(mc.calls.some((c) => c.url === "/api/quality-review" && c.body.reviewer === "aegis"));
    assert.ok(!mc.calls.some((c) => c.method === "PUT" && c.body?.status === "done"));

    // The approval checkpoint is in review; approving it in MC resolves it in the game.
    const reviewPut = mc.calls.find((c) => c.method === "PUT" && c.body?.status === "review");
    assert.ok(reviewPut, "approval task moved to review");
    const approvalTaskId = Number(reviewPut!.url.split("/").pop());
    sink.onEvent(JSON.stringify({ type: "task.status_changed", data: { id: approvalTaskId, status: "done" } }));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0][1], true);
    await until(() => world.getMission()?.status === "completed");
    await sink.flush();

    // Our own echoes are ignored.
    sink.onEvent(JSON.stringify({ type: "task.status_changed", data: { id: approvalTaskId, status: "done" } }));
    assert.equal(approvals.length, 1);

    assert.ok(mc.calls.some((c) => c.url === "/api/hermes/events" && c.body.event === "mission:complete"));
    assert.ok(mc.calls.some((c) => c.url === "/api/tokens" && c.body.inputTokens > 0));
    assert.ok(mc.calls.some((c) => c.method === "PUT" && c.url === "/api/agents" && c.body.status === "busy"));
    sink.stop();
    await src.stop();
  } finally {
    activeSink?.stop(); // stop the SSE reconnect loop even when an assertion failed
    mc.close();
  }
});
