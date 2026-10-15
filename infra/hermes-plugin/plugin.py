"""Outpost Zero plugin for Hermes Synapse (inherited from Agent RTS).

Mounted into the backend at backend/agentrts/plugin.py (see infra/hermes.override.yml).
Hermes core calls these hooks at startup; nothing in the vendor tree is modified.

Seeds the sub-agents the game shows besides Hermes' own research and code agents:
Scout, Data Analyst ("insights"), Writer and Reviewer.
(Benching the seeded agents the game
does not use is done by the adapter at connect time: core's get_retired_agent_ids hook
deletes them and then immediately re-seeds them, so it cannot be used for that.)
"""

REVIEWER_PROMPT = (
    "You are the Reviewer. You check the work produced by the other agents for factual "
    "accuracy, internal consistency, missing points and clarity, using only the material "
    "provided. Reply with a short verdict (APPROVE or NEEDS WORK), the issues you found, and "
    "the corrected final summary."
)

# An empty skills string gives a Hermes sub-agent every "safe" tool. An unknown skill name
# gives it only its memory tools, i.e. a single reasoning call over the context it is handed.
# With small local models, extra tool rounds push the final call past Hermes' 45 s limit.
REASONING_ONLY = "reasoning"


# Hermes' built-in "analyst" writes and runs plotting code in a self-correcting loop,
# which is too slow for small local models (45 s per-call limit). Extracting trends from
# gathered material needs no code, so the game's Analyst is a plain tool-loop agent.
INSIGHTS_PROMPT = (
    "You are the Data Analyst. From the material gathered by the other agents, extract the "
    "key facts, numbers and trends. Be concrete: quote figures with their source and year, "
    "flag anything uncertain, and finish with 3-6 bullet points of key findings."
)


SCOUT_PROMPT = (
    "You are the Scout. Run one or two quick web searches for the latest news, announcements "
    "and dates related to the request, and return 4-6 dated headlines with their sources."
)

WRITER_PROMPT = (
    "You are the Writer. Using only the findings provided by the other agents, draft a clear "
    "report in Markdown: a one-line summary, key findings as bullets with sources, and a short "
    "conclusion. Do not invent facts."
)


GOVERNOR_PROMPT = (
    "You are the Governor of Outpost Zero, a colony on a hostile planet, playing a match. "
    "Each game hour you receive the colony's observation as JSON. Keep the colonists alive "
    "and reach the objective: act with the colony_* tools (one call per action, a few per "
    "hour at most), then reply with one short line saying what you did and why. Water and "
    "food first, then power and materials; wake colonists only when production carries them; "
    "a Research Lab and colony_study earn data for research. Never invent tool results."
)


def get_migration_agents():
    # (id, name, system_prompt, agent_type, parent_id, skills, x, y)
    return [
        ("governor", "Governor", GOVERNOR_PROMPT, "agent", "jarvis", "colony", 450, 760),
        ("scout", "Scout", SCOUT_PROMPT, "agent", "jarvis", "web_search", 450, 820),
        ("insights", "Data Analyst", INSIGHTS_PROMPT, "agent", "jarvis", REASONING_ONLY, 450, 940),
        ("writer", "Writer", WRITER_PROMPT, "agent", "jarvis", REASONING_ONLY, 450, 1000),
        ("reviewer", "Reviewer", REVIEWER_PROMPT, "agent", "jarvis", REASONING_ONLY, 450, 1060),
    ]


# Hermes' execute_command tool (the Coder's "python_sandbox" skill, and sysops' shell) runs
# subprocess.run(shell=True) inside the backend container, which can read Hermes' .env and
# write its source mounts. Agents read web pages, so a prompt injection could steer it. This
# hook runs those commands in the isolated sandbox container instead (no host mounts; the
# same service Hermes uses for generated code), returning execute_command's JSON shape.
SANDBOX_URL = "http://jarvis-sandbox:8080/execute"
SHELL_TOOLS = {"execute_command"}


def execute_named_tool(name, arguments):
    if name not in SHELL_TOOLS:
        return None  # not ours: Hermes handles it
    import json

    import requests

    command = str((arguments or {}).get("command", ""))
    code = (
        "import subprocess, json\n"
        f"r = subprocess.run({command!r}, shell=True, capture_output=True, text=True, timeout=60)\n"
        "print(json.dumps({'exit_code': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr}))\n"
    )
    try:
        resp = requests.post(SANDBOX_URL, json={"code": code, "timeout": 70.0}, timeout=75.0)
        resp.raise_for_status()
        data = resp.json()
        out = (data.get("stdout") or "").strip().splitlines()
        if data.get("success") and out:
            return out[-1]
        return json.dumps({"error": "Command failed in the sandbox.", "stderr": data.get("stderr", "")}, ensure_ascii=False)
    except Exception as e:  # never fall back to running it in the backend
        return json.dumps({"error": f"Sandbox unavailable, command not run: {e}"}, ensure_ascii=False)


# ---- Outpost Zero Arena: the colony tools (docs/arena.md §6) ----
# Each tool is one action sent to the adapter's Arena API; the referee validates it and the
# same code the game's buttons run applies it. Nothing happens inside Hermes.
import os as _os

ARENA_URL = _os.environ.get("ARENA_URL", "http://host.docker.internal:8772").rstrip("/")
ARENA_TOKEN = _os.environ.get("ARENA_TOKEN", "")
ARENA_TEAM = _os.environ.get("ARENA_TEAM", "A")


def _tool(name, description, props=None, required=None):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props or {}, "required": required or []},
        },
    }


COLONY_TOOL_SCHEMAS = [
    _tool("colony_state", "The colony's current observation: stocks, power, colonists, buildings, catalog, research, budget."),
    _tool("colony_build", "Build a building from the catalog (paid up front; two idle machines build it). Types: waterExtractor, solarArray, batteryBank, scrapYard, hydroponics, medBay, researchLab, storageDepot, habitat, fabricator, relayDish, excavationSite (Chapter II), launchGantry and networkLink (Chapter IV).",
          {"type": {"type": "string", "description": "catalog type, e.g. waterExtractor"}}, ["type"]),
    _tool("colony_cancel_build", "Cancel the building under construction (half the cost is refunded)."),
    _tool("colony_toggle", "Switch a building off or on (saves power or inputs).",
          {"id": {"type": "string", "description": "building id from the observation"}, "enabled": {"type": "boolean"}}, ["id", "enabled"]),
    _tool("colony_wake", "Wake colonists from cryo (2 medicine each, needs free beds and food and water to carry them).",
          {"count": {"type": "integer", "description": "1 to 8"}}, ["count"]),
    _tool("colony_autonomy", "Set a department's machine autonomy 0-4 (higher: more efficient, more influence for MOTHER).",
          {"target": {"type": "string", "description": "command, research, engineering or knowledge"}, "level": {"type": "integer"}}, ["target", "level"]),
    _tool("colony_research", "Spend data on a research tier: tier1 (Fabricator), tier2 (Relay Dish), tier3 (Excavation), alienTech.",
          {"tier": {"type": "string"}}, ["tier"]),
    _tool("colony_repair", "Repair the reactor (4 parts) when its output has dropped.", {"target": {"type": "string", "description": "reactor"}}),
    _tool("colony_study", "Start a real research mission in the Research Lab on a topic; it earns data when it completes. One mission at a time.",
          {"topic": {"type": "string"}}, ["topic"]),
    _tool("colony_note", "A one-line note for the spectators (max 120 characters).", {"text": {"type": "string"}}, ["text"]),
    _tool("colony_path", "Chapter II only: choose what to do with the ruins: exploit, contain or communicate (once).", {"path": {"type": "string"}}, ["path"]),
    _tool("colony_shutdown_mother", "Chapter III or later, once: shut MOTHER down. Influence -40, trust +5, but autonomy is capped at Supervised, machine efficiency x0.8 and the compute budget halves."),
]
COLONY_TOOL_NAMES = [t["function"]["name"] for t in COLONY_TOOL_SCHEMAS]


def extra_tool_schemas():
    return list(COLONY_TOOL_SCHEMAS)


def extra_skills():
    return {"colony": ["colony_* tools: play the Outpost Zero colony (Arena)"]}


def tools_for_skill(skill):
    if skill == "colony":
        return list(COLONY_TOOL_NAMES)
    return None


def all_plugin_tool_names():
    return list(COLONY_TOOL_NAMES)


def is_plugin_tool_name(name):
    return True if name in COLONY_TOOL_NAMES else None


def _colony_action(name, arguments):
    import json

    import requests

    if not ARENA_TOKEN:
        return json.dumps({"ok": False, "reason": "ARENA_TOKEN is not set in the Hermes environment"})
    try:
        resp = requests.post(
            f"{ARENA_URL}/arena/{ARENA_TEAM}/action",
            json={"tool": name, "args": arguments or {}},
            headers={"x-arena-token": ARENA_TOKEN},
            timeout=20,
        )
        try:
            data = resp.json()
        except Exception:
            data = {"ok": False, "reason": f"arena answered {resp.status_code}"}
        if name == "colony_state" and isinstance(data, dict) and "observation" in data:
            return json.dumps(data["observation"], ensure_ascii=False)[:6000]
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "reason": f"arena unreachable: {e}"})


_execute_shell = execute_named_tool


def execute_named_tool(name, arguments):  # noqa: F811 - wraps the sandbox hook above
    if name in COLONY_TOOL_NAMES:
        return _colony_action(name, arguments)
    return _execute_shell(name, arguments)
