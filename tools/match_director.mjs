#!/usr/bin/env node
// The match director (docs/arena.md, Phase 5): starts the same match on every team's adapter
// from one seed, keeps the scoreboard flowing to all of them, declares the winner, keeps an
// Elo per model in .data/elo.json and writes the result to Mission Control when it is set up.
//   node tools/match_director.mjs start --teams A,B --mode race --objective awakening --sols 60 --budget 2000000 --seed 4217
//   node tools/match_director.mjs status | stop
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  existsSync(join(ROOT, ".env"))
    ? readFileSync(join(ROOT, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    : [],
);
const TOKEN = process.env.ARENA_TOKEN ?? env.ARENA_TOKEN ?? "";
const idx = (t) => t.toUpperCase().charCodeAt(0) - 65;
const adapterUrl = (t) => `http://127.0.0.1:${8771 + 10 * idx(t)}`;
const arenaUrl = (t) => `http://127.0.0.1:${8772 + 10 * idx(t)}`;
const modelOf = (t) => {
  const p = join(ROOT, "infra", "teams", t, "model");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "ollama/agentrts-qwen3";
};

const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const teams = (opt("teams", "A,B")).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);

async function get(url) {
  const r = await fetch(url, { headers: { "x-arena-token": TOKEN } });
  return r.json();
}
async function post(url, body, arena = false) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(arena ? { "x-arena-token": TOKEN } : {}) }, body: JSON.stringify(body ?? {}) });
  return r.json().catch(() => ({}));
}

async function teamState(t) {
  try {
    const a = await get(`${adapterUrl(t)}/arena`);
    return { team: t, match: a.match, info: a.info, ok: true };
  } catch {
    return { team: t, match: null, info: null, ok: false };
  }
}

function scoreboard(states) {
  return states.filter((s) => s.info).map((s) => ({ ...s.info.scoreboard[0], team: s.team }));
}

function elo(path, winner, losers, k = 32) {
  const table = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const r = (m) => table[m]?.rating ?? 1000;
  for (const l of losers) {
    if (!winner || winner.model === l.model) continue;
    const ew = 1 / (1 + 10 ** ((r(l.model) - r(winner.model)) / 400));
    table[winner.model] = { rating: Math.round(r(winner.model) + k * (1 - ew)), matches: (table[winner.model]?.matches ?? 0) + 1, wins: (table[winner.model]?.wins ?? 0) + 1 };
    table[l.model] = { rating: Math.round(r(l.model) - k * (1 - ew)), matches: (table[l.model]?.matches ?? 0) + 1, wins: table[l.model]?.wins ?? 0 };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(table, null, 2));
  return table;
}

async function reportToMissionControl(title, text) {
  if (!env.MC_URL || !env.MC_API_KEY) return false;
  try {
    const h = { "content-type": "application/json", "x-api-key": env.MC_API_KEY };
    const t = await (await fetch(`${env.MC_URL}/api/tasks`, { method: "POST", headers: h, body: JSON.stringify({ title, description: text, status: "in_progress", priority: "medium", tags: ["outpost-zero", "arena"], metadata: { source: "outpost-zero", kind: "match-result" } }) })).json();
    const id = t?.task?.id ?? t?.id;
    if (!id) return false;
    await fetch(`${env.MC_URL}/api/tasks/${id}/comments`, { method: "POST", headers: h, body: JSON.stringify({ content: text }) });
    await fetch(`${env.MC_URL}/api/quality-review`, { method: "POST", headers: h, body: JSON.stringify({ taskId: id, reviewer: "aegis", status: "approved", notes: "Match result" }) });
    return true;
  } catch {
    return false;
  }
}

if (cmd === "status") {
  for (const s of await Promise.all(teams.map(teamState))) {
    if (!s.ok) console.log(`${s.team}: adapter not reachable at ${adapterUrl(s.team)}`);
    else if (!s.info) console.log(`${s.team}: no match`);
    else console.log(`${s.team}: ${s.info.status} sol ${s.info.sol}/${s.info.sols} · ${JSON.stringify(s.info.scoreboard[0])}`);
  }
} else if (cmd === "stop") {
  for (const t of teams) console.log(t, JSON.stringify(await post(`${adapterUrl(t)}/arena/stop`)));
} else if (cmd === "start") {
  const config = { mode: opt("mode", "race"), objective: opt("objective", "awakening"), sols: Number(opt("sols", 60)), tokenBudget: Number(opt("budget", 2_000_000)), seed: Number(opt("seed", 4217)), actionsPerHour: Number(opt("actions", 6)) };
  const id = `match-${Date.now().toString(36)}`;
  console.log(`Match ${id}: ${JSON.stringify(config)} teams ${teams.join(", ")}`);
  for (const t of teams) {
    const r = await post(`${adapterUrl(t)}/arena/start`, { ...config, team: t, model: modelOf(t), source: id });
    if (!r.match) throw new Error(`team ${t} did not start: ${JSON.stringify(r)}`);
    console.log(`  ${t} (${modelOf(t)}) started on ${adapterUrl(t)}`);
  }
  const started = Date.now();
  let finished = null;
  const every = Number(opt("poll", 2000));
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    const states = await Promise.all(teams.map(teamState));
    const board = scoreboard(states);
    for (const t of teams) await post(`${arenaUrl(t)}/arena/${t}/scoreboard`, { scoreboard: board }, true).catch(() => {});
    const done = states.filter((s) => s.match?.status === "finished");
    const line = board.map((b) => `${b.team}:${b.value}v/${b.awake}a/${Math.round(b.tokens / 1000)}k${b.status === "frozen" ? "/frozen" : ""}`).join("  ");
    process.stdout.write(`\r${Math.round((Date.now() - started) / 1000)}s  sol ${states[0]?.info?.sol ?? "?"}  ${line}          `);
    // Race: the first team to reach the objective ends the match for everyone.
    const achieved = done.find((s) => s.match.config.mode === "race" && s.match.result?.winner);
    if (achieved) {
      for (const t of teams) if (t !== achieved.team) await post(`${adapterUrl(t)}/arena/stop`);
      finished = { winner: achieved.team, reason: achieved.match.result.reason };
      break;
    }
    if (done.length === teams.length) {
      const best = [...board].sort((a, b) => b.value - a.value)[0];
      finished = { winner: config.mode === "timed" ? best?.team ?? null : null, reason: done[0].match.result.reason };
      break;
    }
    if (states.every((s) => !s.ok)) throw new Error("no adapter reachable");
  }
  console.log();
  const states = await Promise.all(teams.map(teamState));
  const board = scoreboard(states).sort((a, b) => b.value - a.value);
  for (const t of teams) await post(`${arenaUrl(t)}/arena/${t}/scoreboard`, { scoreboard: board }, true).catch(() => {});
  const winner = board.find((b) => b.team === finished.winner) ?? null;
  const table = elo(join(ROOT, ".data", "elo.json"), winner, board.filter((b) => b.team !== finished.winner));
  const lines = [`Match ${id}: ${finished.reason}. Winner: ${finished.winner ?? "none"}.`, ...board.map((b, i) => `${i + 1}. ${b.team} ${b.model}: value ${b.value}, ${b.awake} awake, ${Math.round(b.tokens / 1000)} kTok, latency ${b.avgLatencyS ?? "n/a"} s${b.status === "frozen" ? " (frozen)" : ""}`), `Elo: ${board.map((b) => `${b.model} ${table[b.model]?.rating ?? 1000}`).join(", ")}`];
  console.log(lines.join("\n"));
  mkdirSync(join(ROOT, ".data", "matches"), { recursive: true });
  writeFileSync(join(ROOT, ".data", "matches", `${id}.json`), JSON.stringify({ id, config, teams, finished, board, states: states.map((s) => s.match), elo: table }, null, 2));
  console.log(`Mission Control: ${(await reportToMissionControl(`Match result: ${teams.join(" vs ")}`, lines.join("\n"))) ? "result posted" : "not configured"}`);
} else {
  console.error("usage: match_director.mjs start|status|stop [--teams A,B] [--mode race|timed] [--objective awakening|foothold] [--sols N] [--budget tokens] [--seed N]");
  process.exit(1);
}
