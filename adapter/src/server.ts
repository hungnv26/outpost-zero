import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type Base, isLayoutCommand } from "./base.ts";
import type { ClientCommand, ServerMessage } from "./contract.ts";
import { LayoutError } from "./layout.ts";
import { ColonyError, type ColonyRunner } from "./economy.ts";
import type { Arena } from "./arena.ts";
import type { Source } from "./source.ts";
import type { World } from "./world.ts";

const MAX_TITLE = 300;


const MAX_BODY = 64 * 1024; // a command is a few hundred bytes
export function parseCommand(raw: string): ClientCommand | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const c = m as Record<string, unknown>;
  switch (c.type) {
    case "hello":
      return { type: "hello", client: String(c.client ?? "unknown") };
    case "mission.create": {
      const title = typeof c.title === "string" ? c.title.trim().slice(0, MAX_TITLE) : "";
      return title ? { type: "mission.create", title } : null;
    }
    case "approval.resolve":
      return typeof c.id === "string" && typeof c.approved === "boolean"
        ? { type: "approval.resolve", id: c.id, approved: c.approved }
        : null;
    case "mission.cancel":
      return { type: "mission.cancel" };
    case "replay.request":
      return typeof c.missionId === "string" ? { type: "replay.request", missionId: c.missionId } : { type: "replay.request" };
    case "layout.building.upsert":
      return c.building && typeof c.building === "object" ? { type: c.type, building: c.building as Record<string, unknown> } : null;
    case "layout.agent.upsert":
      return c.agent && typeof c.agent === "object" ? { type: c.type, agent: c.agent as Record<string, unknown> } : null;
    case "layout.building.remove":
    case "layout.agent.remove":
      return typeof c.id === "string" ? { type: c.type, id: c.id } : null;
    case "layout.spot.move":
      return typeof c.id === "string" && typeof c.x === "number" && typeof c.z === "number" ? { type: c.type, id: c.id, x: c.x, z: c.z } : null;
    case "layout.reset":
      return { type: "layout.reset" };
    case "layout.organise":
      return { type: "layout.organise" };
    case "layout.terrain":
      return typeof c.terrain === "string" ? { type: "layout.terrain", terrain: c.terrain } : null;
    case "colony.set_speed":
      return typeof c.speed === "number" ? { type: "colony.set_speed", speed: c.speed } : null;
    case "colony.build":
      return typeof c.building === "string"
        ? { type: "colony.build", building: c.building, ...(typeof c.x === "number" && typeof c.z === "number" ? { x: c.x, z: c.z } : {}) }
        : null;
    case "colony.cancel_build":
      return { type: "colony.cancel_build" };
    case "colony.toggle":
      return typeof c.id === "string" && typeof c.enabled === "boolean" ? { type: "colony.toggle", id: c.id, enabled: c.enabled } : null;
    case "colony.wake":
      return typeof c.count === "number" ? { type: "colony.wake", count: c.count } : null;
    case "colony.repair":
      return typeof c.target === "string" ? { type: "colony.repair", target: c.target } : null;
    case "colony.research":
      return typeof c.tier === "string" ? { type: "colony.research", tier: c.tier } : null;
    case "autonomy.set":
      return typeof c.target === "string" && typeof c.level === "number" ? { type: "autonomy.set", target: c.target, level: c.level } : null;
    case "colony.path":
      return typeof c.path === "string" ? { type: "colony.path", path: c.path } : null;
    case "colony.unordered":
      return typeof c.recall === "boolean" ? { type: "colony.unordered", recall: c.recall } : null;
    default:
      return null;
  }
}

// HTTP (health, state, commands for scripts) + WebSocket (/world) for game clients.
export function startServer(world: World, source: Source, port: number, host = "127.0.0.1", base: Base | null = null, colony: ColonyRunner | null = null, arena: Arena | null = null): Promise<Server> {
  const clients = new Set<WebSocket>();

  const handle = async (cmd: ClientCommand): Promise<void> => {
    if (isLayoutCommand(cmd)) {
      if (!base) throw new LayoutError("Build mode is not available.");
      return base.apply(cmd);
    }
    if (cmd.type.startsWith("colony.") || cmd.type.startsWith("autonomy.")) {
      if (!colony) throw new ColonyError("The colony economy is not running.");
      return colony.command((c, r) => {
        switch (cmd.type) {
          case "colony.set_speed":
            return c.setSpeed(cmd.speed);
          case "colony.build":
            return r.build(cmd.building, cmd.x, cmd.z);
          case "colony.cancel_build":
            return r.cancelBuild();
          case "colony.toggle":
            return void c.toggle(cmd.id, cmd.enabled);
          case "colony.wake":
            return c.wake(cmd.count);
          case "colony.repair":
            return c.repair(cmd.target as "reactor");
          case "colony.research":
            return c.research(cmd.tier);
          case "autonomy.set":
            return c.setAutonomy(cmd.target, cmd.level);
          case "colony.path":
            return c.choosePath(cmd.path);
          case "colony.unordered":
            return r.recallUnordered(cmd.recall);
        }
      });
    }
    switch (cmd.type) {
      case "hello":
        return;
      case "mission.create":
        return source.createMission(cmd.title);
      case "approval.resolve":
        return source.resolveApproval(cmd.id, cmd.approved);
      case "mission.cancel":
        return source.cancelMission();
      case "replay.request":
        return; // answered per client (WebSocket) or via GET /replay
    }
  };

  // Only local tools may talk to the adapter: the game and curl send no Origin header,
  // while every web page does. Host must be the loopback name the adapter listens on
  // (stops DNS rebinding). Without this any page in a browser could start missions,
  // approve them or read reports.
  const trusted = (req: IncomingMessage) => {
    const bound = (http.address() as AddressInfo | null)?.port ?? port;
    const host = req.headers.host ?? "";
    return !req.headers.origin && [`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`].includes(host);
  };

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    serve(req, res).catch((e) => {
      // e.g. a client that disconnects mid-body; never let one request take the adapter down
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!trusted(req)) return json(403, { error: "forbidden" });
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") return json(200, { ok: true, source: source.name, clients: clients.size });
    if (req.method === "GET" && path === "/state") return json(200, { seq: world.currentSeq, world: world.snapshot() });
    if (req.method === "GET" && path === "/arena") return json(200, { match: arena?.match ?? null, info: arena?.info() ?? null, observation: arena?.match ? arena.observation() : null });
    if (req.method === "POST" && (path === "/arena/start" || path === "/arena/stop")) {
      if (!arena) return json(404, { error: "no arena" });
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        return json(200, path === "/arena/start" ? { match: arena.start(JSON.parse(body || "{}")) } : { result: arena.stop("stopped by request") });
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === "GET" && path === "/replay") {
      const missionId = new URL(req.url ?? "", "http://x").searchParams.get("missionId") ?? undefined;
      const replay = world.replay(missionId);
      return replay ? json(200, replay) : json(404, { error: "no recorded mission" });
    }
    if (req.method === "POST" && path === "/command") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(415, { error: "send application/json" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return json(413, { error: "command too large" });
      }
      const cmd = parseCommand(body);
      if (!cmd) return json(400, { error: "invalid command" });
      try {
        await handle(cmd);
        return json(200, { ok: true });
      } catch (e) {
        return json(e instanceof LayoutError || e instanceof ColonyError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    json(404, { error: "not found" });
  };

  const wss = new WebSocketServer({ server: http, path: "/world", maxPayload: MAX_BODY, verifyClient: (info: { req: IncomingMessage }) => trusted(info.req) });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", seq: world.currentSeq, world: world.snapshot() } satisfies ServerMessage));
    ws.on("message", (data) => {
      const cmd = parseCommand(data.toString());
      if (!cmd) {
        ws.send(JSON.stringify({ type: "error", seq: world.currentSeq, message: "invalid command" } satisfies ServerMessage));
        return;
      }
      if (cmd.type === "replay.request") {
        const msg: ServerMessage = { type: "replay", seq: world.currentSeq, replay: world.replay(cmd.missionId) };
        ws.send(JSON.stringify(msg));
        return;
      }
      handle(cmd).catch((e) => {
        // Build-mode problems go back to the client that asked; anything else is logged.
        if (e instanceof LayoutError || e instanceof ColonyError) ws.send(JSON.stringify({ type: "error", seq: world.currentSeq, message: e.message } satisfies ServerMessage));
        else world.logLine(`Command ${cmd.type} failed: ${e}`, "error");
      });
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  world.on("message", (msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(text);
  });

  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
