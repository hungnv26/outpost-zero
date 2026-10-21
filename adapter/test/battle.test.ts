import assert from "node:assert/strict";
import { test } from "node:test";
import { findCard, parseCard } from "../src/battle/card.ts";
import { BattleLobby, type McTask } from "../src/battle/lobby.ts";

const CARD = `Friday battle

\`\`\`
battle:
  map: Plain & Simple
  players:
    - blue: human
    - red: ai   # Outpost War's scripted opponent
  speed: 0.5
  minutes: 20
  fog: off
  screen: fullscreen
\`\`\`
Good luck.`;

test("a battle card holds the whole setup and is read from a task description", () => {
  assert.ok(findCard(CARD)?.startsWith("battle:"));
  const r = parseCard(CARD);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.config.map, "PlainAndSimple");
  assert.deepEqual(r.config.players, [
    { slot: 0, color: "blue", controller: "human" },
    { slot: 1, color: "red", controller: "ai" },
  ]);
  assert.equal(r.config.speed, 0.5);
  assert.equal(r.config.minutes, 20);
  assert.equal(r.config.fog, false);
  assert.equal(r.config.screen, "fullscreen");
  assert.equal(r.config.mouse, "free");
  // One-line players and map ids work too; colours can skip slots.
  const one = parseCard("battle:\n  map: BigArena\n  players: green=ai, turquoise=ai");
  assert.ok(one.ok && one.config.players.map((p) => p.slot).join() === "2,7");
});

test("a card with mistakes lists every one of them", () => {
  const r = parseCard(`battle:
  map: Moon Base
  players:
    - blue: human
    - pink: ai
    - blue: ai
    - red: anthropic/claude-sonnet-5-5
  speed: 9
  colour: red`);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const all = r.errors.join("\n");
  for (const bit of ["unknown map", "unknown colour \"pink\"", "blue is listed twice", "is not a player type", "speed must be", "unknown setting \"colour\""]) assert.ok(all.includes(bit), `missing "${bit}" in:\n${all}`);
  assert.equal(parseCard("no card here").ok, false);
  const big = parseCard("battle:\n  map: Plain & Simple\n  players:\n    - blue: ai\n    - turquoise: ai");
  assert.ok(!big.ok && big.errors.some((e) => e.includes("has 4")), "a slot beyond the map's players is refused");
  const two = parseCard("battle:\n  map: Plain & Simple\n  players:\n    - blue: human\n    - red: human");
  assert.ok(!two.ok && two.errors.some((e) => e.includes("one human")));
});

function harness() {
  const tasks: McTask[] = [];
  const comments: { id: number; text: string }[] = [];
  const done: number[] = [];
  const sent: Record<string, unknown>[] = [];
  let connected = false;
  let launches = 0;
  const lobby = new BattleLobby(
    {
      inProgress: async () => tasks.filter((t) => t.status === "in_progress"),
      comment: async (id, text) => void comments.push({ id, text }),
      done: async (id) => void done.push(id),
    },
    { connected: () => connected, send: (m) => void sent.push(m) },
    () => void launches++,
  );
  return { tasks, comments, done, sent, lobby, connect: (v: boolean) => (connected = v), launches: () => launches };
}

test("Mission Control starts, stops and scores a battle; the game only plays it", async () => {
  const h = harness();
  h.tasks.push({ id: 7, status: "in_progress", description: CARD, updated_at: 1 });
  // No game window yet: the lobby opens one and waits.
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "waiting_for_game");
  assert.equal(h.launches(), 1);
  h.connect(true);
  h.lobby.gameConnected();
  assert.equal(h.lobby.phase, "running");
  assert.equal(h.sent[0].type, "battle.start");
  assert.equal((h.sent[0].battle as { map: string }).map, "PlainAndSimple");
  // The game reports the end: a comment with the result and the task is done.
  await h.lobby.finished({ winner: "blue", reason: "one player left", gameTimeS: 312, players: [{ color: "blue", controller: "human", units: 9, structures: 4, alive: true }, { color: "red", controller: "ai", units: 0, structures: 0, alive: false }] });
  assert.equal(h.lobby.phase, "idle");
  assert.deepEqual(h.done, [7]);
  assert.ok(h.comments.some((c) => c.text.includes("Winner: blue") && c.text.includes("5:12")));
  // Still listed as in progress (the done call is async in Mission Control): not started again.
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "idle");

  // A second battle, cancelled from Mission Control mid-way, stops the game's battle.
  h.tasks.push({ id: 8, status: "in_progress", description: CARD.replace("speed: 0.5", "speed: 1"), updated_at: 5 });
  h.tasks[0].status = "done";
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "running");
  h.tasks[1].status = "cancelled";
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "idle");
  assert.equal(h.sent.at(-1)?.type, "battle.stop");

  // A bad card gets one comment, and the corrected card starts.
  h.tasks.push({ id: 9, status: "in_progress", description: "battle:\n  map: Moon\n  players:\n    - blue: ai\n    - red: ai", updated_at: 9 });
  await h.lobby.poll();
  await h.lobby.poll();
  assert.equal(h.comments.filter((c) => c.id === 9 && c.text.includes("cannot start")).length, 1);
  h.tasks[2].description = "battle:\n  map: Big Arena\n  players:\n    - blue: ai\n    - red: ai";
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "running");
  assert.equal(h.lobby.taskId, 9);
  // The window closes mid-battle: abandoned, with a note, and not restarted by itself.
  h.connect(false);
  await h.lobby.gameDisconnected();
  assert.equal(h.lobby.phase, "idle");
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "idle");
  assert.ok(h.comments.some((c) => c.id === 9 && c.text.includes("abandoned")));
});

test("the Arena Setup page starts and stops a battle without Mission Control", async () => {
  const h = harness();
  const bad = h.lobby.startLocal("battle:\n  map: Moon\n  players:\n    - blue: ai\n    - red: ai");
  assert.equal(bad.ok, false);
  assert.equal(h.lobby.phase, "idle");
  const r = h.lobby.startLocal(CARD);
  assert.ok(r.ok);
  assert.equal(h.lobby.phase, "waiting_for_game");
  assert.equal(h.launches(), 1);
  // A second start while one is on is refused.
  assert.equal(h.lobby.startLocal(CARD).ok, false);
  h.connect(true);
  h.lobby.gameConnected();
  assert.equal(h.lobby.phase, "running");
  assert.equal(h.sent.at(-1)?.type, "battle.start");
  assert.equal(h.sent.at(-1)?.id, r.ok ? r.id : "");
  await h.lobby.finished({ winner: "red", reason: "one player left", gameTimeS: 95, players: [] });
  assert.equal(h.lobby.last?.source, "setup");
  assert.equal(h.lobby.last?.result.winner, "red");
  // Setup battles never touch Mission Control, and the lobby's poll ignores them.
  assert.equal(h.comments.length, 0);
  assert.equal(h.done.length, 0);
  assert.ok(h.lobby.startLocal(CARD).ok);
  await h.lobby.poll();
  assert.equal(h.lobby.phase, "running");
  assert.ok(h.lobby.stopLocal());
  assert.equal(h.sent.at(-1)?.type, "battle.stop");
  assert.equal(h.lobby.phase, "idle");
  assert.equal(h.comments.length, 0);
});

test("a battle card names its battlefield (random by default), resolved before the battle starts", () => {
  const plain = parseCard("battle:\n  map: Plain & Simple\n  players:\n    - blue: ai\n    - red: ai");
  assert.ok(plain.ok && plain.config.battlefield === "random");
  const named = parseCard("battle:\n  map: Plain & Simple\n  battlefield: Red Basin\n  players:\n    - blue: ai\n    - red: ai");
  assert.ok(named.ok && named.config.battlefield === "red-basin");
  const h = harness();
  h.lobby.prepare = (config) => (config.battlefield === "red-basin" ? [] : [`unknown battlefield "${config.battlefield}"`]);
  const refused = h.lobby.startLocal("battle:\n  map: Plain & Simple\n  battlefield: moon-palace\n  players:\n    - blue: ai\n    - red: ai");
  assert.ok(!refused.ok && refused.errors[0].includes("moon-palace"));
  assert.equal(h.lobby.phase, "idle");
  assert.ok(h.lobby.startLocal("battle:\n  map: Plain & Simple\n  battlefield: red-basin\n  players:\n    - blue: ai\n    - red: ai").ok);
});
