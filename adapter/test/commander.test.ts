import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCard } from "../src/battle/card.ts";
import { Commander, type ModelClient, type WarRpc } from "../src/battle/commander.ts";

test("the battle card names model players and a token budget", () => {
  const r = parseCard("battle:\n  map: Big Arena\n  players:\n    - blue: anthropic:claude-sonnet-5-5\n    - red: openai:gpt-5\n    - green: ollama:agentrts-qwen3\n    - purple: ai\n  budget: 250k");
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.config.players.map((p) => [p.color, p.controller, p.model ?? ""]), [
    ["blue", "model", "anthropic:claude-sonnet-5-5"],
    ["red", "model", "openai:gpt-5"],
    ["green", "model", "ollama:agentrts-qwen3"],
    ["purple", "ai", ""],
  ]);
  assert.equal(r.config.budget, 250_000);
  const bad = parseCard("battle:\n  map: Plain & Simple\n  players:\n    - blue: acme:brain\n    - red: ai\n  budget: lots");
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes('unknown provider "acme"')) && bad.errors.some((e) => e.includes("budget must be")));
});

test("a commander observes, orders, reports refusals, and stops at its budget", async () => {
  const sent: Record<string, unknown>[] = [];
  let observes = 0;
  const rpc: WarRpc = {
    async request(msg) {
      sent.push(msg);
      if (msg.type === "war.observe") {
        observes++;
        return observes === 1 ? { error: "no battle is running" } : { data: { you: "red", resources: { a: 10, b: 0 } } };
      }
      const order = msg.order as { order: string };
      return { data: order.order === "train" ? { ok: true, message: "training 2 worker" } : { ok: false, message: "vehicle_factory costs a 6, b 0" } };
    },
  };
  const prompts: string[] = [];
  const client: ModelClient = {
    async chat(model, body) {
      assert.equal(model, "openai:gpt-5");
      prompts.push(JSON.stringify(body.messages));
      return {
        tokens: 600,
        message: {
          tool_calls: [
            { function: { name: "train", arguments: '{"unit":"worker","count":2}' } },
            { function: { name: "build", arguments: '{"structure":"vehicle_factory"}' } },
            { function: { name: "attack", arguments: "not json" } },
          ],
        },
      };
    },
  };
  const c = new Commander("red", "openai:gpt-5", 1000, rpc, client, 0);
  const origSetTimeout = globalThis.setTimeout;
  // The first observe fails (still loading): skip the 2 s wait.
  globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;
  try {
    await c.start();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  const s = c.stats();
  assert.equal(s.status, "out of budget"); // 2 turns of 600 tokens pass the 1000 budget
  assert.equal(s.turns, 2);
  assert.equal(s.tokens, 1200);
  assert.equal(s.orders, 4);
  assert.equal(s.refused, 4); // 2 refused builds + 2 bad JSON
  assert.ok(prompts[1].includes("refused: vehicle_factory costs"), "the next turn sees the refusal");
  const order = sent.find((m) => m.type === "war.order") as { color: string; order: Record<string, unknown> };
  assert.deepEqual(order, { type: "war.order", color: "red", order: { unit: "worker", count: 2, order: "train" } });
});
