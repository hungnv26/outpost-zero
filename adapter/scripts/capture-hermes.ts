// Phase 0 spike: send one mission to Hermes over its WebSocket and record every frame.
//   node scripts/capture-hermes.ts "Research the Australian EV market" > ../captures/run.jsonl
import WebSocket from "ws";

const base = process.env.HERMES_WS ?? "ws://127.0.0.1:8101/api/ws";
const token = process.env.HERMES_TOKEN ?? "dev_master_token";
const prompt = process.argv[2] ?? "Research the Australian EV market";
const chatId = process.env.CHAT_ID ?? "jarvis";
const limitMs = Number(process.env.CAPTURE_TIMEOUT_MS ?? 900_000);

const t0 = Date.now();
const ws = new WebSocket(`${base}?token=${encodeURIComponent(token)}`);
const out = (o: unknown) => process.stdout.write(JSON.stringify({ t: Date.now() - t0, ...(o as object) }) + "\n");

ws.on("open", () => {
  out({ dir: "out", type: "chat_message", content: prompt, chat_id: chatId });
  ws.send(JSON.stringify({ type: "chat_message", content: prompt, chat_id: chatId }));
});
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === "init") return out({ dir: "in", type: "init", keys: Object.keys(m) });
  out({ dir: "in", ...m });
  if (m.type === "chat_message" && m.role === "assistant" && m.chat_id === chatId) {
    setTimeout(() => process.exit(0), 3000);
  }
});
ws.on("close", (code) => (out({ dir: "close", code }), process.exit(code === 1000 ? 0 : 1)));
setTimeout(() => (out({ dir: "timeout" }), process.exit(2)), limitMs);
