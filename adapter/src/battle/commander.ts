// The Commander (docs/rts-arena.md): one AI model playing one side of an Outpost War battle.
// Each turn it asks the game what its side can see, sends that to the model in a fresh chat with
// the order tools, and has the game carry out the tool calls; the results open the next turn.
// The game never waits: a slow model loses tempo. Out of budget, the side is frozen: its units
// keep their last orders, workers keep gathering, and everything still defends itself.
import { EventEmitter } from "node:events";

export type WarReply = { data?: any; error?: string };

export interface WarRpc {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<WarReply>;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments?: string };
}

export interface ChatResult {
  message: { content?: string | null; tool_calls?: ToolCall[] };
  tokens: number;
}

export interface ModelClient {
  chat(model: string, body: Record<string, unknown>): Promise<ChatResult>;
}

// One turn as it happened, for the battle's prompt log (battle-main.ts writes it to disk).
export interface TurnLog {
  turn: number;
  at: string; // ISO time the model was asked
  seconds: number; // the model's answer time
  tokens: number;
  tokensTotal: number;
  prompt: string; // the user message: what the side could see and its last results
  reply: { content: string | null; tool_calls: { name: string; arguments: string }[] };
  results: string[];
  error?: string;
}

export type CommanderStatus = "starting" | "thinking" | "ordering" | "out of budget" | "eliminated" | "stopped" | "failed";

export interface CommanderStats {
  color: string;
  model: string;
  status: CommanderStatus;
  turns: number;
  tokens: number;
  budget: number;
  avgTurnS: number | null;
  orders: number;
  refused: number;
  errors: number;
  lastError: string | null;
  lastOrders: string[];
}

const MAX_ORDERS_PER_TURN = 8;
const MAX_FAILURES_IN_A_ROW = 6;

export const SYSTEM_PROMPT = (color: string) => `You command the ${color} side in Outpost War, a real-time strategy battle. The other sides are AI models, scripted computer players or a human. A side is out when it has lost all its buildings (finished or being built), whatever units it has left; the last side with buildings wins. At the time limit, the side with the most army and building value wins.

Economy: two resources, a and b. Workers carry 2 at a time from deposits (a takes 1 s to collect, b 2 s) to a command center. Workers with nothing to do gather on their own.
Costs (a, b) and where each comes from:
- worker 2,0 from a command_center
- tank 3,1 from a vehicle_factory (ground unit; hits ground only)
- helicopter 1,3 from an aircraft_factory (air unit; hits ground and air)
- drone 2,0 from an aircraft_factory (fast scout, no weapon)
- command_center 8,8; vehicle_factory 6,0; aircraft_factory 4,4; ground_turret 2,2 (hits ground); air_turret 2,2 (hits air)
A building trains at most 5 units at a time. A worker walks over and builds each new structure. Turrets defend; tanks and helicopters attack. Units with nothing to do fight enemies in range.

How to win (the same advice for every side):
- Resource a is the bottleneck: workers, factories and tanks all need it. Your view's "economy" shows your income per minute, workers on each resource, how many workers your deposits can use ("useful_workers") and what you can afford now. Workers past useful_workers add nothing, and the game refuses them.
- Spending a on a worker every turn means you never reach 6 a for a vehicle_factory. Once you have about useful_workers workers, stop training them and save a for a factory.
- A working opening: workers up to useful_workers, then a vehicle_factory, then tanks. When b piles up, build an aircraft_factory (4 a, 4 b) and helicopters (1 a, 3 b): they are paid mostly in b and hit both ground and air.
- Armies win battles: have a factory by about 45 s of game time, and attack with groups of 5 or more. Tanks cannot hit aircraft; an air_turret or helicopters can.
- Moving a worker to the other resource restarts its trip, so a worker you move keeps its new job for 20 s. Split your workers once (for example most on a, a few on b) and leave them.
- A build you cannot afford yet is planned: its resources are set aside (training tanks, helicopters and drones cannot spend them; workers up to useful_workers still can) and it starts by itself as soon as they are there, so order it once. Your view lists "planned_builds" and what became of them ("planned_build_news").
- A training order refused for cost will be refused again until your income catches up: give a different order, or none, instead of repeating it.

Orders are the tools: build, train, gather, attack (an attack-move: units fight what they meet on the way), move, scout. Places: "base", "center", a grid cell such as "D4", a player colour (their start position) or an id. Units: "army", "tanks", "helicopters", "drones", "workers", or ids such as "t3".

The game keeps running while you think. Each turn you see what your side can see right now and the results of your last orders. Give several orders per turn with the tools. Do not explain.`;

export const TOOLS = [
  tool("build", "Build a structure near a place (a worker walks over and builds it).", {
    structure: { type: "string", enum: ["command_center", "vehicle_factory", "aircraft_factory", "ground_turret", "air_turret"] },
    near: { type: "string", description: 'Where: "base" (default), "center", a cell such as "D4", or an id' },
  }, ["structure"]),
  tool("train", "Train units at your buildings that make them.", {
    unit: { type: "string", enum: ["worker", "tank", "helicopter", "drone"] },
    count: { type: "integer", minimum: 1, maximum: 10 },
  }, ["unit"]),
  tool("gather", "Send workers to gather resource a or b.", {
    resource: { type: "string", enum: ["a", "b"] },
    workers: { type: "integer", minimum: 1, description: "How many workers (default all free workers)" },
  }, ["resource"]),
  tool("attack", "Attack-move units toward an enemy, an enemy id or a place.", {
    target: { type: "string", description: 'An enemy colour (e.g. "red"), an enemy id (e.g. "x4") or a cell' },
    units: { type: "string", description: '"army" (default), "tanks", "helicopters" or comma-separated ids' },
  }, ["target"]),
  tool("move", "Move units to a place without attacking on the way (they still defend themselves there).", {
    units: { type: "string", description: '"army", "tanks", "helicopters", "drones", "workers" or comma-separated ids' },
    to: { type: "string", description: '"base", "center", a cell such as "D4", a colour or an id' },
  }, ["units", "to"]),
  tool("scout", "Send drones (or other units) to look at a place.", {
    to: { type: "string", description: 'A cell such as "H8", "center" or a player colour' },
    units: { type: "string", description: '"drones" (default) or ids' },
  }, ["to"]),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Commander extends EventEmitter {
  readonly color: string;
  readonly model: string;
  readonly budget: number;
  status: CommanderStatus = "starting";
  turns = 0;
  tokens = 0;
  orders = 0;
  refused = 0;
  errors = 0;
  lastError: string | null = null;
  lastOrders: string[] = [];
  private turnSeconds: number[] = [];
  private stopped = false;
  private rpc: WarRpc;
  private client: ModelClient;
  private pauseMs: number;

  constructor(color: string, model: string, budget: number, rpc: WarRpc, client: ModelClient, pauseMs = 1500) {
    super();
    this.color = color;
    this.model = model;
    this.budget = budget;
    this.rpc = rpc;
    this.client = client;
    this.pauseMs = pauseMs;
  }

  start(): Promise<void> {
    return this.loop().catch((e) => {
      this.status = "failed";
      this.lastError = String(e instanceof Error ? e.message : e);
    });
  }

  stop(): void {
    this.stopped = true;
    if (!["out of budget", "eliminated", "failed"].includes(this.status)) this.status = "stopped";
  }

  stats(): CommanderStats {
    const avg = this.turnSeconds.length ? this.turnSeconds.reduce((a, b) => a + b, 0) / this.turnSeconds.length : null;
    return {
      color: this.color,
      model: this.model,
      status: this.status,
      turns: this.turns,
      tokens: this.tokens,
      budget: this.budget,
      avgTurnS: avg === null ? null : Math.round(avg * 10) / 10,
      orders: this.orders,
      refused: this.refused,
      errors: this.errors,
      lastError: this.lastError,
      lastOrders: this.lastOrders,
    };
  }

  private async loop(): Promise<void> {
    let results: string[] = [];
    let failures = 0;
    while (!this.stopped) {
      if (this.tokens >= this.budget) {
        this.status = "out of budget";
        return;
      }
      const seen = await this.rpc.request({ type: "war.observe", color: this.color }).catch((e): WarReply => ({ error: String(e?.message ?? e) }));
      if (this.stopped) return;
      if (seen.error || !seen.data) {
        await sleep(2000); // still loading, or a hiccup on the link
        continue;
      }
      if (seen.data.eliminated) {
        this.status = "eliminated";
        return;
      }
      this.status = "thinking";
      const started = Date.now();
      const prompt = turnText(seen.data, results);
      let reply: ChatResult;
      try {
        reply = await this.client.chat(this.model, {
          messages: [
            { role: "system", content: SYSTEM_PROMPT(this.color) },
            { role: "user", content: prompt },
          ],
          tools: TOOLS,
          tool_choice: "auto",
          max_tokens: 1200,
        });
      } catch (e) {
        this.errors++;
        failures++;
        this.lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
        this.emit("log", { turn: this.turns + 1, at: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000, tokens: 0, tokensTotal: this.tokens, prompt, reply: { content: null, tool_calls: [] }, results: [], error: this.lastError } satisfies TurnLog);
        if (failures >= MAX_FAILURES_IN_A_ROW) {
          this.status = "failed";
          return;
        }
        await sleep(Math.min(30_000, 3000 * failures));
        continue;
      }
      failures = 0;
      if (this.stopped) return;
      this.turns++;
      this.tokens += reply.tokens;
      this.turnSeconds.push((Date.now() - started) / 1000);
      this.status = "ordering";
      results = [];
      const calls = reply.message.tool_calls ?? [];
      for (const call of calls.slice(0, MAX_ORDERS_PER_TURN)) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          results.push(`${call.function.name}: refused: the arguments were not valid JSON`);
          this.refused++;
          continue;
        }
        const order = { ...normalise(args), order: call.function.name };
        const r = await this.rpc.request({ type: "war.order", color: this.color, order }).catch((e): WarReply => ({ error: String(e?.message ?? e) }));
        const ok = !!r.data?.ok;
        this.orders++;
        if (!ok) this.refused++;
        results.push(`${call.function.name}(${short(args)}): ${ok ? "done" : "refused"}: ${r.data?.message ?? r.error ?? "no answer"}`);
        if (this.stopped) return;
      }
      if (calls.length > MAX_ORDERS_PER_TURN) results.push(`only the first ${MAX_ORDERS_PER_TURN} orders were carried out`);
      if (calls.length === 0) results.push(`no orders given${reply.message.content ? ` (you wrote: ${String(reply.message.content).slice(0, 120)})` : ""}; use the tools`);
      this.lastOrders = results;
      this.emit("log", {
        turn: this.turns,
        at: new Date(started).toISOString(),
        seconds: this.turnSeconds[this.turnSeconds.length - 1],
        tokens: reply.tokens,
        tokensTotal: this.tokens,
        prompt,
        reply: { content: reply.message.content ?? null, tool_calls: calls.map((c) => ({ name: c.function.name, arguments: c.function.arguments ?? "" })) },
        results: [...results],
      } satisfies TurnLog);
      this.emit("turn", this.stats());
      await sleep(this.pauseMs);
    }
  }
}

// "units": "t1, t2" becomes a list of ids; numbers stay numbers.
function normalise(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const k of ["units"]) {
    const v = out[k];
    if (typeof v === "string" && v.includes(",")) out[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function short(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") : String(v)}`)
    .join(", ")
    .slice(0, 100);
}

export function turnText(state: unknown, results: string[]): string {
  const lines = [`Your side now (JSON):`, JSON.stringify(state)];
  lines.push("", results.length ? `Results of your last orders:\n- ${results.join("\n- ")}` : "This is your first turn.");
  lines.push("", "Give your orders now with the tools.");
  return lines.join("\n");
}
