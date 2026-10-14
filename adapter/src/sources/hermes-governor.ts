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

  constructor(opts: GovernorOpts) {
    this.opts = { agentId: "governor", timeoutMs: 70_000, ...opts };
  }

  newChat(): void {
    this.chatId = `arena_${randomUUID().slice(0, 8)}`;
    this.routed = false;
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
        resolve({ text, tokens, latencyS: Math.round((Date.now() - started) / 100) / 10, timedOut });
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
export function roundPrompt(observation: unknown, first: boolean): string {
  const rules = first
    ? [
        "You are the Governor of Outpost Zero, a colony on a hostile planet. You play a match: keep the colonists alive and reach the objective before the sols run out.",
        "Act by calling the colony_* tools (colony_build, colony_wake, colony_toggle, colony_research, colony_repair, colony_autonomy, colony_study, colony_note). Each call is one action; at most a few per hour.",
        "Rules of thumb: water and food first (Water Extractor, Hydroponics Bay), then a Solar Array and a Scrap Yard for materials; wake 8 colonists only when food and water production can carry them and beds are free; build a Research Lab and use colony_study to earn data; keep the reactor repaired.",
        "If nothing is affordable or useful this hour, do nothing and reply with one short line.",
      ]
    : ["New hour. Act if something useful is affordable; otherwise reply with one short line."];
  return `${rules.join("\n")}\n\nObservation:\n${JSON.stringify(observation)}`;
}
