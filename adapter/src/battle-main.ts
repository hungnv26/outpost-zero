// Outpost War's battle service (docs/outpost-war.md): the lobby for battles and the link to the
// game window. Separate from the colony adapter, so Outpost War runs without it.
//   node src/battle-main.ts        (the Arena Setup page and scripts/start.sh --war start it)
// HTTP and WebSocket on 127.0.0.1:8796 (BATTLE_PORT): GET /health, GET /battle, ws /game for the
// game window, and POST /battle/start {card} and /battle/stop for the Arena Setup page (with the
// referee's ARENA_TOKEN from .env). Browsers are refused (they always send an Origin), like the
// adapter's own server. Mission Control battle cards are off unless BATTLE_FROM_MC=1.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { BattleConfig } from "./battle/card.ts";
import { type ChatResult, Commander, type ModelClient, SYSTEM_PROMPT, TOOLS, type TurnLog, type WarRpc } from "./battle/commander.ts";
import { BattleLobby, type BattleResult, type McClient, type McTask } from "./battle/lobby.ts";
import { type GameSettings, parseSettingsCard, pickSettingsTask, type SettingsTask } from "./settings-card.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env: Record<string, string> = { ...Object.fromEntries((() => {
  try {
    return readFileSync(join(ROOT, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]);
  } catch {
    return [];
  }
})()), ...(process.env as Record<string, string>) };
const PORT = Number(env.BATTLE_PORT ?? 8796);
const MC_URL = env.MC_URL ?? "http://127.0.0.1:3001";
const MC_KEY = env.MC_API_KEY ?? "";
const POLL_MS = Number(env.BATTLE_POLL_MS ?? 4000);
const FROM_MC = env.BATTLE_FROM_MC === "1";
const ARENA_TOKEN = env.ARENA_TOKEN ?? "";
// Model players reach their providers through the key gateway (tools/arena_setup.mjs), which holds
// the keys; this service never sees one.
const GATEWAY_URL = env.GATEWAY_URL ?? "http://127.0.0.1:8795";

const safe = (s: string, max = 4900) => {
  const t = s.replace(/@/g, "＠"); // Mission Control treats @name as a mention
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

async function mcApi(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(MC_URL + path, {
    method,
    headers: { "x-api-key": MC_KEY, "content-type": "application/json", "x-agent-name": "outpost-war" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Mission Control ${method} ${path}: ${r.status}`);
  return r.json().catch(() => ({}));
}

const mc: McClient = {
  async inProgress() {
    const res = await mcApi("GET", "/api/tasks?status=in_progress&limit=100");
    return (Array.isArray(res) ? res : res?.tasks ?? []) as McTask[];
  },
  async comment(id, text) {
    await mcApi("POST", `/api/tasks/${id}/comments`, { content: safe(text) });
  },
  async done(id, notes) {
    // Mission Control lets a task reach "done" only through an approved quality review.
    await mcApi("POST", "/api/quality-review", { taskId: id, reviewer: "aegis", status: "approved", notes });
  },
};

let gameSocket: WebSocket | null = null;
const game = {
  connected: () => gameSocket !== null && gameSocket.readyState === gameSocket.OPEN,
  send: (msg: Record<string, unknown>) => {
    if (gameSocket && gameSocket.readyState === gameSocket.OPEN) gameSocket.send(JSON.stringify(msg));
  },
};

// Opens the game window in Outpost War when a battle is waiting and no window is connected.
const launchGame =
  env.BATTLE_LAUNCH_GAME === "0"
    ? null
    : () => {
        const child = spawn("godot", ["--path", join(ROOT, "game"), "--", "--mode=outpost-war"], { detached: true, stdio: "ignore" });
        child.unref();
        console.log(`[battle] opened Outpost War (pid ${child.pid})`);
      };

const lobby = new BattleLobby(mc, game, launchGame);
// The battlefield a card names (or a random one) from design/maps.json, for the game to dress the
// map in (game/source/war/WarDressing.gd). "none" keeps Open RTS's plain map.
lobby.prepare = (config) => {
  if (config.battlefield === "none") {
    config.field = null;
    return [];
  }
  let fields: Record<string, any> = {};
  try {
    fields = JSON.parse(readFileSync(join(ROOT, "design", "maps.json"), "utf8")).battlefields ?? {};
  } catch {
    return ["design/maps.json is missing or unreadable"];
  }
  const ids = Object.keys(fields);
  const id = config.battlefield === "random" ? ids[Math.floor(Math.random() * ids.length)] : config.battlefield;
  const f = fields[id];
  if (!f) return [`unknown battlefield "${config.battlefield}" (${ids.join(", ")}, random or none)`];
  const kinds = (items: any[] = []) => items.map((i) => ({ kind: i.kind, ...(i.liquid ? { liquid: i.liquid } : {}) }));
  config.field = { id, name: f.name, terrain: f.terrain, obstacles: kinds(f.obstacles), structures: kinds(f.structures) };
  return [];
};
lobby.on("started", (id: string) => console.log(`[battle] ${id} started`));
lobby.on("finished", (id: string, r: BattleResult) => console.log(`[battle] ${id} over: ${r.reason}, winner ${r.winner}`));

// ---- model players (docs/rts-arena.md) ----

let pendingReq = 0;
const pending = new Map<number, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
const rpc: WarRpc = {
  request(msg, timeoutMs = 10_000) {
    if (!game.connected()) return Promise.resolve({ error: "no game window" });
    const req = ++pendingReq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(req);
        resolve({ error: "the game did not answer" });
      }, timeoutMs);
      pending.set(req, { resolve, timer });
      game.send({ ...msg, req });
    });
  },
};
function answer(msg: any): void {
  const p = pending.get(Number(msg?.req));
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(Number(msg.req));
  p.resolve({ data: msg.data, error: msg.error });
}

// The local model serves one request at a time (docs/arena.md §8c): Ollama players take turns.
let ollamaQueue: Promise<unknown> = Promise.resolve();
const modelClient: ModelClient = {
  chat(model, body) {
    const call = async (): Promise<ChatResult> => {
      const r = await fetch(`${GATEWAY_URL}/llm/war/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arena-token": ARENA_TOKEN },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 240)}`);
      const j = JSON.parse(text);
      const message = j.choices?.[0]?.message ?? {};
      const used = (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0);
      const estimate = Math.ceil((JSON.stringify(body.messages ?? "").length + JSON.stringify(message).length) / 4);
      return { message, tokens: used || estimate };
    };
    if (!model.startsWith("ollama:")) return call();
    const turn = ollamaQueue.then(call, call);
    ollamaQueue = turn.catch(() => {});
    return turn;
  },
};

// ---- prompt logs (docs/rts-arena.md): battle-logs/<battle id>/ (gitignored) ----
// battle.json (setup, result, each model's totals), and per model player <colour>.jsonl (one line
// per turn: the prompt, the model's reply and tool calls, each order's result, tokens, time) and
// <colour>.md (the same as a readable transcript).
const LOG_ROOT = join(ROOT, "battle-logs");
let logDir: string | null = null;

function startLogs(id: string, config: BattleConfig) {
  logDir = join(LOG_ROOT, id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "battle.json"), JSON.stringify({ id, startedAt: new Date().toISOString(), config }, null, 2));
  for (const p of config.players.filter((x) => x.controller === "model")) {
    const md = [
      `# ${id}: ${p.color} played by ${p.model}`,
      "",
      `${config.mapName}${config.field ? `, battlefield ${config.field.name} (${config.field.terrain})` : ""}; speed ${config.speed}x, ${config.minutes} game minutes, budget ${config.budget} tokens.`,
      `Players: ${config.players.map((x) => `${x.color} (${x.controller === "model" ? x.model : x.controller})`).join(", ")}.`,
      "",
      "## System prompt (the same every turn)",
      "",
      "```",
      SYSTEM_PROMPT(p.color),
      "```",
      "",
      `Tools: ${TOOLS.map((t) => t.function.name).join(", ")}.`,
      "",
    ];
    writeFileSync(join(logDir, `${p.color}.md`), md.join("\n"));
    writeFileSync(join(logDir, `${p.color}.jsonl`), "");
  }
}

function logTurn(color: string, t: TurnLog) {
  if (!logDir) return;
  appendFileSync(join(logDir, `${color}.jsonl`), JSON.stringify(t) + "\n");
  const calls = t.reply.tool_calls.map((c) => `- \`${c.name}(${c.arguments})\``).join("\n") || "(none)";
  const md = [
    `## Turn ${t.turn}: ${t.at.slice(11, 19)}, ${t.seconds.toFixed(1)} s, ${t.tokens} tokens (${t.tokensTotal} so far)`,
    "",
    t.error ? `**The call failed:** ${t.error}\n` : "",
    "<details><summary>Prompt (what the side saw)</summary>",
    "",
    "```",
    t.prompt,
    "```",
    "</details>",
    "",
    t.reply.content ? `Model wrote: ${t.reply.content}\n` : "",
    "Tool calls:",
    calls,
    "",
    "Results:",
    t.results.map((r) => `- ${r}`).join("\n") || "(none)",
    "",
  ];
  appendFileSync(join(logDir, `${color}.md`), md.filter((l) => l !== "").join("\n") + "\n\n");
}

function finishLogs(id: string) {
  if (!logDir) return;
  try {
    const file = join(logDir, "battle.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    const last = lobby.last?.id === id ? lobby.last : null;
    record.endedAt = new Date().toISOString();
    record.result = last ? last.result : { winner: null, reason: "stopped before the end" };
    record.commanders = commanders.map((c) => c.stats());
    writeFileSync(file, JSON.stringify(record, null, 2));
  } catch {}
  logDir = null;
}

let commanders: Commander[] = [];
lobby.on("started", (id: string, config: BattleConfig) => {
  for (const c of commanders) c.stop();
  startLogs(id, config);
  commanders = config.players
    .filter((p) => p.controller === "model" && p.model)
    .map((p) => new Commander(p.color, p.model!, config.budget, rpc, modelClient));
  for (const c of commanders) {
    console.log(`[battle] ${c.color} is played by ${c.model}`);
    c.on("log", (t: TurnLog) => logTurn(c.color, t));
    void c.start();
  }
});
lobby.on("ended", (id: string) => {
  for (const c of commanders) c.stop();
  if (lobby.last?.id === id) {
    lobby.last.commanders = commanders.map((c) => c.stats());
    // The game's ending screen shows each model's turns, tokens and orders.
    game.send({ type: "battle.summary", id, commanders: lobby.last.commanders });
  }
  finishLogs(id);
  commanders = [];
});

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (!trusted(req)) return json(res, 403, { error: "forbidden" });
  if (req.url === "/health") return json(res, 200, { ok: true, game: game.connected(), phase: lobby.phase });
  if (req.url === "/battle" && req.method === "GET")
    return json(res, 200, { phase: lobby.phase, game: game.connected(), source: lobby.source, id: lobby.battleId, taskId: lobby.taskId, config: lobby.config, startedAt: lobby.startedAt, commanders: commanders.map((c) => c.stats()), last: lobby.last, fromMissionControl: FROM_MC });
  if (req.method === "POST" && (req.url === "/battle/start" || req.url === "/battle/stop")) {
    if (!ARENA_TOKEN || !sameToken(String(req.headers["x-arena-token"] ?? ""), ARENA_TOKEN)) return json(res, 401, { error: "bad token" });
    if (req.url === "/battle/stop") return json(res, 200, { ok: lobby.stopLocal() });
    let body: any;
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "bad JSON" });
    }
    const r = lobby.startLocal(String(body?.card ?? ""));
    return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, id: r.id, phase: lobby.phase } : { error: r.errors.join("; "), errors: r.errors });
  }
  json(res, 404, { error: "not found" });
});

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function trusted(req: IncomingMessage): boolean {
  const port = (http.address() as AddressInfo | null)?.port ?? PORT;
  return !req.headers.origin && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host ?? "");
}

const wss = new WebSocketServer({ server: http, path: "/game", maxPayload: 64 * 1024, verifyClient: (info: { req: IncomingMessage }) => trusted(info.req) });
wss.on("connection", (ws) => {
  // One game window drives battles; a newer one replaces it.
  if (gameSocket && gameSocket !== ws) gameSocket.close(4000, "replaced by a newer game window");
  gameSocket = ws;
  console.log("[battle] game window connected");
  game.send({ type: "hello", phase: lobby.phase, taskId: lobby.taskId });
  game.send({ type: "settings", settings: currentSettings });
  lobby.gameConnected();
  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.type === "battle.finished") void lobby.finished(msg as BattleResult);
    else if (msg?.type === "war.reply") answer(msg);
  });
  ws.on("close", () => {
    if (gameSocket !== ws) return;
    gameSocket = null;
    console.log("[battle] game window disconnected");
    void lobby.gameDisconnected();
  });
});

http.listen(PORT, "127.0.0.1", () =>
  console.log(`[battle] Outpost War lobby on 127.0.0.1:${PORT} for Arena Setup; Mission Control battle cards ${FROM_MC && MC_KEY ? `on (${MC_URL})` : "off"}`),
);
const tick = () => void lobby.poll().finally(() => setTimeout(tick, POLL_MS));
if (MC_KEY && FROM_MC) setTimeout(tick, 1000);

// The settings card (docs/settings.md) for Outpost War windows: which game to show and the
// display settings. When the colony adapter also runs, it comments on a bad card, not this.
let currentSettings: GameSettings | null = null;
let settingsVersion = "";
async function pollSettings(): Promise<void> {
  let tasks: SettingsTask[] = [];
  try {
    const res = await mcApi("GET", "/api/tasks?limit=200");
    tasks = Array.isArray(res) ? res : res?.tasks ?? [];
  } catch {
    return;
  }
  const task = pickSettingsTask(tasks);
  const version = task ? `${task.id}|${task.updated_at}|${task.description}` : "";
  if (version === settingsVersion) return;
  settingsVersion = version;
  const r = task ? parseSettingsCard(task.description ?? "") : null;
  if (r && !r.ok) {
    const adapterUp = await fetch("http://127.0.0.1:8771/health", { signal: AbortSignal.timeout(1500) }).then((x) => x.ok).catch(() => false);
    if (!adapterUp) await mc.comment(task!.id, `These settings cannot be applied:\n- ${r.errors.join("\n- ")}\nFix the description; the change is picked up automatically.`).catch(() => {});
    return;
  }
  currentSettings = r && r.ok ? r.settings : null;
  game.send({ type: "settings", settings: currentSettings });
  console.log(`[battle] settings ${task ? `from task ${task.id}` : "cleared"}: ${JSON.stringify(currentSettings)}`);
}
const settingsTick = () => void pollSettings().finally(() => setTimeout(settingsTick, 5000));
if (MC_KEY) setTimeout(settingsTick, 800);
