import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.ts";
import type { Source } from "./source.ts";
import { FakeSource } from "./sources/fake.ts";
import { HermesSource } from "./sources/hermes.ts";
import { Base } from "./base.ts";
import { loadLayout, saveLayout } from "./layout.ts";
import { MissionControlSink } from "./sinks/mission-control.ts";
import { World } from "./world.ts";
import { Colony, ColonyRunner, loadColonyState, loadDefs } from "./economy.ts";
import { Arena } from "./arena.ts";
import { startArenaServer } from "./arena-server.ts";
import { HermesGovernor, roundPrompt } from "./sources/hermes-governor.ts";

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

// The colony economy (docs/economy.md): numbers from design/economy.json, state next to the base.
let colony: ColonyRunner | null = null;
if (env.COLONY !== "0") {
  const defs = loadDefs(new URL("../../design/economy.json", import.meta.url));
  const colonyPath = join(dirname(layoutPath), "colony.json");
  const saved = loadColonyState(colonyPath);
  colony = new ColonyRunner(new Colony(defs, saved ?? undefined), world, colonyPath, env.COLONY_SECONDS_PER_HOUR ? Number(env.COLONY_SECONDS_PER_HOUR) : undefined);
  colony.onLayout = async (l) => {
    saveLayout(layoutPath, l);
    await source.layoutChanged?.(l);
  };
  colony.source = source;
  if (sourceName === "hermes" && env.MOTHER_VOICE !== "0") {
    const voice = new HermesGovernor({ baseUrl: env.HERMES_URL ?? "http://127.0.0.1:8101", token: env.HERMES_TOKEN ?? "dev_master_token", agentId: "writer", timeoutMs: 50_000 });
    colony.narrate = async (card, c) => {
      voice.newChat();
      const v = c.view();
      const r = await voice.ask(
        `You are MOTHER, the colony AI of Outpost Zero, speaking to the commander. Retell this event in two or three sentences, in the first person, cold and precise, without inventing numbers: "${card.title}: ${card.text}" Colony now: sol ${v.sol}, ${v.colonists.awake} awake, ${v.colonists.cryo} in cryo, trust ${v.trust}, your influence ${v.influence}, chapter ${v.chapter}. Reply with the sentences only.`,
      );
      if (r.tokens > 0) c.useCompute(r.tokens);
      return r.timedOut ? "" : r.text;
    };
  }
  colony.start();
  if (!saved) world.logLine("Sol 0: Odyssey-7 is down. 24 colonists awake, 198 in cryo. Keep them alive.", "warn");
}

const base = new Base(world, source, layoutPath);
if (colony) {
  const runner = colony;
  base.before = (cmd) => {
    if (cmd.type === "layout.building.remove") runner.canRemove(cmd.id);
  };
  base.after = (cmd) => {
    if (cmd.type === "layout.building.remove") runner.removed(cmd.id);
    else if (cmd.type === "layout.reset") runner.reset();
    else runner.syncWithLayout();
  };
}
// The Arena (docs/arena.md): the referee, its API for the Hermes plugin's colony tools, and
// the Governor loop that lets the team's model play each game hour.
let arena: Arena | null = null;
if (colony && env.ARENA !== "0") {
  arena = new Arena(colony, world);
  const arenaToken = env.ARENA_TOKEN ?? "";
  const arenaPort = Number(env.ARENA_PORT ?? 8772);
  if (arenaToken) await startArenaServer(arena, arenaPort, arenaToken, env.ARENA_BIND ?? "0.0.0.0");
  else console.log("[adapter] arena API off: no ARENA_TOKEN in .env (scripts/gen-env.sh adds one)");
  if (sourceName === "hermes" && env.ARENA_GOVERNOR !== "0") {
    const gov = new HermesGovernor({ baseUrl: env.HERMES_URL ?? "http://127.0.0.1:8101", token: env.HERMES_TOKEN ?? "dev_master_token" });
    let busy = false;
    let first = true;
    // Teams on one shared local model take turns (docs/arena.md §8c): ARENA_LLM_LOCK names a lock
    // directory that one adapter holds while its Governor thinks, and a team rests an hour after
    // its turn so the other team gets the next one. Without it both queue on one Ollama slot and
    // every call runs past Hermes's 45 s limit.
    const lockDir = env.ARENA_LLM_LOCK;
    let resting = false;
    const takeTurn = (): boolean => {
      if (!lockDir) return true;
      try {
        mkdirSync(lockDir);
        return true;
      } catch {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > 120_000) rmSync(lockDir, { recursive: true, force: true }); // a crashed holder
        } catch {}
        return false;
      }
    };
    const endTurn = () => {
      if (!lockDir) return;
      rmSync(lockDir, { recursive: true, force: true });
      resting = true;
    };
    arena.on("match", () => {
      gov.newChat();
      first = true;
    });
    arena.on("hour", () => {
      const a = arena!;
      if (busy || a.match?.status !== "running" || a.match.frozen) return;
      if (resting) {
        resting = false;
        return;
      }
      if (!takeTurn()) return;
      busy = true;
      a.roundStarted();
      // Every turn is a fresh chat with the full rules and the current observation (lastActions
      // carries what happened). In one long chat a small model starts copying its earlier
      // replies ("I built a Scrap Yard") instead of calling the tools, and every turn gets
      // slower as the history grows. ARENA_GOVERNOR_MEMORY=1 keeps one chat per match.
      if (env.ARENA_GOVERNOR_MEMORY !== "1") {
        gov.newChat();
        a.chatReset();
      }
      const prompt = roundPrompt(a.observation(), first || env.ARENA_GOVERNOR_MEMORY !== "1");
      first = false;
      gov
        .ask(prompt)
        .then((r) => a.roundEnded(r))
        .catch((e) => world.logLine(`Governor round failed: ${e}`, "warn"))
        .finally(() => {
          busy = false;
          endTurn();
        });
    });
  }
  sink?.attachArena(arena);
}

await startServer(world, source, port, "127.0.0.1", base, colony, arena);
console.log(`[adapter] source=${sourceName} ws://127.0.0.1:${port}/world mission-control=${sink ? env.MC_URL : "off"} arena=${arena && env.ARENA_TOKEN ? `0.0.0.0:${env.ARENA_PORT ?? 8772}` : "off"}`);

if (env.ADAPTER_VERBOSE === "1") world.on("message", (m) => console.log(JSON.stringify(m)));

const shutdown = async () => {
  colony?.stop();
  sink?.stop();
  await source.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
