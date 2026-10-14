import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";
import type { Source } from "./source.ts";
import { FakeSource } from "./sources/fake.ts";
import { HermesSource } from "./sources/hermes.ts";
import { Base } from "./base.ts";
import { loadLayout } from "./layout.ts";
import { MissionControlSink } from "./sinks/mission-control.ts";
import { World } from "./world.ts";

// Settings come from the environment, falling back to the repo's .env (scripts/gen-env.sh).
const dotenv = new URL("../../.env", import.meta.url);
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const env = process.env;
const port = Number(env.ADAPTER_PORT ?? 8771);
const sourceName = env.ADAPTER_SOURCE ?? "fake";

async function makeSource(name: string): Promise<Source> {
  if (name === "fake") {
    return new FakeSource({
      speed: Number(env.FAKE_SPEED ?? 1),
      loop: env.FAKE_LOOP === "1",
      autoApproveMs: env.FAKE_AUTO_APPROVE_MS === "off" ? null : Number(env.FAKE_AUTO_APPROVE_MS ?? 20000),
    });
  }
  if (name === "hermes") {
    return new HermesSource({
      baseUrl: env.HERMES_URL ?? "http://127.0.0.1:8101",
      token: env.HERMES_TOKEN ?? "dev_master_token",
      requireApproval: env.ADAPTER_REQUIRE_APPROVAL !== "0",
      costBudgetUsd: env.ADAPTER_COST_BUDGET_USD ? Number(env.ADAPTER_COST_BUDGET_USD) : 0.5,
    });
  }
  throw new Error(`unknown ADAPTER_SOURCE "${name}"`);
}

// The player's base (Build mode) lives next to the other runtime data.
const layoutPath = env.LAYOUT_PATH ?? fileURLToPath(new URL("../../.data/base.json", import.meta.url)); // spaces in paths stay spaces
const world = new World(sourceName, Date.now, loadLayout(layoutPath));
// Finished missions survive restarts (the game lists them and reopens their reports).
const historyPath = join(dirname(layoutPath), "missions.json");
try {
  const saved = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
  if (Array.isArray(saved)) world.history = saved;
} catch {
  /* a damaged history file just starts empty */
}
// Saved atomically (temp file + rename) and never allowed to break the mission that ended.
world.on("history", (h) => {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(`${historyPath}.tmp`, JSON.stringify(h, null, 2));
    renameSync(`${historyPath}.tmp`, historyPath);
  } catch (e) {
    console.error(`[adapter] could not save mission history: ${e}`);
  }
});
const source = await makeSource(sourceName);
await source.start(world);

let sink: MissionControlSink | null = null;
if (env.MC_URL && env.MC_API_KEY && env.MC_SYNC !== "0") {
  sink = new MissionControlSink({
    url: env.MC_URL.replace(/\/$/, ""),
    apiKey: env.MC_API_KEY,
    // "ollama/" makes Mission Control price it as a (free) local provider.
    model: env.ADAPTER_MODEL_LABEL ?? (sourceName === "fake" ? "simulated/fake-source" : "ollama/agentrts-qwen3"),
    onApproval: (id, approved) => void source.resolveApproval(id, approved),
  });
  await sink.start(world);
}

await startServer(world, source, port, "127.0.0.1", new Base(world, source, layoutPath));
console.log(`[adapter] source=${sourceName} ws://127.0.0.1:${port}/world mission-control=${sink ? env.MC_URL : "off"}`);

if (env.ADAPTER_VERBOSE === "1") world.on("message", (m) => console.log(JSON.stringify(m)));

const shutdown = async () => {
  sink?.stop();
  await source.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
