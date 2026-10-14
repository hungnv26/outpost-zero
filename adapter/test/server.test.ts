import assert from "node:assert/strict";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { cloneLayout, DEFAULT_LAYOUT, upsertBuilding } from "../src/layout.ts";
import { startServer } from "../src/server.ts";
import { FakeSource } from "../src/sources/fake.ts";
import { World } from "../src/world.ts";

async function serve() {
  const world = new World("fake");
  const src = new FakeSource({ speed: 400, autoApproveMs: null });
  await src.start(world);
  const http = await startServer(world, src, 0, "127.0.0.1");
  const port = (http.address() as AddressInfo).port;
  return { world, src, http, port, url: `http://127.0.0.1:${port}` };
}

test("only local tools may command the adapter", async () => {
  const { http, url } = await serve();
  try {
    const cmd = JSON.stringify({ type: "hello", client: "test" });
    const fromPage = await fetch(`${url}/command`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: cmd });
    assert.equal(fromPage.status, 403);
    const asText = await fetch(`${url}/command`, { method: "POST", headers: { "content-type": "text/plain" }, body: cmd });
    assert.equal(asText.status, 415);
    const ok = await fetch(`${url}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: cmd });
    assert.equal(ok.status, 200);
  } finally {
    http.close();
  }
});

test("a client that hangs up mid-request does not stop the adapter", async () => {
  const { http, port, url } = await serve();
  try {
    await new Promise<void>((resolve) => {
      const s = connect(port, "127.0.0.1", () => {
        s.write(`POST /command HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"type":`);
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 50);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    http.close();
  }
});

test("buildings never take a spot's id; cancelling closes pending work", async () => {
  const l = cloneLayout(DEFAULT_LAYOUT);
  const b = upsertBuilding(l, { label: "Rally Point", capability: "meeting" });
  assert.notEqual(b.id, "rally_point");

  const world = new World("fake");
  world.startMission("m1", "Test");
  world.upsertTask({ id: "t1", title: "Step", status: "running" });
  world.upsertApproval({ id: "a1", missionId: "m1", agentId: "reviewer", tool: "publish", summary: "ok?", status: "pending", createdAt: 0 });
  world.updateMission({ status: "cancelled" });
  assert.equal(world.getTask("t1")?.status, "cancelled");
  assert.equal(world.getApproval("a1")?.status, "rejected");
});
