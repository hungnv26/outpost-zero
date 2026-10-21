// The battle card (docs/outpost-war.md): Outpost War's whole setup, written in a Mission Control
// task's description because Mission Control's task form cannot edit metadata. Every setting the
// game used to ask for in its Play and Options screens lives here; the game asks for nothing.
//
//   battle:
//     map: Plain & Simple
//     players:
//       - blue: human
//       - red: ai
//       - green: anthropic:claude-sonnet-5-5   # an AI model (docs/rts-arena.md)
//     speed: 1
//     minutes: 20
//     fog: on
//     screen: window
//     mouse: free
//     budget: 400k        # tokens per model player
//     battlefield: random # one of Outpost Zero's battlefields (design/maps.json), random or none

export const MAPS: Record<string, { name: string; players: number }> = {
  // Outpost Zero's two-player map: the bases face each other across the middle, mirrored.
  Duel: { name: "Duel", players: 2 },
  PlainAndSimple: { name: "Plain & Simple", players: 4 },
  BigArena: { name: "Big Arena", players: 8 },
};

// Open RTS's player colours, in slot order (Constants.Player.COLORS).
export const COLORS = ["blue", "red", "green", "purple", "darkgreen", "khaki", "navy", "turquoise"] as const;
export type Color = (typeof COLORS)[number];
export type Controller = "human" | "ai" | "model";
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter", "ollama"] as const;

export interface BattlePlayer {
  slot: number; // index into COLORS; Outpost War spawns by slot
  color: Color;
  controller: Controller;
  model?: string; // "provider:model" for a model player
}

export interface BattleConfig {
  map: string; // key of MAPS
  mapName: string;
  players: BattlePlayer[];
  speed: number; // game time scale
  minutes: number; // game-time limit (default 30; scripted players can stall, e.g. tanks against a lone helicopter); 0 = until one side is left
  fog: boolean; // false shows the whole map
  screen: "window" | "fullscreen";
  mouse: "free" | "restricted";
  budget: number; // tokens per model player
  battlefield: string; // a design/maps.json battlefield id, "random" or "none" (battle-main resolves it)
  field?: BattlefieldLook | null; // the resolved battlefield, attached by battle-main for the game
}

// What the game needs to dress the map in a battlefield's look (game/source/war/WarDressing.gd).
export interface BattlefieldLook {
  id: string;
  name: string;
  terrain: string;
  obstacles: Record<string, unknown>[];
  structures: Record<string, unknown>[];
}

export type CardResult = { ok: true; config: BattleConfig } | { ok: false; errors: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Finds the card in free text: from a line "battle:" to the end of its indented block (a code
// fence around it is fine).
export function findCard(text: string): string | null {
  const lines = (text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*battle\s*:\s*$/i.test(l));
  if (start < 0) return null;
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*```/.test(l)) break;
    if (l.trim() === "") {
      out.push(l);
      continue;
    }
    if (!/^\s+/.test(l)) break; // dedented: the card is over
    out.push(l);
  }
  return out.join("\n");
}

export function parseCard(text: string): CardResult {
  const card = findCard(text);
  if (card === null) return { ok: false, errors: ["no battle card: start a block with a line `battle:`"] };
  const errors: string[] = [];
  const fields: Record<string, string> = {};
  const playerLines: string[] = [];
  let inPlayers = false;
  for (const raw of card.split("\n").slice(1)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item && inPlayers) {
      playerLines.push(item[1].trim());
      continue;
    }
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push(`could not read "${line.trim()}"`);
      continue;
    }
    const key = kv[1].toLowerCase();
    inPlayers = key === "players" && kv[2].trim() === "";
    if (key === "players" && kv[2].trim()) playerLines.push(...kv[2].split(",").map((s) => s.trim()).filter(Boolean));
    else if (key !== "players") fields[key] = kv[2].trim();
  }

  const known = ["map", "speed", "minutes", "fog", "screen", "mouse", "budget", "battlefield"];
  for (const k of Object.keys(fields)) if (!known.includes(k)) errors.push(`unknown setting "${k}" (known: map, players, ${known.slice(1).join(", ")})`);

  const mapKey = Object.keys(MAPS).find((k) => norm(k) === norm(fields.map ?? "") || norm(MAPS[k].name) === norm(fields.map ?? ""));
  if (!fields.map) errors.push(`map is missing (${Object.values(MAPS).map((m) => m.name).join(" or ")})`);
  else if (!mapKey) errors.push(`unknown map "${fields.map}" (${Object.values(MAPS).map((m) => m.name).join(" or ")})`);

  const players: BattlePlayer[] = [];
  for (const p of playerLines) {
    const m = /^([A-Za-z ]+?)\s*[:=]\s*(.+)$/.exec(p);
    if (!m) {
      errors.push(`player "${p}" should read colour: human or colour: ai`);
      continue;
    }
    const color = COLORS.find((c) => norm(c) === norm(m[1]));
    const raw = m[2].trim();
    const who = raw.toLowerCase();
    if (!color) {
      errors.push(`unknown colour "${m[1]}" (${COLORS.join(", ")})`);
      continue;
    }
    if (players.some((x) => x.color === color)) {
      errors.push(`${color} is listed twice`);
      continue;
    }
    const model = /^([a-z]+)\s*:\s*(\S+)$/i.exec(raw);
    if (model) {
      const provider = model[1].toLowerCase();
      if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
        errors.push(`${color}: unknown provider "${model[1]}" (${MODEL_PROVIDERS.join(", ")})`);
        continue;
      }
      if (!/^[\w./:-]{1,80}$/.test(model[2])) {
        errors.push(`${color}: "${model[2]}" is not a model name`);
        continue;
      }
      players.push({ slot: COLORS.indexOf(color), color, controller: "model", model: `${provider}:${model[2]}` });
      continue;
    }
    if (who !== "human" && who !== "ai") {
      errors.push(`${color}: "${raw}" is not a player type (human, ai, or a model such as anthropic:claude-sonnet-5-5)`);
      continue;
    }
    players.push({ slot: COLORS.indexOf(color), color, controller: who });
  }
  if (playerLines.length === 0) errors.push("players are missing: list at least two, e.g. `- blue: human` and `- red: ai`");
  else if (playerLines.length < 2) errors.push("a battle needs at least two players");
  if (players.filter((p) => p.controller === "human").length > 1) errors.push("only one human player per battle (one game window)");
  const map = mapKey ? MAPS[mapKey] : null;
  if (map) for (const p of players) if (p.slot >= map.players) errors.push(`${p.color} needs slot ${p.slot + 1}, but ${map.name} has ${map.players} (use ${COLORS.slice(0, map.players).join(", ")})`);

  const num = (k: string, def: number, lo: number, hi: number) => {
    if (fields[k] === undefined) return def;
    const v = Number(fields[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      errors.push(`${k} must be a number from ${lo} to ${hi}`);
      return def;
    }
    return v;
  };
  const choice = <T extends string>(k: string, def: T, opts: Record<string, T>): T => {
    if (fields[k] === undefined) return def;
    const v = opts[fields[k].toLowerCase()];
    if (v === undefined) errors.push(`${k} must be ${Object.keys(opts).join(" or ")}`);
    return v ?? def;
  };
  const speed = num("speed", 1, 0.25, 4);
  const minutes = num("minutes", 30, 0, 240);
  const fog = choice("fog", "on", { on: "on", off: "off", yes: "on", no: "off" }) === "on";
  const screen = choice("screen", "window", { window: "window", fullscreen: "fullscreen" });
  const mouse = choice("mouse", "free", { free: "free", restricted: "restricted" });
  let budget = 400_000;
  if (fields.budget !== undefined) {
    const b = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(fields.budget.replace(/[_,]/g, ""));
    const v = b ? Number(b[1]) * (b[2].toLowerCase() === "k" ? 1e3 : b[2].toLowerCase() === "m" ? 1e6 : 1) : NaN;
    if (!Number.isFinite(v) || v < 10_000 || v > 20_000_000) errors.push("budget must be a token count from 10k to 20m, e.g. 400k");
    else budget = Math.round(v);
  }

  const battlefield = (fields.battlefield ?? "random").trim().toLowerCase().replace(/\s+/g, "-") || "random";
  if (!/^[a-z0-9-]{1,40}$/.test(battlefield)) errors.push("battlefield must be a battlefield id, random or none");

  if (errors.length) return { ok: false, errors };
  players.sort((a, b) => a.slot - b.slot);
  return { ok: true, config: { map: mapKey!, mapName: map!.name, players, speed, minutes, fog, screen, mouse, budget, battlefield } };
}
