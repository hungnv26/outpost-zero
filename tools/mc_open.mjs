#!/usr/bin/env node
// Mission Control without a sign-in screen (docs/settings.md). Mission Control itself runs on an
// internal port (127.0.0.1:3011); this relay serves http://127.0.0.1:3001, signs in once with the
// admin account from .env (server-side, never shown) and hands every browser request that session.
// Mission Control's code is unchanged (it is pinned and reinstalled by scripts/setup.sh).
//
// API callers that bring their own key (the adapter, the battle service, the match director) pass
// through untouched. The /login page sends you to the dashboard, and signing out is ignored (it
// would end the shared session). Bound to 127.0.0.1: only this Mac can reach it, and anything on
// this Mac gets Mission Control as admin without a password; that is the point of it.
//   node tools/mc_open.mjs      (scripts/start.sh starts it)
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...Object.fromEntries(
    readFileSync(join(ROOT, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ),
  ...process.env,
};
const PUBLIC_PORT = Number(env.MC_PUBLIC_PORT ?? 3001);
const INTERNAL_PORT = Number(env.MC_INTERNAL_PORT ?? 3011);
const USER = env.MC_ADMIN_USER ?? "admin";
const PASS = env.MC_ADMIN_PASS ?? "";
const SESSION_COOKIES = ["mc-session", "__Host-mc-session", "mc_session"];

let session = ""; // "name=value" of Mission Control's session cookie
let signingIn = null;

function signIn() {
  if (signingIn) return signingIn;
  signingIn = new Promise((resolve) => {
    const body = JSON.stringify({ username: USER, password: PASS });
    const req = http.request(
      { host: "127.0.0.1", port: INTERNAL_PORT, path: "/api/auth/login", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), host: `127.0.0.1:${PUBLIC_PORT}` } },
      (res) => {
        res.resume();
        const cookies = [].concat(res.headers["set-cookie"] ?? []);
        const found = cookies.map((c) => c.split(";")[0]).find((c) => /session/i.test(c.split("=")[0]) && c.split("=")[1]);
        if (found) session = found;
        console.log(found ? `[mc-open] signed in to Mission Control as ${USER}` : `[mc-open] sign-in failed (HTTP ${res.statusCode}); check MC_ADMIN_USER/MC_ADMIN_PASS in .env`);
        signingIn = null;
        resolve(Boolean(found));
      },
    );
    req.on("error", (e) => {
      console.log(`[mc-open] Mission Control not reachable on ${INTERNAL_PORT}: ${e.message}`);
      signingIn = null;
      resolve(false);
    });
    req.end(body);
  });
  return signingIn;
}

const hasOwnKey = (h) => Boolean(h["x-api-key"] || /^(bearer|apikey|token)\s/i.test(String(h.authorization ?? "")));

// The session goes only to requests addressed to this relay by name, from its own pages: a web
// page in another tab (Origin elsewhere) or a DNS-rebinding trick (Host elsewhere) gets none.
const OWN_HOSTS = [`127.0.0.1:${PUBLIC_PORT}`, `localhost:${PUBLIC_PORT}`, `[::1]:${PUBLIC_PORT}`];
const ownRequest = (h) => OWN_HOSTS.includes(String(h.host ?? "")) && (!h.origin || OWN_HOSTS.some((o) => h.origin === `http://${o}`));
const browser = (h) => !hasOwnKey(h) && ownRequest(h);

// The browser's cookies minus any session cookie, plus the relay's session.
function withSession(cookieHeader) {
  const kept = String(cookieHeader ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !SESSION_COOKIES.includes(c.split("=")[0]) && !/session/i.test(c.split("=")[0]));
  if (session) kept.push(session);
  return kept.join("; ");
}

function forward(req, res, body, retried) {
  const headers = { ...req.headers };
  const signed = browser(headers);
  if (signed) headers.cookie = withSession(headers.cookie);
  const up = http.request({ host: "127.0.0.1", port: INTERNAL_PORT, path: req.url, method: req.method, headers }, async (upRes) => {
    const toLogin = upRes.statusCode >= 300 && upRes.statusCode < 400 && /\/login(\?|$)/.test(String(upRes.headers.location ?? ""));
    if (signed && !retried && (toLogin || upRes.statusCode === 401)) {
      upRes.resume();
      await signIn();
      return forward(req, res, body, true);
    }
    const out = { ...upRes.headers };
    if (signed && out["set-cookie"]) {
      out["set-cookie"] = [].concat(out["set-cookie"]).filter((c) => !/session/i.test(c.split("=")[0]));
    }
    res.writeHead(upRes.statusCode ?? 502, out);
    upRes.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Mission Control is not running (scripts/start.sh starts it).");
  });
  up.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (browser(req.headers)) {
    if (path === "/login") {
      res.writeHead(302, { location: "/" });
      return res.end();
    }
    if (path === "/api/auth/logout") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, note: "sign-in is off for this Mac (tools/mc_open.mjs)" }));
    }
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => forward(req, res, Buffer.concat(chunks), false));
});

// WebSocket and other upgrades: pass through with the session added.
server.on("upgrade", (req, socket, head) => {
  const headers = { ...req.headers };
  if (browser(headers)) headers.cookie = withSession(headers.cookie);
  const upstream = net.connect(INTERNAL_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) lines.push(`${k}: ${one}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PUBLIC_PORT, "127.0.0.1", async () => {
  console.log(`[mc-open] Mission Control without sign-in on http://127.0.0.1:${PUBLIC_PORT} (Mission Control itself on ${INTERNAL_PORT})`);
  if (!PASS) console.log("[mc-open] warning: MC_ADMIN_PASS missing in .env; sign-in will fail");
  await signIn();
});
