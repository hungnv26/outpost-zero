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


def get_migration_agents():
    # (id, name, system_prompt, agent_type, parent_id, skills, x, y)
    return [
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
