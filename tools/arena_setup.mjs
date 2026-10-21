#!/usr/bin/env node
// Arena Setup (docs/arena.md §8f): the local setup page for both games.
//   Outpost Zero: give each team a model and an API key, bring the teams up, start a match
//   (optionally recorded), open the game windows and follow the score.
//   Outpost War (docs/outpost-war.md): map, players, speed, time limit and display; it opens the
//   game window and starts or stops the battle through the battle service (127.0.0.1:8796).
//   node tools/arena_setup.mjs            then open http://127.0.0.1:8790
// Two servers in one process:
//   - the page and its API on 127.0.0.1:8790 (this Mac only; every change needs the page's token
//     and must come from the page's own origin, so other websites cannot drive it);
//   - the key gateway on 0.0.0.0:8795 for the teams' Hermes containers. A cloud team's Hermes
//     sends its random team token (infra/teams/<T>/gateway.token); the gateway swaps it for the
//     real key (infra/teams/<T>/api.key, or <PROVIDER>_API_KEY in infra/providers.env), pins the
//     team's model and adapts the request to the provider. Keys never enter a container.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLORS, MAPS, parseCard } from "../adapter/src/battle/card.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PORT = Number(process.env.SETUP_PORT ?? 8790);
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8795);
const TEAMS = ["A", "B"];
const PAGE_TOKEN = randomBytes(16).toString("hex");
const ORIGINS = [`http://127.0.0.1:${UI_PORT}`, `http://localhost:${UI_PORT}`];

const PROVIDERS = {
  ollama: { name: "Local (Ollama)", base: null, models: ["agentrts-qwen3"] },
  anthropic: { name: "Anthropic (Claude)", base: "https://api.anthropic.com/v1", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"] },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5"] },
};
const DEFAULTS = { A: "anthropic:claude-sonnet-5-5", B: "openai:gpt-5" };
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const SETTINGS_PATH = join(ROOT, ".data", "arena-setup.json");

// ---- files ----

const teamDir = (t) => join(ROOT, "infra", "teams", t);
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
function writeSecret(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
const providersEnv = () =>
  Object.fromEntries(read(join(ROOT, "infra", "providers.env")).split("\n").filter((l) => /^[A-Z_]+=./.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

function teamSpec(t) {
  const spec = read(join(teamDir(t), "model")) || DEFAULTS[t];
  const provider = spec.split(":")[0];
  return { provider: PROVIDERS[provider] ? provider : "ollama", model: spec.slice(spec.indexOf(":") + 1) };
}
function teamKey(t, provider) {
  return read(join(teamDir(t), "api.key")) || providersEnv()[`${provider.toUpperCase()}_API_KEY`] || "";
}
// One key per provider for Outpost War's model players (infra/keys/<provider>.key, 600,
// gitignored). A team key on the same provider, or infra/providers.env, also serves.
const keyDir = join(ROOT, "infra", "keys");
function providerKeyInfo(provider) {
  const own = read(join(keyDir, `${provider}.key`));
  if (own) return { key: own, source: "this page" };
  for (const t of TEAMS) {
    const k = read(join(teamDir(t), "api.key"));
    if (k && teamSpec(t).provider === provider) return { key: k, source: `team ${t}'s key` };
  }
  const env = providersEnv()[`${provider.toUpperCase()}_API_KEY`];
  return env ? { key: env, source: "infra/providers.env" } : { key: "", source: "" };
}
function keyStatus() {
  return Object.fromEntries(
    Object.keys(PROVIDERS)
      .filter((p) => p !== "ollama")
      .map((p) => {
        const k = providerKeyInfo(p);
        return [p, k.key ? { saved: true, hint: `…${k.key.slice(-4)}`, source: k.source } : { saved: false }];
      }),
  );
}
async function callModel(provider, model, body) {
  const base = provider === "ollama" ? OLLAMA_BASE : PROVIDERS[provider]?.base;
  if (!base) throw new Error(`unknown provider ${provider}`);
  const key = provider === "ollama" ? "ollama" : providerKeyInfo(provider).key;
  if (!key) throw new Error(`no ${PROVIDERS[provider].name} key saved`);
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(provider === "openrouter" ? { "x-title": "Outpost War" } : {}) },
    body: JSON.stringify(adaptBody(provider, model, body)),
    signal: AbortSignal.timeout(180_000),
  });
}
const warUsage = {};

// ---- the models each provider offers, asked of the provider with the saved key ----
// (refreshed every 15 minutes and when a key is saved; the PROVIDERS lists are the fallback)
const modelLists = {};
async function fetchModels(provider) {
  try {
    if (provider === "anthropic") {
      const key = providerKeyInfo("anthropic").key;
      if (!key) return;
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) modelLists.anthropic = (await r.json()).data.map((m) => m.id);
    } else if (provider === "openai") {
      const key = providerKeyInfo("openai").key;
      if (!key) return;
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      // Chat models that take tools through chat completions: no snapshots, no audio, image,
      // realtime or search variants, no -pro (those answer only on the Responses API).
      const ids = (await r.json()).data.map((m) => m.id).filter((id) => /^(gpt-4\.1|gpt-4o|gpt-[5-9]|o[3-9])/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|codex|preview|-pro\b|\d{4}-\d\d-\d\d/.test(id));
      modelLists.openai = ids.filter((id) => !RESPONSES_ONLY.has(id)).sort((a, b) => (a.startsWith("o") - b.startsWith("o")) || b.localeCompare(a, undefined, { numeric: true }));
    } else if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
      if (r.ok) modelLists.openrouter = (await r.json()).data.filter((m) => (m.supported_parameters ?? []).includes("tools")).map((m) => m.id).sort();
    } else if (provider === "ollama") {
      const r = await fetch(OLLAMA_BASE.replace(/\/v1$/, "") + "/api/tags", { signal: AbortSignal.timeout(5_000) });
      if (r.ok) modelLists.ollama = (await r.json()).models.map((m) => m.name.replace(/:latest$/, "")).filter((n) => !/embed|bge|nomic/.test(n));
    }
  } catch {}
}
const refreshModels = () => Promise.all(Object.keys(PROVIDERS).map(fetchModels));
setTimeout(refreshModels, 500);
setInterval(refreshModels, 15 * 60_000);

function gatewayToken(t) {
  const p = join(teamDir(t), "gateway.token");
  if (!read(p)) writeSecret(p, randomBytes(16).toString("hex"));
  return read(p);
}
// One entry per colour, so changing the number of players keeps each colour's choice.
const WAR_PLAYER_DEFAULTS = [
  { kind: "model", provider: "anthropic", model: "claude-sonnet-5-5" },
  { kind: "model", provider: "openai", model: "gpt-5" },
  { kind: "model", provider: "anthropic", model: "claude-haiku-5-5" },
  { kind: "model", provider: "openai", model: "gpt-5-mini" },
  { kind: "ai", provider: "ollama", model: "agentrts-qwen3" },
  { kind: "ai", provider: "ollama", model: "agentrts-qwen3" },
  { kind: "ai", provider: "ollama", model: "agentrts-qwen3" },
  { kind: "ai", provider: "ollama", model: "agentrts-qwen3" },
];
const WAR_DEFAULTS = { map: "Duel", battlefield: "random", count: 2, players: WAR_PLAYER_DEFAULTS, speed: 0.5, minutes: 20, budget: 400000, fog: true, screen: "window", mouse: "free" };
function loadSettings() {
  const d = { objective: "lifeline", sols: 12, map: "random", clock: 2, budget: 400000, record: false };
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const war = { ...WAR_DEFAULTS, ...(saved.war ?? {}) };
    if (!Array.isArray(war.players)) war.players = WAR_PLAYER_DEFAULTS; // the earlier colour -> human/ai form
    return { ...d, ...saved, war };
  } catch {
    return { ...d, war: WAR_DEFAULTS };
  }
}
function saveSettings(next) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
}

// ---- Outpost War ----

const BATTLE_URL = "http://127.0.0.1:8796";
// The page's form as a battle card (adapter/src/battle/card.ts), so the battle service checks it
// with the same rules as any card.
function warCard(w) {
  const players = COLORS.slice(0, w.count).map((c, i) => {
    const p = w.players[i];
    return `    - ${c}: ${p.kind === "model" ? `${p.provider}:${p.model}` : p.kind}`;
  });
  return ["battle:", `  map: ${w.map}`, `  battlefield: ${w.battlefield ?? "random"}`, "  players:", ...players, `  speed: ${w.speed}`, `  minutes: ${w.minutes}`, `  budget: ${w.budget}`, `  fog: ${w.fog ? "on" : "off"}`, `  screen: ${w.screen}`, `  mouse: ${w.mouse}`].join("\n");
}
function warFrom(b, prev) {
  const map = MAPS[b.map] ? b.map : prev.map;
  const num = (v, lo, hi, d) => (v !== undefined && v !== "" && v !== null && Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const players = COLORS.map((_, i) => {
    const p = Array.isArray(b.players) ? b.players[i] : null;
    const old = prev.players[i] ?? WAR_PLAYER_DEFAULTS[i];
    if (!p) return old;
    const kind = ["model", "ai", "human"].includes(p.kind) ? p.kind : old.kind;
    const provider = PROVIDERS[p.provider] ? p.provider : old.provider;
    const model = /^[\w./:-]{1,80}$/.test(String(p.model ?? "").trim()) ? String(p.model).trim() : old.model;
    return { kind, provider, model };
  });
  const battlefield = b.battlefield === "random" || b.battlefield === "none" || battlefields().some((f) => f.id === b.battlefield) ? b.battlefield : prev.battlefield ?? "random";
  return {
    map,
    battlefield,
    count: Math.floor(num(b.count, 2, MAPS[map].players, Math.min(prev.count ?? 2, MAPS[map].players))),
    players,
    speed: num(b.speed, 0.25, 4, prev.speed),
    minutes: Math.floor(num(b.minutes, 0, 240, prev.minutes)),
    budget: Math.floor(num(b.budget, 10000, 20_000_000, prev.budget)),
    fog: b.fog === undefined ? prev.fog : !!b.fog,
    screen: b.screen === "fullscreen" ? "fullscreen" : "window",
    mouse: b.mouse === "restricted" ? "restricted" : "free",
  };
}
// Every model player needs its provider's key before the battle starts.
function missingKeys(w) {
  const out = [];
  for (const [i, p] of w.players.slice(0, w.count).entries()) {
    if (p.kind === "model" && p.provider !== "ollama" && !providerKeyInfo(p.provider).key) out.push(`${COLORS[i]} plays on ${PROVIDERS[p.provider].name}: paste a key for it`);
  }
  return out;
}
async function battleService() {
  if (await getJson(`${BATTLE_URL}/health`)) return true;
  mkdirSync(join(ROOT, ".data", "logs"), { recursive: true });
  const out = openSync(join(ROOT, ".data", "logs", "battle.log"), "a");
  const child = spawn("node", ["src/battle-main.ts"], { cwd: join(ROOT, "adapter"), stdio: ["ignore", out, out], detached: true });
  child.unref();
  writeFileSync(join(ROOT, ".data", "battle.pid"), String(child.pid));
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await getJson(`${BATTLE_URL}/health`)) return true;
  }
  throw new Error("the battle service did not start (see .data/logs/battle.log)");
}
async function battlePost(path, body) {
  const r = await fetch(BATTLE_URL + path, { method: "POST", headers: { "content-type": "application/json", "x-arena-token": ARENA_TOKEN }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(5000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `battle service: HTTP ${r.status}`);
  return j;
}
function openWarWindow() {
  killPidFile(join(ROOT, ".data", "game-war.pid"));
  const pid = spawnDetached("godot", ["--path", "game", "--", "--mode=outpost-war"], "game-war.log");
  writeFileSync(join(ROOT, ".data", "game-war.pid"), String(pid));
}
function battlefields() {
  try {
    return Object.entries(JSON.parse(readFileSync(join(ROOT, "design", "maps.json"), "utf8")).battlefields ?? {}).map(([id, b]) => ({ id, name: b.name, terrain: b.terrain }));
  } catch {
    return [];
  }
}

// ---- provider requests ----

// Newer OpenAI reasoning models take max_completion_tokens and no sampling settings, and the
// current Claude models refuse a temperature; Hermes always sends max_tokens and a temperature,
// so the gateway translates.
// OpenAI's reasoning models (GPT-5 and later, the o-series) take max_completion_tokens and no
// sampling settings.
const OPENAI_REASONING = /^(gpt-[5-9]|o\d)/i;
const NO_REASONING = new Set(); // OpenAI models that refused tools with any reasoning on chat completions
// OpenAI models that take tools only on the Responses API (reasoning cannot be off on chat
// completions): learnt from their refusals, seeded with the ones seen 2026-10-21; not offered.
const RESPONSES_ONLY = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

function adaptBody(provider, model, body) {
  const b = { ...body, model };
  if (provider === "anthropic") {
    delete b.temperature;
    delete b.top_p;
  }
  if (provider === "openai" && OPENAI_REASONING.test(model)) {
    if (b.max_tokens !== undefined) {
      b.max_completion_tokens = Math.max(b.max_tokens, 2048);
      delete b.max_tokens;
    }
    delete b.temperature;
    delete b.top_p;
  }
  return b;
}

// The referee's token (ARENA_TOKEN in .env): the gateway reports each call's real token count
// to the team's Arena API, which charges it against the match budget (Arena.providerUsage).
const ARENA_TOKEN = (read(join(ROOT, ".env")).split("\n").find((l) => l.startsWith("ARENA_TOKEN=")) ?? "").slice(12).trim();
function reportUsage(t, tokens) {
  if (!ARENA_TOKEN || !(tokens > 0)) return;
  const port = 8772 + 10 * TEAMS.indexOf(t);
  fetch(`http://127.0.0.1:${port}/arena/${t}/usage`, { method: "POST", headers: { "content-type": "application/json", "x-arena-token": ARENA_TOKEN }, body: JSON.stringify({ tokens }), signal: AbortSignal.timeout(3000) }).catch(() => {});
}

const usage = Object.fromEntries(TEAMS.map((t) => [t, { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastAt: null }]));

async function callProvider(t, body, stream) {
  const { provider, model } = teamSpec(t);
  const p = PROVIDERS[provider];
  if (!p?.base) throw new Error(`team ${t} plays on the local model; nothing to relay`);
  const key = teamKey(t, provider);
  if (!key) throw new Error(`team ${t} has no API key`);
  return fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(provider === "openrouter" ? { "x-title": "Outpost Zero" } : {}) },
    body: JSON.stringify(adaptBody(provider, model, { ...body, ...(stream === undefined ? {} : { stream }) })),
    signal: AbortSignal.timeout(180_000),
  });
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- the gateway (for Hermes containers) ----

const gateway = http.createServer(async (req, res) => {
  const m = /^\/llm\/([A-D])\/v1\/(chat\/completions|models)$/.exec(req.url ?? "");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/llm/war/v1/chat/completions") return warGateway(req, res, send);
  if (!m) return send(404, { error: { message: "not found" } });
  const t = m[1];
  const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!TEAMS.includes(t) || !sameToken(auth, gatewayToken(t))) return send(401, { error: { message: "bad team token" } });
  const { model } = teamSpec(t);
  if (m[2] === "models") return send(200, { object: "list", data: [{ id: model, object: "model" }] });
  if (req.method !== "POST") return send(405, { error: { message: "POST only" } });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return send(400, { error: { message: "bad JSON" } });
  }
  const u = usage[t];
  u.requests++;
  u.lastAt = Date.now();
  try {
    const up = await callProvider(t, body);
    const type = up.headers.get("content-type") ?? "application/json";
    if (!up.ok) {
      const text = await up.text();
      u.errors++;
      u.lastError = `${up.status}: ${text.slice(0, 300)}`;
      res.writeHead(up.status, { "content-type": type });
      return res.end(text);
    }
    if (type.includes("text/event-stream")) {
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      for await (const chunk of up.body) res.write(chunk);
      return res.end();
    }
    const text = await up.text();
    try {
      const j = JSON.parse(text);
      u.promptTokens += j.usage?.prompt_tokens ?? 0;
      u.completionTokens += j.usage?.completion_tokens ?? 0;
      reportUsage(t, (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0));
    } catch {}
    res.writeHead(200, { "content-type": type });
    res.end(text);
  } catch (e) {
    u.errors++;
    u.lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
    send(502, { error: { message: u.lastError } });
  }
});

// Outpost War's model players (the battle service's commanders, adapter/src/battle/commander.ts):
// the referee's token, and the model as "provider:model" in the body.
async function warGateway(req, res, send) {
  if (req.method !== "POST") return send(405, { error: { message: "POST only" } });
  if (!ARENA_TOKEN || !sameToken(req.headers["x-arena-token"] ?? "", ARENA_TOKEN)) return send(401, { error: { message: "bad token" } });
  let body;
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw || "{}");
  } catch {
    return send(400, { error: { message: "bad JSON" } });
  }
  const spec = String(body.model ?? "");
  const provider = spec.slice(0, spec.indexOf(":"));
  const model = spec.slice(spec.indexOf(":") + 1);
  if (!PROVIDERS[provider] || !model) return send(400, { error: { message: `model must be provider:model, got "${spec}"` } });
  const u = (warUsage[spec] ??= { requests: 0, errors: 0, tokens: 0, lastError: null });
  u.requests++;
  // A battle runs in real time: GPT-5 and the o-series think briefly.
  const b = { ...body, model };
  if (provider === "openai" && OPENAI_REASONING.test(model) && !/chat-latest/.test(model) && b.reasoning_effort === undefined) b.reasoning_effort = NO_REASONING.has(model) ? "none" : "low";
  try {
    let up = await callModel(provider, model, b);
    let text = await up.text();
    // OpenAI's newer models (GPT-5.4 and later) take tools on chat completions only with reasoning
    // off: switch to "none" once and remember it for that model.
    if (!up.ok && up.status === 400 && b.reasoning_effort === "low" && /reasoning_effort to 'none'/.test(text)) {
      NO_REASONING.add(model);
      b.reasoning_effort = "none";
      up = await callModel(provider, model, b);
      text = await up.text();
      if (!up.ok && /does not support 'none'/.test(text)) {
        RESPONSES_ONLY.add(model);
        modelLists.openai = (modelLists.openai ?? []).filter((m) => m !== model);
      }
    }
    if (!up.ok) {
      u.errors++;
      u.lastError = `${up.status}: ${text.slice(0, 300)}`;
      res.writeHead(up.status, { "content-type": "application/json" });
      return res.end(text);
    }
    try {
      const j = JSON.parse(text);
      u.tokens += (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0);
    } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(text);
  } catch (e) {
    u.errors++;
    u.lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
    send(502, { error: { message: u.lastError } });
  }
}

// ---- jobs (apply, start) ----

const jobs = {};
function runJob(name, cmd, args, env = {}) {
  if (jobs[name]?.status === "running") throw new Error(`${name} is already running`);
  mkdirSync(join(ROOT, ".data", "logs"), { recursive: true });
  const log = join(ROOT, ".data", "logs", `arena-setup-${name}.log`);
  const out = openSync(log, "w");
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  jobs[name] = { status: "running", startedAt: Date.now(), code: null, log };
  child.on("exit", (code) => Object.assign(jobs[name], { status: code === 0 ? "done" : "failed", code }));
  return jobs[name];
}
function spawnDetached(cmd, args, logName, env = {}) {
  const out = openSync(join(ROOT, ".data", "logs", logName), "w");
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  child.unref();
  return child.pid;
}
const tail = (path, n = 12) => {
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n");
};
const killPidFile = (p) => {
  const pid = Number(read(p));
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
  }
};

// ---- status ----

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function status() {
  const teams = {};
  for (const [i, t] of TEAMS.entries()) {
    const { provider, model } = teamSpec(t);
    const key = provider === "ollama" ? "" : teamKey(t, provider);
    const hermes = await getJson(`http://127.0.0.1:${8101 + i}/api/status`);
    const state = await getJson(`http://127.0.0.1:${8771 + 10 * i}/state`);
    const a = state?.world?.arena ?? null;
    const colony = state?.world?.resources?.colony ?? null;
    teams[t] = {
      provider,
      model,
      key: key ? { saved: true, hint: `…${key.slice(-4)}`, source: read(join(teamDir(t), "api.key")) ? "this page" : "infra/providers.env" } : { saved: false },
      hermes: !!hermes,
      adapter: !!state,
      clock: colony?.realSecondsPerHour ?? null,
      awake: colony?.colonists?.awake ?? null,
      sol: colony?.sol ?? null,
      arena: a ? { status: a.status, sol: a.sol, sols: a.sols, objective: a.objectiveText, map: a.battlefield?.name ?? a.map, result: a.result, board: a.scoreboard } : null,
      usage: usage[t],
    };
  }
  const war = await getJson(`${BATTLE_URL}/battle`);
  const logRoot = join(ROOT, "battle-logs");
  const battleLogs = existsSync(logRoot)
    ? readdirSync(logRoot)
        .filter((d) => /^[\w-]+$/.test(d))
        .sort()
        .slice(-8)
        .reverse()
        .map((id) => ({ id, files: readdirSync(join(logRoot, id)).filter((f) => /\.(md|jsonl|json)$/.test(f)).sort() }))
    : [];
  const recs = existsSync(join(ROOT, "recordings")) ? readdirSync(join(ROOT, "recordings")).filter((f) => f.endsWith(".mp4")).sort() : [];
  return {
    teams,
    settings: loadSettings(),
    jobs,
    director: tail(join(ROOT, ".data", "logs", "director.log"), 6),
    applyLog: tail(join(ROOT, ".data", "logs", "arena-setup-apply.log"), 14),
    recordings: recs.slice(-5).reverse(),
    war,
    battleLogs,
    models: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, modelLists[p]?.length ? modelLists[p] : PROVIDERS[p].models])),
    keys: keyStatus(),
    warUsage,
  };
}

// ---- the page's API ----

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

async function api(req, res, path) {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && path === "/api/state") return send(200, await status());
  if (req.method !== "POST") return send(405, { error: "POST only" });
  const origin = req.headers.origin;
  if ((origin && !ORIGINS.includes(origin)) || !sameToken(req.headers["x-setup-token"] ?? "", PAGE_TOKEN)) return send(403, { error: "refused: not from the setup page" });
  let b;
  try {
    b = await readBody(req);
  } catch {
    return send(400, { error: "bad JSON" });
  }
  try {
    if (path === "/api/team") {
      const t = String(b.team);
      if (!TEAMS.includes(t)) return send(400, { error: "unknown team" });
      const provider = PROVIDERS[b.provider] ? b.provider : null;
      const model = String(b.model ?? "").trim();
      if (!provider || !/^[\w./:-]{1,80}$/.test(model)) return send(400, { error: "choose a provider and a model name" });
      mkdirSync(teamDir(t), { recursive: true });
      writeFileSync(join(teamDir(t), "model"), `${provider}:${model}\n`);
      if (typeof b.key === "string" && b.key.trim()) {
        if (/\s/.test(b.key.trim()) || b.key.trim().length > 400) return send(400, { error: "that does not look like an API key" });
        writeSecret(join(teamDir(t), "api.key"), b.key.trim());
      }
      if (b.clearKey && existsSync(join(teamDir(t), "api.key"))) unlinkSync(join(teamDir(t), "api.key"));
      gatewayToken(t);
      return send(200, { ok: true });
    }
    if (path === "/api/test") {
      const t = String(b.team);
      const started = Date.now();
      const r = await callProvider(t, { messages: [{ role: "user", content: "Reply with the single word OK." }] });
      const text = await r.text();
      if (!r.ok) return send(200, { ok: false, error: `${r.status}: ${text.slice(0, 300)}` });
      let reply = "";
      try {
        reply = JSON.parse(text).choices?.[0]?.message?.content ?? "";
      } catch {}
      return send(200, { ok: true, ms: Date.now() - started, reply: String(reply).slice(0, 60) });
    }
    if (path === "/api/settings") {
      const s = loadSettings();
      const next = {
        ...s,
        objective: ["lifeline", "sprint", "foothold", "awakening", "ending"].includes(b.objective) ? b.objective : s.objective,
        sols: Math.max(1, Math.min(200, Math.floor(Number(b.sols) || s.sols))),
        map: b.map === "random" || b.map === "duel" || battlefields().some((f) => f.id === b.map) ? b.map : s.map,
        clock: Math.max(0.3, Math.min(60, Number(b.clock) || s.clock)),
        budget: Math.max(10000, Math.min(20_000_000, Math.floor(Number(b.budget) || s.budget))),
        record: !!b.record,
      };
      saveSettings(next);
      return send(200, { ok: true, settings: next });
    }
    if (path === "/api/war/settings" || path === "/api/war/start") {
      const s = loadSettings();
      const war = warFrom(b, s.war);
      saveSettings({ ...s, war });
      if (path === "/api/war/settings") return send(200, { ok: true, war });
      const card = warCard(war);
      const check = parseCard(card);
      if (!check.ok) return send(400, { error: check.errors.join("; ") });
      const missing = missingKeys(war);
      if (missing.length) return send(400, { error: missing.join("; ") });
      await battleService();
      const r = await battlePost("/battle/start", { card });
      return send(200, { ok: true, id: r.id, phase: r.phase });
    }
    if (path === "/api/key") {
      const provider = String(b.provider);
      if (!PROVIDERS[provider] || provider === "ollama") return send(400, { error: "choose a provider that needs a key" });
      if (b.clear) {
        try {
          unlinkSync(join(keyDir, `${provider}.key`));
        } catch {}
        return send(200, { ok: true });
      }
      const key = String(b.key ?? "").trim();
      if (!key || /\s/.test(key) || key.length > 400) return send(400, { error: "that does not look like an API key" });
      writeSecret(join(keyDir, `${provider}.key`), key);
      void fetchModels(provider);
      return send(200, { ok: true });
    }
    if (path === "/api/key/test") {
      const provider = String(b.provider);
      const model = String(b.model ?? "").trim();
      if (!PROVIDERS[provider] || !/^[\w./:-]{1,80}$/.test(model)) return send(400, { error: "choose a provider and a model" });
      const started = Date.now();
      const r = await callModel(provider, model, { messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: provider === "openai" ? 2048 : 20 });
      const text = await r.text();
      if (!r.ok) return send(200, { ok: false, error: `${r.status}: ${text.slice(0, 300)}` });
      let reply = "";
      try {
        reply = JSON.parse(text).choices?.[0]?.message?.content ?? "";
      } catch {}
      return send(200, { ok: true, ms: Date.now() - started, reply: String(reply).slice(0, 60) });
    }
    if (path === "/api/war/stop") {
      if (!(await getJson(`${BATTLE_URL}/health`))) return send(200, { ok: false });
      return send(200, await battlePost("/battle/stop"));
    }
    if (path === "/api/war/window") {
      await battleService();
      const h = await getJson(`${BATTLE_URL}/health`);
      if (h?.game) return send(200, { ok: true, already: true });
      openWarWindow();
      return send(200, { ok: true });
    }
    if (path === "/api/apply") {
      const specs = TEAMS.map((t) => {
        const { provider, model } = teamSpec(t);
        if (provider !== "ollama" && !teamKey(t, provider)) throw new Error(`team ${t} needs an API key first`);
        return `${t}=${provider}:${model}`;
      });
      try {
        unlinkSync(join(ROOT, ".data", "teams", "ollama.lock"));
      } catch {}
      const s = loadSettings();
      return send(200, { ok: true, job: runJob("apply", "bash", ["scripts/arena.sh", "up", ...specs], { COLONY_SECONDS_PER_HOUR: String(s.clock), GATEWAY_PORT: String(GATEWAY_PORT) }) });
    }
    if (path === "/api/start") {
      const s = loadSettings();
      if (s.record) {
        spawnDetached("bash", ["tools/record_match.sh", String(s.sols), s.map, s.objective], "record-run.log", { RECORD_MODE: "race" });
      } else {
        killPidFile(join(ROOT, ".data", "director.pid"));
        const pid = spawnDetached("node", ["tools/match_director.mjs", "start", "--teams", TEAMS.join(","), "--map", s.map, "--mode", "race", "--objective", s.objective, "--sols", String(s.sols), "--budget", String(s.budget), "--seed", String(Math.floor(Math.random() * 1e6)), "--poll", "3000"], "director.log");
        writeFileSync(join(ROOT, ".data", "director.pid"), String(pid));
      }
      return send(200, { ok: true });
    }
    if (path === "/api/stop") {
      killPidFile(join(ROOT, ".data", "director.pid"));
      runJob("stop", "node", ["tools/match_director.mjs", "stop"]);
      return send(200, { ok: true });
    }
    if (path === "/api/windows") {
      for (const t of TEAMS) {
        killPidFile(join(ROOT, ".data", `game-${t}.pid`));
        const i = TEAMS.indexOf(t);
        const pid = spawnDetached("godot", ["--path", "game", "--max-fps", "30", "--", "--mode=outpost-zero"], `game-${t}.log`, i === 0 ? {} : { OUTPOST_ZERO_WS: `ws://127.0.0.1:${8771 + 10 * i}/world` });
        writeFileSync(join(ROOT, ".data", `game-${t}.pid`), String(pid));
      }
      return send(200, { ok: true });
    }
    return send(404, { error: "not found" });
  } catch (e) {
    return send(400, { error: e instanceof Error ? e.message : String(e) });
  }
}

// Recordings play in the page (with Range support, which Safari needs for video).
function serveRecording(req, res, name) {
  const file = join(ROOT, "recordings", name);
  if (!/^[\w.-]+\.mp4$/.test(name) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
  createReadStream(file).pipe(res);
}

const ui = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path.startsWith("/api/")) return api(req, res, path);
  if (path.startsWith("/recordings/")) return serveRecording(req, res, decodeURIComponent(path.slice(12)));
  if (path.startsWith("/battle-logs/")) {
    // A battle's prompt log (adapter/src/battle-main.ts writes them), shown as plain text.
    const m = /^\/battle-logs\/([\w-]+)\/([\w-]+\.(md|jsonl|json))$/.exec(decodeURIComponent(path));
    const file = m ? join(ROOT, "battle-logs", m[1], m[2]) : "";
    if (!m || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": `${m[3] === "md" ? "text/markdown" : m[3] === "json" ? "application/json" : "text/plain"}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return createReadStream(file).pipe(res);
  }
  if (path === "/" || path === "/index.html") {
    const page = readFileSync(join(ROOT, "tools", "arena_setup.html"), "utf8")
      .replace("__TOKEN__", PAGE_TOKEN)
      .replace("__PROVIDERS__", JSON.stringify(Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { name: v.name, models: v.models }]))))
      .replace("__MAPS__", JSON.stringify(battlefields()))
      .replace("__WAR__", JSON.stringify({ maps: Object.entries(MAPS).map(([id, m]) => ({ id, name: m.name, players: m.players })), colors: COLORS }));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; media-src 'self'; frame-ancestors 'none'" });
    return res.end(page);
  }
  res.writeHead(404);
  res.end();
});

for (const t of TEAMS) gatewayToken(t);
ui.listen(UI_PORT, "127.0.0.1", () => console.log(`Arena Setup: http://127.0.0.1:${UI_PORT}`));
gateway.listen(GATEWAY_PORT, "0.0.0.0", () => console.log(`Key gateway for the teams' Hermes on :${GATEWAY_PORT}`));
