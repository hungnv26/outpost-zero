import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { type Base, isLayoutCommand } from "./base.ts";
import type { ClientCommand, ServerMessage } from "./contract.ts";
import { LayoutError } from "./layout.ts";
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
    default:
      return null;
  }
}

// HTTP (health, state, commands for scripts) + WebSocket (/world) for game clients.
export function startServer(world: World, source: Source, port: number, host = "127.0.0.1", base: Base | null = null): Promise<Server> {
  const clients = new Set<WebSocket>();

  const handle = async (cmd: ClientCommand): Promise<void> => {
    if (isLayoutCommand(cmd)) {
      if (!base) throw new LayoutError("Build mode is not available.");
      return base.apply(cmd);
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
        return json(e instanceof LayoutError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
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
        if (e instanceof LayoutError) ws.send(JSON.stringify({ type: "error", seq: world.currentSeq, message: e.message } satisfies ServerMessage));
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
