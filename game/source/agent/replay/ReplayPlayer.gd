extends Node

# Plays back a recorded mission (adapter `replay` message) with ghost agents, compressed to
# a short highlight reel. The clock runs in mission milliseconds; `speed` maps real time to
# mission time and the viewer can pause or change speed.

signal caption(line)  # recorded log line
signal progressed(clock_ms, duration_ms)
signal finished

const GhostAgent = preload("res://source/agent/replay/GhostAgent.gd")
const MIN_LENGTH_S = 12.0
const MAX_LENGTH_S = 20.0

var mission = {}
var duration_ms = 1.0
var base_speed = 1.0
var speed_mult = 1.0
var playing = false
var clock_ms = 0.0
var ghosts = {}  # agent_id -> GhostAgent
var markers = []  # [{t: ms, agent_id, title}] step starts, for the timeline
var approval_pending = false

var _events = []
var _index = 0
var _start_ts = 0.0
var _resolve_target: Callable


# replay: {mission, agents, events}; roster: [{id, name, color}]
func start(replay: Dictionary, roster: Array, parent: Node3D, resolve_target: Callable, ui_scale: float):
	mission = replay.get("mission", {})
	_events = replay.get("events", [])
	_resolve_target = resolve_target
	_start_ts = float(mission.get("startedAt", _events[0].get("ts", 0) if not _events.is_empty() else 0))
	var end_ts = _start_ts
	for e in _events:
		end_ts = max(end_ts, float(e.get("ts", 0)))
	duration_ms = max(1000.0, end_ts - _start_ts)
	var length_s = clampf(duration_ms / 1000.0 * 0.15, MIN_LENGTH_S, MAX_LENGTH_S)
	length_s = min(length_s, duration_ms / 1000.0)  # never slower than real time
	base_speed = (duration_ms / 1000.0) / length_s
	speed_mult = 1.0
	clock_ms = 0.0
	_index = 0
	approval_pending = false
	markers.clear()
	for e in _events:
		if e.get("type") == "task.upsert" and e["task"].get("status") == "running":
			var known = markers.filter(func(m): return m["task_id"] == e["task"]["id"])
			if known.is_empty():
				markers.append({"t": float(e["ts"]) - _start_ts, "task_id": e["task"]["id"], "agent_id": e["task"].get("agentId"), "title": e["task"].get("title", "")})
		elif e.get("type") == "approval.upsert" and e["approval"].get("status") == "pending":
			markers.append({"t": float(e["ts"]) - _start_ts, "task_id": "approval", "agent_id": "approval", "title": "Human approval"})
	var start_states = {}
	for a in replay.get("agents", []):
		start_states[a["id"]] = a
	for r in roster:
		var g = GhostAgent.new()
		g.agent_id = r["id"]
		g.display_name = r["name"]
		g.role_color = r["color"]
		g.model_path = r.get("model", g.model_path)
		g.model_size = r.get("size", g.model_size)
		g.model_height = r.get("height", 0.0)
		parent.add_child(g)
		g.setup(ui_scale)
		var a = start_states.get(r["id"], {"id": r["id"], "state": "idle", "location": "command_centre"})
		g.snap(a, resolve_target.call(a.get("location", "command_centre"), r["id"]))
		ghosts[r["id"]] = g
	playing = true


func stop():
	playing = false
	for g in ghosts.values():
		g.queue_free()
	ghosts.clear()


func toggle_pause():
	playing = not playing


func cycle_speed():
	speed_mult = {1.0: 2.0, 2.0: 4.0, 4.0: 0.5, 0.5: 1.0}.get(speed_mult, 1.0)


func effective_speed():
	return base_speed * speed_mult


func _process(delta):
	if not playing or ghosts.is_empty():
		return
	clock_ms += delta * 1000.0 * effective_speed()
	while _index < _events.size() and float(_events[_index].get("ts", 0)) - _start_ts <= clock_ms:
		_apply(_events[_index])
		_index += 1
	progressed.emit(min(clock_ms, duration_ms), duration_ms)
	if clock_ms >= duration_ms + 1500.0 * effective_speed():
		playing = false
		finished.emit()


func _apply(e: Dictionary):
	match e.get("type", ""):
		"agent.state":
			var a = e["agent"]
			var g = ghosts.get(a.get("id", ""))
			if g != null:
				g.apply(a, _resolve_target.call(a.get("location", "command_centre"), a["id"]))
		"log":
			caption.emit(e["line"])
		"approval.upsert":
			approval_pending = e["approval"].get("status") == "pending"
