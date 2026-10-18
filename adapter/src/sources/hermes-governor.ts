// The Governor: the Hermes sub-agent that plays the Arena for a team. Each game hour the
// referee sends it the observation; it answers by calling the plugin's colony tools (which
// hit the Arena API) and a one-line reply. One chat per match keeps its short memory.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface GovernorOpts {
  baseUrl: string; // http://127.0.0.1:8101
  token: string;
  agentId?: string; // "governor"
  timeoutMs?: number;
}

export interface GovernorReply {
  text: string;
  tokens: number;
  latencyS: number;
  timedOut: boolean;
}

export class HermesGovernor {
  private opts: Required<GovernorOpts>;
  chatId = `arena_${randomUUID().slice(0, 8)}`;
  private routed = false;
  private estimated = 0; // cumulative estimate for this chat when Hermes reports nothing

  constructor(opts: GovernorOpts) {
    this.opts = { agentId: "governor", timeoutMs: 70_000, ...opts };
  }

  newChat(): void {
    this.chatId = `arena_${randomUUID().slice(0, 8)}`;
    this.routed = false;
    this.estimated = 0;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hermes ${method} ${path}: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async ask(prompt: string): Promise<GovernorReply> {
    if (!this.routed) {
      await this.api("POST", `/api/history/${this.chatId}/agent`, { agent_id: this.opts.agentId });
      this.routed = true;
    }
    const started = Date.now();
    const wsUrl = this.opts.baseUrl.replace(/^http/, "ws") + `/api/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(wsUrl);
    let tokens = 0;
    return new Promise<GovernorReply>((resolve) => {
      let done = false;
      const finish = (text: string, timedOut: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* closed */
        }
        // Hermes does not always report this chat in logs_update; fall back to an estimate
        // (four characters a token) so the budget still counts the round.
        const estimate = Math.ceil((prompt.length + text.length) / 4);
        if (tokens === 0) this.estimated += estimate;
        resolve({ text, tokens: tokens > 0 ? tokens : this.estimated, latencyS: Math.round((Date.now() - started) / 100) / 10, timedOut });
      };
      const timer = setTimeout(() => finish("", true), this.opts.timeoutMs);
      ws.on("open", () => ws.send(JSON.stringify({ type: "chat_message", content: prompt, chat_id: this.chatId })));
      ws.on("message", (data) => {
        let frame: any;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (frame?.type === "logs_update") {
          const entry = (frame.logs ?? []).find((l: any) => l?.session_id === this.chatId);
          if (entry) tokens = Math.max(tokens, Number(entry.prompt_tokens_estimate ?? 0) + Number(entry.completion_tokens_estimate ?? 0));
        }
        if (frame?.type === "chat_message" && frame.role === "assistant" && String(frame.chat_id) === this.chatId) finish(String(frame.content ?? ""), false);
      });
      ws.on("error", () => finish("", true));
      ws.on("close", () => finish("", true));
    });
  }
}

// What the Governor is told each hour (the observation follows as JSON).
// What the objective counts, in one line the model cannot miss (small models build forever
// unless told which call scores).
function goalLine(observation: unknown): string | null {
  const o = (observation ?? {}) as { match?: { objective?: string; mode?: string } | null; colonists?: { awake?: number; cryo?: number; beds?: number }; stocks?: { medicine?: number; materials?: number }; buildings?: { type: string; enabled: boolean }[] };
  if (o.match?.objective === "lifeline") {
    const names: Record<string, string> = { waterExtractor: "waterExtractor", hydroponics: "hydroponics", solarArray: "solarArray", scrapYard: "scrapYard", medBay: "medBay" };
    const missing = Object.keys(names).filter((t) => !(o.buildings ?? []).some((b) => b.type === t && b.enabled));
    return `GOAL: run all five lifelines: waterExtractor, hydroponics, solarArray, scrapYard, medBay${o.match?.mode === "race" ? " (the first team with all five wins)" : ""}. Still missing: ${missing.join(", ") || "none"}. You have ${Math.floor(o.stocks?.materials ?? 0)} materials; only a scrapYard makes more (from salvage), and one construction runs at a time.`;
  }
  const target = o.match?.objective === "sprint" ? 44 : o.match?.objective === "awakening" ? 100 : null;
  if (!target) return null;
  const awake = o.colonists?.awake ?? 0;
  const beds = o.colonists?.beds ?? 0;
  const med = Math.floor(o.stocks?.medicine ?? 0);
  return `GOAL: colonists awake ${awake} of ${target}${o.match?.mode === "race" ? " (the first team there wins)" : ""}. colony_wake(count 1-8) is the move that scores: each colonist costs 2 medicine (you have ${med}) and a free bed (${Math.max(0, beds - awake)} free). Past 40 you need a Med Bay (medicine) and a second Habitat (beds), and water and food for everyone.`;
}

export function roundPrompt(observation: unknown, first: boolean): string {
  const goal = goalLine(observation);
  const rules = first
    ? [
        "You are the Governor of Outpost Zero, a colony on a hostile planet. You play a match: keep the colonists alive and reach the objective before the sols run out.",
        "Act by calling the colony_* tools (colony_build, colony_wake, colony_toggle, colony_research, colony_repair, colony_autonomy, colony_study, colony_path, colony_shutdown_mother, colony_note). Each call is one action; at most a few per hour.",
        "The story advances in chapters: Chapter II opens the ruins (choose a path once), Chapter III splits the machines into factions as MOTHER's influence grows (you may shut MOTHER down), Chapter IV (Alien Tech plus a Relay Dish) unlocks the endings: Exodus (Launch Gantry), New Eden (180 awake, trust) or Singularity (Network Link). Extinction loses.",
        "Rules of thumb: water and food first (Water Extractor, Hydroponics Bay), then a Solar Array and a Scrap Yard for materials; colonists awake are the score in Awakening and Sprint: wake them (colony_wake) as soon as beds and medicine allow while food and water stocks last, and build production behind them; build a Research Lab and use colony_study to earn data; keep the reactor repaired.",
        "Waking costs 2 medicine per colonist (a Med Bay makes more) and needs a free bed (each Habitat sleeps 40). The reactor alone gives about 30 kW: a Solar Array keeps pumps and greenhouses running as the colony grows.",
        "match.battlefield, when set, is the map: its conditions multiply solar output, water production, expedition salvage and the dust-storm chance (below 1 is worse), so weigh builds by them.",
        "Only tool calls change the colony: writing that you built something does nothing. Call the tool, read its result (ok or the reason it was refused), then report only what the tools did. One construction runs at a time; colony_wake can run alongside it. lastActions in the observation lists your previous calls.",
        "If nothing is affordable or useful this hour, do nothing and reply with one short line.",
      ]
    : ["New hour. Act if something useful is affordable; otherwise reply with one short line."];
  return `${[...(goal ? [goal] : []), ...rules].join("\n")}\n\nObservation:\n${JSON.stringify(observation)}`;
}
