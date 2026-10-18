// The Arena's own HTTP API, on a port reachable from the Hermes containers (the plugin's
// colony tools call it). Every request needs the shared token; nothing else is served.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Arena } from "./arena.ts";

const MAX_BODY = 64 * 1024;

export function startArenaServer(arena: Arena, port: number, token: string, host = "0.0.0.0"): Promise<Server> {
  const http = createServer((req, res) => {
    serve(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const given = req.headers["x-arena-token"];
    if (!token || given !== token) return json(403, { error: "forbidden" });
    const path = (req.url ?? "").split("?")[0];
    const parts = path.split("/").filter(Boolean); // ["arena", team, "action"]
    if (req.method === "GET" && parts[0] === "arena" && parts.length === 1) return json(200, { match: arena.match });
    if (req.method === "GET" && parts[0] === "arena" && parts[2] === "observation") return json(200, arena.observation());
    if (req.method === "POST" && parts[0] === "arena" && parts[2] === "action") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return json(413, { error: "too large" });
      }
      let cmd: { tool?: unknown; args?: unknown; latencyS?: unknown };
      try {
        cmd = JSON.parse(body || "{}");
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const tool = typeof cmd.tool === "string" ? cmd.tool : "";
      const args = cmd.args && typeof cmd.args === "object" ? (cmd.args as Record<string, unknown>) : {};
      const latency = typeof cmd.latencyS === "number" ? cmd.latencyS : null;
      const r = arena.action(tool, args, latency);
      if (tool === "colony_state" && r.ok) return json(200, { ...r, observation: arena.observation() });
      return json(r.ok ? 200 : 400, r);
    }
    if (req.method === "POST" && parts[0] === "arena" && parts[1] === "start") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        return json(200, { match: arena.start(JSON.parse(body || "{}")) });
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === "POST" && parts[0] === "arena" && parts[1] === "stop") return json(200, { result: arena.stop("stopped by request") });
    if (req.method === "POST" && parts[0] === "arena" && parts[2] === "usage") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        arena.providerUsage(Number(JSON.parse(body || "{}").tokens));
        return json(200, { ok: true });
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === "POST" && parts[0] === "arena" && parts[2] === "scoreboard") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const b = JSON.parse(body || "{}");
        const o = b.outcome && typeof b.outcome === "object" ? { winner: typeof b.outcome.winner === "string" ? b.outcome.winner : null, reason: String(b.outcome.reason ?? "").slice(0, 200) } : undefined;
        arena.setScoreboard(Array.isArray(b.scoreboard) ? b.scoreboard : [], Array.isArray(b.bases) ? b.bases : undefined, typeof b.map === "string" ? b.map : undefined, o);
        return json(200, { ok: true });
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    json(404, { error: "not found" });
  };
  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
