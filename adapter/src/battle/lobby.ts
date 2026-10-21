// Outpost War's lobby (docs/outpost-war.md). Battles are set up on the Arena Setup page, which
// hands the lobby a battle card (card.ts) through startLocal(); stopLocal() ends it, and the
// result stays in `last` for the page. Optionally (BATTLE_FROM_MC=1) Mission Control tasks work
// too: a task in "in progress" whose description holds a battle card starts that battle, moving it
// out of "in progress" stops it, the result comes back as a comment and the task is marked done,
// and a card with mistakes gets one comment listing them.
import { EventEmitter } from "node:events";
import { type BattleConfig, parseCard } from "./card.ts";

export interface McTask {
  id: number;
  title?: string;
  description?: string;
  status?: string;
  updated_at?: number | string;
}

export interface McClient {
  inProgress(): Promise<McTask[]>;
  comment(id: number, text: string): Promise<void>;
  done(id: number, notes: string): Promise<void>;
}

// The game window's side of the link (server.ts implements it over a WebSocket).
export interface GameLink {
  connected(): boolean;
  send(msg: Record<string, unknown>): void;
}

export interface BattleResult {
  winner: string | null; // a colour, or null
  reason: string;
  gameTimeS: number;
  players: { color: string; controller: string; units: number; structures: number; alive: boolean }[];
}

export type LobbyPhase = "idle" | "waiting_for_game" | "running";
export type BattleSource = "setup" | "mission-control";

export interface LastBattle {
  id: string;
  taskId: number | null;
  source: BattleSource;
  config: BattleConfig;
  result: BattleResult;
  endedAt: number;
  commanders?: unknown[]; // the model players' turns, tokens and last orders (battle-main.ts)
}

export class BattleLobby extends EventEmitter {
  phase: LobbyPhase = "idle";
  taskId: number | null = null; // the Mission Control task, for card battles
  source: BattleSource | null = null;
  battleId: string | null = null;
  config: BattleConfig | null = null;
  startedAt: number | null = null;
  last: LastBattle | null = null;
  // Tasks already handled (started, rejected or abandoned) at a given version; moving a task out
  // of "in progress" and back (a new updated_at) or editing its card queues it again.
  private handled = new Map<number, string>();
  private launched = false;
  private count = 0;
  // Resolves what the card only names (battle-main: the battlefield from design/maps.json);
  // returns problems that stop the battle.
  prepare: (config: BattleConfig) => string[] = () => [];

  private mc: McClient;
  private game: GameLink;
  private launchGame: (() => void) | null;

  constructor(mc: McClient, game: GameLink, launchGame: (() => void) | null = null) {
    super();
    this.mc = mc;
    this.game = game;
    this.launchGame = launchGame;
  }

  private version(t: McTask): string {
    return `${t.updated_at ?? ""}|${t.description ?? ""}`;
  }

  async poll(): Promise<void> {
    let tasks: McTask[];
    try {
      tasks = await this.mc.inProgress();
    } catch {
      return; // Mission Control down: try again next poll
    }
    const cards = tasks.filter((t) => /^\s*battle\s*:\s*$/im.test(t.description ?? ""));
    if (this.source === "mission-control" && this.taskId !== null && this.phase !== "idle" && !cards.some((t) => t.id === this.taskId)) {
      // The task left "in progress" (done or cancelled in Mission Control): stop the battle.
      const id = this.taskId;
      if (this.phase === "running") this.game.send({ type: "battle.stop", reason: "stopped from Mission Control" });
      this.reset();
      await this.mc.comment(id, "Battle stopped from Mission Control.").catch(() => {});
      return;
    }
    if (this.phase === "running") return;
    if (this.phase === "waiting_for_game") {
      if (this.game.connected()) this.start();
      return;
    }
    for (const t of cards) {
      if (this.handled.get(t.id) === this.version(t)) continue;
      this.handled.set(t.id, this.version(t));
      const parsed = parseCard(t.description ?? "");
      const problems = parsed.ok ? this.prepare(parsed.config) : [];
      const r = problems.length ? { ok: false as const, errors: problems } : parsed;
      if (!r.ok) {
        await this.mc.comment(t.id, `This battle card cannot start:\n- ${r.errors.join("\n- ")}\nFix the description; the change is picked up automatically.`).catch(() => {});
        continue;
      }
      if (!this.begin("mission-control", r.config, t.id)) await this.note("Battle accepted; opening Outpost War. It starts as soon as the game window is ready.");
      return;
    }
  }

  // A battle from the Arena Setup page: the card text it built from its form.
  startLocal(cardText: string): { ok: true; id: string } | { ok: false; errors: string[] } {
    if (this.phase !== "idle") return { ok: false, errors: ["a battle is already running; stop it first"] };
    const r = parseCard(cardText);
    if (!r.ok) return r;
    const problems = this.prepare(r.config);
    if (problems.length) return { ok: false, errors: problems };
    this.begin("setup", r.config, null);
    return { ok: true, id: this.battleId! };
  }

  stopLocal(): boolean {
    if (this.phase === "idle") return false;
    if (this.phase === "running") this.game.send({ type: "battle.stop", reason: "stopped from Arena Setup" });
    const id = this.taskId;
    const fromMc = this.source === "mission-control";
    this.reset();
    if (fromMc && id !== null) void this.mc.comment(id, "Battle stopped from Arena Setup.").catch(() => {});
    return true;
  }

  // Starts the battle now (true) or once a game window connects (false).
  private begin(source: BattleSource, config: BattleConfig, taskId: number | null): boolean {
    this.source = source;
    this.taskId = taskId;
    this.config = config;
    this.battleId = taskId !== null ? `task-${taskId}` : `setup-${Date.now()}-${++this.count}`;
    if (this.game.connected()) {
      this.start();
      return true;
    }
    this.phase = "waiting_for_game";
    if (this.launchGame && !this.launched) {
      this.launched = true;
      this.launchGame();
    }
    return false;
  }

  // A comment on the Mission Control task, for card battles only.
  private async note(text: string): Promise<void> {
    if (this.source === "mission-control" && this.taskId !== null) await this.mc.comment(this.taskId, text).catch(() => {});
  }

  private start(): void {
    if (!this.config || !this.battleId) return;
    this.phase = "running";
    this.startedAt = Date.now();
    this.game.send({ type: "battle.start", id: this.battleId, battle: this.config });
    const c = this.config;
    const who = c.players.map((p) => `${p.color} ${p.controller}`).join(", ");
    void this.note(`Battle started on ${c.mapName}: ${who}. Speed ${c.speed}×, ${c.minutes ? `${c.minutes} game minutes` : "no time limit"}, fog ${c.fog ? "on" : "off"}.`);
    this.emit("started", this.battleId, c);
  }

  // The game window connected (again): a battle waiting for it starts now.
  gameConnected(): void {
    this.launched = false;
    if (this.phase === "waiting_for_game") this.start();
  }

  // The game window closed mid-battle: the battle is abandoned; the task stays in Mission Control.
  async gameDisconnected(): Promise<void> {
    if (this.phase !== "running") return;
    if (this.config && this.battleId) this.last = { id: this.battleId, taskId: this.taskId, source: this.source!, config: this.config, result: { winner: null, reason: "the game window closed; the battle was abandoned", gameTimeS: 0, players: [] }, endedAt: Date.now() };
    await this.note("The game window closed; the battle was abandoned. Move the task out of and back into In progress to play it again.");
    this.reset();
  }

  async finished(result: BattleResult): Promise<void> {
    if (this.phase !== "running" || !this.config || !this.battleId) return;
    const id = this.taskId;
    const fromMc = this.source === "mission-control";
    this.last = { id: this.battleId, taskId: id, source: this.source!, config: this.config, result, endedAt: Date.now() };
    const battleId = this.battleId;
    this.reset();
    const mins = Math.floor(result.gameTimeS / 60);
    const secs = Math.round(result.gameTimeS % 60);
    const lines = [
      `Battle over: ${result.reason}. Winner: ${result.winner ?? "none"}.`,
      `Game time ${mins}:${String(secs).padStart(2, "0")}.`,
      ...result.players.map((p) => `- ${p.color} (${p.controller}): ${p.alive ? `${p.units} units, ${p.structures} buildings left` : "destroyed"}`),
    ];
    if (fromMc && id !== null) {
      await this.mc.comment(id, lines.join("\n")).catch(() => {});
      await this.mc.done(id, `Winner: ${result.winner ?? "none"} (${result.reason})`).catch(() => {});
    }
    this.emit("finished", battleId, result);
  }

  // "ended" fires for every battle that stops, however it stops (result, Stop, window closed).
  private reset(): void {
    const id = this.battleId;
    this.phase = "idle";
    this.taskId = null;
    this.source = null;
    this.battleId = null;
    this.config = null;
    this.startedAt = null;
    if (id) this.emit("ended", id);
  }
}
