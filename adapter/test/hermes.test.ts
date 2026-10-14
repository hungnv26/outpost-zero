import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import type { ServerMessage } from "../src/contract.ts";
import { cleanReport, HermesSource } from "../src/sources/hermes.ts";
import { buildingForTool, DEFAULT_LAYOUT } from "../src/layout.ts";
import { HermesTranslator } from "../src/sources/hermes-translator.ts";
import { World } from "../src/world.ts";

// Frames captured from a real Hermes Synapse run (qwen3 4B, chat id rts_test2),
// trimmed. Step 1 research succeeds, step 2 analyst fails, step 3 reviewer succeeds.
const FIXTURE = readFileSync(new URL("./fixtures/hermes-run2.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

function agentStates(msgs: ServerMessage[], id: string) {
  return msgs.flatMap((m) => (m.type === "agent.state" && m.agent.id === id ? [`${m.agent.state}@${m.agent.location}`] : []));
}

test("translator maps a captured Hermes run onto agent states", () => {
  const world = new World("hermes");
  const msgs: ServerMessage[] = [];
  world.on("message", (m: ServerMessage) => msgs.push(m));
  world.startMission("m1", "EV market");
  const tr = new HermesTranslator(world, "m1", "rts_test2");
  let final = null;
  for (const f of FIXTURE) final = tr.handle(f) ?? final;
  tr.finalize();

  assert.ok(final, "final answer recognised");
  assert.equal(final!.failed, false);
  assert.match(final!.content, /Search Agent Output/);

  assert.deepEqual(agentStates(msgs, "researcher").slice(0, 2), ["working@research_lab", "complete@research_lab"]);
  // The orchestrator itself is the Commander: plans, coordinates each step, writes the report.
  const commander = agentStates(msgs, "commander");
  assert.equal(commander[0], "thinking@command_centre");
  assert.ok(commander.includes("working@command_centre"));
  assert.equal(commander.at(-1), "complete@command_centre");
  assert.match(world.getAgent("commander")!.detail ?? "", /Report delivered/);
  assert.ok(agentStates(msgs, "analyst").includes("error@repair_bay"));
  assert.ok(agentStates(msgs, "reviewer").includes("working@knowledge_library"));
  assert.equal(world.getMission()?.status, "running");

  const tasks = world.snapshot().tasks;
  assert.deepEqual(
    tasks.map((t) => t.status),
    ["done", "failed", "done"],
  );
  assert.match(tasks[2].title, /Review the final summary/); // refined from the sub-agent's brief
  assert.ok(world.snapshot().resources.costUsd > 0);
  assert.ok(world.snapshot().resources.tokensUsed > 0);
});

test("translator ignores traces from other sessions", () => {
  const world = new World("hermes");
  world.startMission("m1", "x");
  const tr = new HermesTranslator(world, "m1", "rts_other");
  for (const f of FIXTURE) tr.handle(f);
  assert.equal(world.snapshot().tasks.length, 0);
  assert.ok(world.snapshot().agents.every((a) => a.state === "idle"));
});

test("tool calls move the agent to the matching building", () => {
  const world = new World("hermes");
  world.startMission("m1", "x");
  const tr = new HermesTranslator(world, "m1", "c1");
  tr.handle({ type: "trace_update", session_id: "c1", trace: { agent: "Router", action: "Route", message: "Step 1/1: Delegating to agent 'Reviewer' (reviewer)", status: "success" } });
  tr.handle({ type: "activity_log", log: { source: "Reviewer", message: `🛠️ Execution (subagent): 'web_search' with arguments {"query":"EV Council 2024 report"}` } });
  const a = world.getAgent("reviewer")!;
  assert.equal(a.location, "research_lab");
  assert.equal(a.detail, "web_search: EV Council 2024 report");
  assert.equal(buildingForTool(DEFAULT_LAYOUT, "execute_command"), "code_factory");
  assert.equal(buildingForTool(DEFAULT_LAYOUT, "search_obsidian"), "research_lab"); // "search" wins: it is a lookup
});

// Minimal stand-in for Hermes: REST endpoints the source calls + a WS that replays the fixture.
async function mockHermes() {
  const posted: any[] = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/subagents") {
      return res.end(
        JSON.stringify(
          ["jarvis", "research", "code", "analyst", "insights", "reviewer", "sysops", "football"].map((id) => ({
            id,
            name: id,
            parent_id: id === "jarvis" ? null : "jarvis",
            skills: id === "sysops" ? "shell_execution" : "web_search",
          })),
        ),
      );
    }
    if (req.method === "POST") {
      posted.push({ url: req.url, body: JSON.parse(body || "{}") });
      return res.end(JSON.stringify({ status: "success" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const wss = new WebSocketServer({ server: http, path: "/api/ws" });
  wss.on("connection", (ws, req) => {
    assert.match(req.url ?? "", /token=dev_master_token/);
    ws.on("message", async (data) => {
      const { chat_id } = JSON.parse(data.toString());
      for (const f of FIXTURE) {
        const frame = JSON.parse(JSON.stringify(f).replaceAll("rts_test2", chat_id));
        ws.send(JSON.stringify(frame));
        await new Promise((r) => setTimeout(r, 2));
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, posted, close: () => (wss.close(), http.close()) };
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("HermesSource runs a mission end to end and gates the result on approval", async () => {
  const hermes = await mockHermes();
  try {
    const world = new World("hermes");
    const src = new HermesSource({ baseUrl: hermes.url, token: "dev_master_token" });
    await src.start(world);
    const benched = hermes.posted.filter((p) => p.url === "/api/subagents").map((p) => p.body);
    assert.deepEqual(benched.map((b) => [b.id, b.parent_id, b.skills]).sort(), [
      ["analyst", "benched", "web_search"],
      ["football", "benched", "web_search"],
      ["sysops", "benched", "none"],
    ]);

    await src.createMission("Research the Australian EV market");
    assert.ok(hermes.posted.some((p) => /^\/api\/history\/rts_[0-9a-f]{8}\/agent$/.test(p.url) && p.body.agent_id === "jarvis"));

    await until(() => world.snapshot().approvals.some((a) => a.status === "pending"));
    assert.equal(world.getAgent("reviewer")!.location, "human_approval");
    assert.equal(world.getMission()!.status, "running");

    await src.resolveApproval(world.snapshot().approvals[0].id, true);
    assert.equal(world.getMission()!.status, "completed");
    assert.match(world.getMission()!.result ?? "", /Search Agent Output/);
    await src.stop();
  } finally {
    hermes.close();
  }
});

test("cleanReport drops scraped binary and keeps the text", () => {
  const raw = "# Report\n\nGood line\n%PDF-1.7 %\uFFFD\uFFFD obj\nh\uFFFD\uFFFD\uFFFD/\uFFFDQ\n\n\n\nSources: x";
  assert.equal(cleanReport(raw), "# Report\n\nGood line\n\nSources: x");
});

test("a step failure that arrives after the final answer still counts as a failure", () => {
  const world = new World("hermes");
  world.startMission("m1", "x");
  const tr = new HermesTranslator(world, "m1", "c1");
  tr.handle({ type: "trace_update", session_id: "c1", trace: { agent: "Router", action: "Route", message: "Step 1/1: Delegating to agent 'Reviewer' (reviewer)", status: "success" } });
  assert.ok(tr.handle({ type: "chat_message", role: "assistant", chat_id: "c1", content: "report" }));
  tr.handle({ type: "trace_update", session_id: "c1", trace: { agent: "Reviewer", action: "Execute", message: "Sub-agent execution failed: Apologies, Sir.", status: "error" } });
  tr.finalize();
  assert.equal(world.snapshot().tasks[0].status, "failed");
  assert.equal(world.getAgent("reviewer")!.state, "error");
});
