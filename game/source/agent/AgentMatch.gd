extends "res://source/match/Match.gd"

# The agent world: a single-player Open RTS match with no combat, AI or economy.
# Buildings are capabilities, units are AI agents, and all agent movement comes from the
# adapter's world feed (WorldClient). The base itself (buildings, spots, characters) is the
# player's layout, owned by the adapter and edited in Build mode; this scene reconciles the
# map with it whenever it changes.

const ShroudScript = preload("res://source/agent/Shroud.gd")
const WORLD_MARGIN = 28.0  # how far past the base the camera may travel (into the unexplored land)
const BaseDressingScript = preload("res://source/agent/BaseDressing.gd")
const Models = preload("res://source/agent/Models.gd")
const CHARACTER_HEIGHT = 1.7  # animated characters are fitted by height
const SceneryScript = preload("res://source/agent/Scenery.gd")
const HudUi = preload("res://source/agent/hud/Ui.gd")
const Departments = preload("res://source/agent/Departments.gd")
const AgentScene = preload("res://source/agent/units/Agent.tscn")
const BuildingScene = preload("res://source/agent/units/Building.tscn")
const WorldClientScript = preload("res://source/agent/WorldClient.gd")
const AgentHUDScript = preload("res://source/agent/hud/AgentHUD.gd")
const WorldDecorScript = preload("res://source/agent/WorldDecor.gd")
const ReplayPlayerScript = preload("res://source/agent/replay/ReplayPlayer.gd")
const Fx = preload("res://source/agent/Fx.gd")
const SettingsScript = preload("res://source/agent/Settings.gd")
const Terrains = preload("res://source/agent/Terrains.gd")

const SPOT_COLORS = {"rally_point": Color(1.0, 0.82, 0.35), "repair_bay": Color(1.0, 0.35, 0.35)}
# Only the Command Centre exists before the adapter sends the layout (the match needs one
# unit to start); everything else comes from the layout.
const BOOT_COMMAND_CENTRE = {
	"id": "command_centre", "label": "Command Centre", "x": 18.5, "z": 22.0,
	"model": "CommandCenter", "color": "#66ccff", "capability": "command",
}
const RTS_ONLY_NODES = [
	"Players/Human/StructurePlacementHandler",
	"Players/Human/UnitActionsController",
	"Players/Human/VoiceNarratorController",
	"Players/Human/UnitVoicesController",
	"HUD/MarginContainer2",
	"HUD/MarginContainer3",
	"Handlers/MatchEndHandler",
]

var _layout = {"buildings": [BOOT_COMMAND_CENTRE], "spots": [], "agents": []}
var _agents = {}  # id -> Agent node
var _buildings = {}  # id -> Building node
var _client = null
var _hud = null
var _first_snapshot = true
var _decor = null
var _scenery = null
var _dressing = null
var _shroud = null
var _reveal_tick = 0.0
var _pending_approvals = {}
var _mission_id = ""
var ui_scale = 1.0  # menus / HUD
var label_scale = 1.0  # names and status above characters and buildings
var mission_running = false
var display_settings = SettingsScript.new()
var _zoom_saved_at = 0.0
var _mission_status = ""
var _replay = null
var _replaying = false
var _replay_wait_id = ""
var _placement = null  # {kind, payload, label, preview} while placing in Build mode
var _terrain_id = ""
var _env_duplicated = false  # the scene's Environment is copied once, then tuned per terrain


func _ready():
	display_settings.load_settings()
	if display_settings.has_saved_window:
		display_settings.apply_window()
	ui_scale = _compute_ui_scale()
	label_scale = _compute_label_scale()
	for path in RTS_ONLY_NODES:
		var node = get_node_or_null(path)
		if node != null:
			node.queue_free()
	var cc = _make_building(BOOT_COMMAND_CENTRE)
	$Players/Human.add_child(cc)
	_buildings["command_centre"] = cc
	super()
	_scenery = SceneryScript.new()
	add_child(_scenery)
	_dressing = BaseDressingScript.new()
	add_child(_dressing)
	_decor = WorldDecorScript.new()
	_decor.ui_scale = label_scale
	add_child(_decor)
	_apply_terrain("mars")
	_replay = ReplayPlayerScript.new()
	add_child(_replay)
	_hud = AgentHUDScript.new()
	_hud.model_path_for = func(model_name): return _model_path(model_name)
	$HUD.add_child(_hud)
	_client = WorldClientScript.new()
	add_child(_client)
	_client.connection_changed.connect(func(online): _hud.set_connection(online))
	_client.message_received.connect(_on_message)
	_hud.mission_requested.connect(func(title): _client.send_command({"type": "mission.create", "title": title}))
	_hud.mission_cancel_requested.connect(func(): _client.send_command({"type": "mission.cancel"}))
	_hud.approval_resolved.connect(
		func(id, approved): _client.send_command({"type": "approval.resolve", "id": id, "approved": approved})
	)
	_hud.agent_focus_requested.connect(_focus_agent)
	_hud.department_focus_requested.connect(func(dept): _camera.set_position_safely(Departments.centre(dept)))
	_hud.building_focus_requested.connect(_focus_building)
	_hud.view_fit_requested.connect(_fit_view)
	_hud.replay_requested.connect(_request_replay)
	_hud.replay_pause_toggled.connect(func(): _replay.toggle_pause())
	_hud.replay_speed_cycled.connect(func(): _replay.cycle_speed())
	_hud.replay_stop_requested.connect(_end_replay)
	_hud.build_command.connect(func(cmd): _client.send_command(cmd))
	_hud.placement_requested.connect(_begin_placement)
	_replay.caption.connect(func(line): _hud.replay_caption(line))
	_replay.progressed.connect(
		func(clock, total): _hud.update_replay(clock, total, _replay.effective_speed(), _replay.playing)
	)
	_replay.finished.connect(_end_replay)
	_hud.set_connection(false)
	_hud.settings_ref = display_settings
	_hud.camera_ref = _camera
	_hud.setting_changed.connect(_on_setting_changed)
	display_settings.apply_render(get_viewport())
	_camera.set_size_safely(display_settings.clamp_zoom(display_settings.zoom))
	_shroud = ShroudScript.new()
	_camera.add_child(_shroud)
	_shroud.set_area(Vector2(Departments.MAP_SIZE, Departments.MAP_SIZE) * 0.5, Vector2(Departments.MAP_SIZE, Departments.MAP_SIZE) * 0.5 + Vector2(1.5, 1.5))
	MatchSignals.unit_selected.connect(_on_unit_selected)
	get_viewport().size_changed.connect(_apply_ui_scale)
	_apply_ui_scale.call_deferred()
	_setup_capture()


func _process(delta):
	# During a replay the ghosts drive the world's reactions instead of the real agents.
	var actors = _replay.ghosts.values() if _replaying else _agents.values()
	# Each building's status line names the agents working inside.
	for b in _buildings.values():
		if not is_instance_valid(b):
			continue
		for agent in actors:
			b.set_occupant(
				agent.agent_id,
				agent.state == "working" and agent.location == b.building_id and not agent.is_moving(),
				agent.display_name
			)
	if _buildings.has("human_approval") and is_instance_valid(_buildings["human_approval"]):
		_buildings["human_approval"].alert = (
			_replay.approval_pending if _replaying else not _pending_approvals.is_empty()
		)
	_reveal_explorers(delta)
	_update_placement_preview()
	# Remember mouse-wheel zoom too (saved at most once a second).
	if absf(_camera.size - display_settings.zoom) > 0.01:
		display_settings.zoom = _camera.size
		var now = Time.get_ticks_msec() / 1000.0
		if now - _zoom_saved_at > 1.0:
			_zoom_saved_at = now
			display_settings.save_settings()


# ---------------------------------------------------------------- layout


func _center() -> Vector3:
	var cc = _bdef("command_centre")
	return Vector3(cc["x"], 0, cc["z"]) if cc != null else Vector3(22, 0, 22)


func _bdef(id) -> Variant:
	for b in _layout.get("buildings", []):
		if b["id"] == id:
			return b
	return null


func _spot_pos(id) -> Variant:
	for s in _layout.get("spots", []):
		if s["id"] == id:
			return Vector3(s["x"], 0, s["z"])
	return null


static func _model_path(model_name: String) -> String:
	return Models.path(model_name)


static func _vehicle_size(model_name: String) -> float:
	if Models.is_character(model_name):
		return 0.9
	if model_name.begins_with("craft_cargo") or model_name == "MonorailTrain":
		return 2.2
	if model_name == "Tank":
		return 1.9
	if model_name.begins_with("astronaut") or model_name == "alien":
		return 1.0
	if model_name == "craft_miner" or model_name == "craft_racer":
		return 1.7
	return 1.6


# The roster in layout order, in the shape agents/ghosts/replay use.
func _roster() -> Array:
	var out = []
	for a in _layout.get("agents", []):
		out.append({
			"id": a["id"], "name": a["name"], "color": Color.html(a["color"]),
			"model": _model_path(a["model"]), "size": _vehicle_size(a["model"]),
			"height": CHARACTER_HEIGHT if Models.is_character(a["model"]) else 0.0,
		})
	return out


func _make_building(def: Dictionary):
	var b = BuildingScene.instantiate()
	b.building_id = def["id"]
	b.label = def["label"]
	b.model_path = _model_path(def["model"])
	b.model_size = 4.2 if def["id"] == "command_centre" else 3.6
	b.accent = Color.html(def["color"])
	b.icon_kind = _hud._dept_icon(Departments.of(def["capability"])) if _hud != null else ""
	b.snapshots = _hud.snapshots if _hud != null else null
	b.position = Vector3(def["x"], 0, def["z"])
	b.set_meta("sig", _sig(def, ["label", "model", "color", "x", "z"]))
	return b


func _make_agent(def: Dictionary):
	var agent = AgentScene.instantiate()
	agent.agent_id = def["id"]
	agent.display_name = def["name"]
	agent.role_color = Color.html(def["color"])
	agent.model_path = _model_path(def["model"])
	agent.model_size = _vehicle_size(def["model"])
	agent.model_height = CHARACTER_HEIGHT if Models.is_character(def["model"]) else 0.0
	agent.resolve_target = _route_for
	agent.state_applied.connect(_on_agent_state_applied)
	agent.set_meta("sig", _sig(def, ["name", "model", "color"]))
	return agent


static func _sig(def: Dictionary, keys: Array) -> String:
	var parts = []
	for k in keys:
		parts.append(str(def.get(k, "")))
	return "|".join(parts)


# Bring the map in line with the layout: spawn, rebuild or remove buildings and agents.
func _apply_layout(layout: Dictionary):
	_layout = layout
	_apply_terrain(layout.get("terrain", "mars"))
	var human = $Players/Human
	var wanted = {}
	for def in layout.get("buildings", []):
		wanted[def["id"]] = true
		var node = _buildings.get(def["id"])
		var sig = _sig(def, ["label", "model", "color", "x", "z"])
		if node != null and is_instance_valid(node) and node.get_meta("sig", "") == sig:
			continue
		if node != null and is_instance_valid(node):
			node.queue_free()
		var b = _make_building(def)
		_setup_and_spawn_unit(b, Transform3D(Basis(), b.position), human, false)
		_buildings[def["id"]] = b
	for id in _buildings.keys():
		if not wanted.has(id):
			if is_instance_valid(_buildings[id]):
				_buildings[id].queue_free()
			_buildings.erase(id)
	var agents_wanted = {}
	for def in layout.get("agents", []):
		agents_wanted[def["id"]] = true
		var node = _agents.get(def["id"])
		var sig = _sig(def, ["name", "model", "color"])
		if node != null and is_instance_valid(node) and node.get_meta("sig", "") == sig:
			continue
		var data = {}
		var pos = null
		if node != null and is_instance_valid(node):
			data = node.data
			pos = node.global_position
			node.queue_free()
		var agent = _make_agent(def)
		var at = pos if pos != null else _target_for(def.get("home", "command_centre"), def["id"])
		_setup_and_spawn_unit(agent, Transform3D(Basis(), at), human, false)
		_agents[def["id"]] = agent
		if _replaying:
			agent.set_hidden(true)
		if not data.is_empty():
			agent.location = ""  # so the carried-over state always walks it to its place
			agent.push_state(data)
	for id in _agents.keys():
		if not agents_wanted.has(id):
			_remove_agent(id)
	_rebuild_decor()
	_hud.set_layout(layout)
	_repark_agents()


# After a layout edit (a building moved, a home changed, characters added or removed),
# characters standing still walk to wherever their place is now.
func _repark_agents():
	for agent in _agents.values():
		if not is_instance_valid(agent) or not agent.is_inside_tree() or agent.is_moving():
			continue
		if agent.has_method("repark"):
			agent.repark()


# Ground pattern, road colour and light for a terrain theme (Terrains.gd).
func _apply_terrain(id: String):
	if id == _terrain_id:
		return
	_terrain_id = id
	_scenery.build(id)
	var t = Terrains.get_preset(id)
	var mat = map.find_child("Terrain").mesh.material
	if mat is ShaderMaterial:
		Terrains.apply_to_material(mat, id)
	var env_node = $WorldEnvironment
	var sun = $DirectionalLight3D
	if not _env_duplicated:
		_env_duplicated = true
		env_node.environment = env_node.environment.duplicate()
	var env = env_node.environment
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = t["ambient"]
	env.ambient_light_energy = t["ambient_energy"]
	# Contact shadows (SSAO), a soft sun, a touch more colour; glow only on genuinely bright bits.
	env.fog_enabled = false  # Open RTS's haze greys out the far camera
	env.volumetric_fog_enabled = false
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.tonemap_exposure = 1.0
	env.adjustment_enabled = true
	env.adjustment_saturation = 1.12
	env.adjustment_contrast = 1.05
	env.ssao_enabled = true
	env.ssao_radius = 1.4
	env.ssao_intensity = 1.8
	env.glow_enabled = true
	env.glow_intensity = 0.3
	env.glow_hdr_threshold = 1.3
	sun.light_color = t["sun"]
	sun.light_energy = t["sun_energy"] * 1.1
	sun.light_angular_distance = 1.5
	sun.shadow_blur = 1.2
	_decor.set_road_color(t["road"])
	if _hud != null:
		_hud.set_terrain(id)


func _remove_agent(id):
	for b in _buildings.values():
		if is_instance_valid(b):
			b.set_occupant(id, false)
	if _agents.has(id):
		if is_instance_valid(_agents[id]):
			_agents[id].queue_free()
		_agents.erase(id)
	_hud.remove_agent(id)


# Ground direction pointing at the camera (the "front" of things, screen-down).
func view_back() -> Vector3:
	var z = _camera.global_basis.z if _camera != null else Vector3(0, 0, 1)
	var flat = Vector3(z.x, 0, z.z)
	return flat.normalized() if flat.length() > 0.01 else Vector3(0, 0, 1)


func _rebuild_decor():
	_decor.clear()
	_decor.view_up = -view_back()
	_dressing.view_back = view_back()
	_dressing.build(_layout)
	_decor.center = _center()
	_decor.ui_scale = label_scale
	_decor.buildings = {}
	_decor.spots = {}
	for b in _layout.get("buildings", []):
		_decor.buildings[b["id"]] = {"pos": Vector3(b["x"], 0, b["z"]), "accent": Color.html(b["color"]), "size": 3.6}
	for s in _layout.get("spots", []):
		_decor.spots[s["id"]] = {"pos": Vector3(s["x"], 0, s["z"]), "color": SPOT_COLORS.get(s["id"], Color.WHITE), "label": s["label"]}
	if _decor.spots.has("rally_point") and _decor.spots.has("repair_bay") and _decor.buildings.has("command_centre"):
		_decor.build()


# Where an agent stands at a location. Each agent has a fixed slot so they never stack.
func _target_for(location, agent_id):
	var roster = _layout.get("agents", [])
	var n = max(1, roster.size())
	var idx = 0
	for i in roster.size():
		if roster[i]["id"] == agent_id:
			idx = i
	var center = _center()
	var spot = _spot_pos(location)
	if spot != null:
		var a = TAU * idx / n
		return spot + Vector3(cos(a), 0, sin(a)) * (1.2 + 0.06 * n)
	var b = _bdef(location)
	if b == null:
		return center
	# At its home a character takes a slot among the characters sharing that home, so a
	# crowded home stays compact; elsewhere slots follow roster order.
	var mine = roster[idx] if idx < roster.size() else {}
	var residents = roster.filter(func(d): return d.get("home", "command_centre") == location)
	if mine.get("home", "command_centre") == location:
		n = residents.size()
		idx = max(0, residents.find(mine))
	else:
		# Visitors queue after the residents, so nobody stands on a resident's spot.
		var visitors = roster.filter(func(d): return d.get("home", "command_centre") != location)
		idx = residents.size() + max(0, visitors.find(mine))
		n = roster.size()
	var pos = Vector3(b["x"], 0, b["z"])
	# Characters stand right in front of the building (the side facing the camera), so
	# they're visible and stay inside their own district.
	var base_r = 3.4 if location == "command_centre" else 2.6
	return _arc_slot(pos, view_back(), idx, n, base_r)


# Slot `i` on rows of arcs in front of a building, filling the `facing` side first;
# each further row is one unit out. Slots inside other buildings or off the map are skipped.
func _arc_slot(pos: Vector3, facing: Vector3, i: int, n: int, base_r: float) -> Vector3:
	const GAP = 1.05
	const HALF_ARC = PI * 0.6  # rows cover the front of the building, not its back
	var size = float(_layout.get("size", 32))
	var others = []
	for b in _layout.get("buildings", []):
		var bp = Vector3(b["x"], 0, b["z"])
		if bp.distance_to(pos) > 0.1:
			others.append(bp)
	var r = base_r
	var free = 0
	for ring in 16:
		var cap = int(2.0 * HALF_ARC * r / GAP) + 1
		# Grow the arc symmetrically from the front: 0, +1, -1, +2, -2 ...
		for k in cap:
			var j = (k + 1) / 2 * (1 if k % 2 == 1 else -1)
			var a = atan2(facing.z, facing.x) + j * (GAP / r)
			var p = pos + Vector3(cos(a), 0, sin(a)) * r
			if p.x < 1.0 or p.z < 1.0 or p.x > size - 1.0 or p.z > size - 1.0:
				continue
			if others.any(func(o): return o.distance_to(p) < 2.6):
				continue
			if free == i:
				return p
			free += 1
		r += 1.0
	return pos


# ---------------------------------------------------------------- Build mode placement


func _begin_placement(kind: String, payload: Dictionary, label_text: String):
	_cancel_placement()
	var preview = Node3D.new()
	var mat = StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 1.0, 1.0, 0.5)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	var radius = 2.0 if kind == "spot" else 2.6
	preview.add_child(Fx.torus(radius - 0.12, radius, mat, 0.02))
	var l = Fx.label(preview, label_text, 24, Color.WHITE, label_scale)
	l.position = Vector3(0, 1.0, 0)
	add_child(preview)
	_placement = {"kind": kind, "payload": payload, "preview": preview}
	_hud.show_hint("Click on the map to place %s · right-click or Esc to cancel" % label_text)


func _cancel_placement():
	if _placement != null:
		_placement["preview"].queue_free()
		_placement = null
		_hud.show_hint("")
		_hud.form_failed()  # nothing was sent: keep the form and what was typed


func _ground_point():
	var hit = _camera.get_ray_intersection(get_viewport().get_mouse_position())
	if hit == null:
		return null
	return Vector3(round(hit.x * 2.0) / 2.0, 0, round(hit.z * 2.0) / 2.0)


func _update_placement_preview():
	if _placement == null:
		return
	var p = _ground_point()
	if p != null:
		_placement["preview"].global_position = p + Vector3(0, 0.05, 0)


func _unhandled_input(event):
	if _placement != null:
		if event is InputEventMouseButton and event.pressed:
			if event.button_index == MOUSE_BUTTON_LEFT:
				_finish_placement()
			elif event.button_index == MOUSE_BUTTON_RIGHT:
				_cancel_placement()
			get_viewport().set_input_as_handled()
			return
		if event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
			_cancel_placement()
			get_viewport().set_input_as_handled()
			return
	super(event)


func _finish_placement():
	var p = _ground_point()
	if p == null:
		return
	var kind = _placement["kind"]
	var payload = _placement["payload"].duplicate()
	if kind == "spot":
		_client.send_command({"type": "layout.spot.move", "id": payload["id"], "x": p.x, "z": p.z})
	else:
		payload["x"] = p.x
		payload["z"] = p.z
		_client.send_command({"type": "layout.building.upsert", "building": payload})
	_cancel_placement()


# ---------------------------------------------------------------- scaling & settings


# HUD and labels are designed for a 1080p-tall window; scale them up on 4K/5K screens.
func _window_factor():
	return clampf(get_viewport().get_visible_rect().size.y / 1080.0, 1.0, 3.0)


func _compute_ui_scale():
	return max(0.45, _window_factor() * SettingsScript.TEXT_BASE * display_settings.text_size)


func _compute_label_scale():
	return max(0.25, _window_factor() * SettingsScript.TEXT_BASE * display_settings.label_size)


func _on_setting_changed(key, value):
	match key:
		"fullscreen":
			display_settings.fullscreen = value
			display_settings.apply_window()
		"window_size":
			display_settings.window_size = value
			display_settings.fullscreen = false
			display_settings.apply_window()
		"render_scale":
			display_settings.render_scale = value
			display_settings.apply_render(get_viewport())
		"msaa":
			display_settings.msaa = value
			display_settings.apply_render(get_viewport())
		"text_size":
			display_settings.text_size = value
			_apply_ui_scale()
		"label_size":
			display_settings.label_size = value
			_apply_ui_scale()
		"zoom":
			display_settings.zoom = display_settings.clamp_zoom(value)
			_camera.set_size_safely(display_settings.zoom)
	display_settings.save_settings()
	_hud.show_settings(display_settings, _camera.size)


func _apply_ui_scale():
	ui_scale = _compute_ui_scale()
	label_scale = _compute_label_scale()
	if _hud != null:
		_hud.set_ui_scale(ui_scale)
	var minimap = get_node_or_null("HUD/MarginContainer")
	if minimap != null:
		const MINIMAP_ZOOM = 1.25  # a little bigger than Open RTS's, matching the HUD panels
		minimap.pivot_offset = Vector2(0, minimap.size.y)
		minimap.scale = Vector2(ui_scale, ui_scale) * MINIMAP_ZOOM
		minimap.add_theme_constant_override("margin_left", 12)
		minimap.add_theme_constant_override("margin_bottom", 12)
		var frame = minimap.get_node_or_null("Minimap")
		if frame != null:
			frame.add_theme_stylebox_override("panel", HudUi.panel_style(HudUi.BG, 8, 5))
		if _hud != null:
			_hud.set_minimap_width(minimap.size.x * MINIMAP_ZOOM)
	for l in get_tree().get_nodes_in_group(Fx.LABEL_GROUP):
		l.pixel_size = l.get_meta("base_px", 0.0008) * label_scale


# ---------------------------------------------------------------- feed


func _on_message(msg):
	match msg.get("type", ""):
		"snapshot":
			var world = msg["world"]
			if world.has("layout"):
				_apply_layout(world["layout"])
			_hud.apply_snapshot(world)
			_hud.set_connection(true, world.get("source", ""))
			for a in world.get("agents", []):
				_apply_agent(a, _first_snapshot)
			_first_snapshot = false
			_pending_approvals.clear()
			for ap in world.get("approvals", []):
				if ap.get("status") == "pending":
					_pending_approvals[ap["id"]] = true
			var m = world.get("mission")
			mission_running = m != null and m.get("status") in ["planning", "running"]
			if m != null:
				_mission_id = m.get("id", "")
				_mission_status = m.get("status", "")  # a re-sent finished mission isn't "finished now"
		"layout.update":
			_apply_layout(msg["layout"])
		"agent.removed":
			_remove_agent(msg.get("agentId", ""))
		"error":
			_hud.show_error(str(msg.get("message", "")))
		"agent.state":
			_apply_agent(msg["agent"], false)
		"task.upsert":
			_hud.set_task(msg["task"])
		"mission.upsert":
			var m = msg["mission"]
			var status = m.get("status", "")
			var finished_now = status in ["completed", "failed"] and (
				status != _mission_status or m.get("id", "") != _mission_id
			)
			if finished_now:
				# Play a replay of the mission first; the report opens after it.
				_hud.defer_next_result()
				_replay_wait_id = m.get("id", "")
				get_tree().create_timer(2.5).timeout.connect(_request_replay.bind(_replay_wait_id))
			_hud.set_mission(m)
			_on_mission_status(m)
			_mission_status = status
		"replay":
			_on_replay(msg.get("replay"))
		"approval.upsert":
			_hud.set_approval(msg["approval"])
			var ap = msg["approval"]
			if ap.get("status") == "pending":
				_pending_approvals[ap["id"]] = true
			else:
				_pending_approvals.erase(ap["id"])
		"resource.update":
			_hud.set_resources(msg["resources"])
		"log":
			_hud.add_log(msg["line"])


func _on_mission_status(m):
	if m == null:
		return
	var status = m.get("status", "")
	var is_new = m.get("id", "") != _mission_id
	_mission_id = m.get("id", "")
	if is_new:
		_pending_approvals.clear()
		if _replaying and (status == "planning" or status == "running"):
			_end_replay()
	mission_running = status == "planning" or status == "running"


func _request_replay(mission_id):
	if mission_running or _replaying:
		_hud.cancel_deferred()
		return
	_replay_wait_id = mission_id
	_client.send_command({"type": "replay.request", "missionId": mission_id})
	# If the adapter has nothing (or is gone), don't keep the report waiting.
	get_tree().create_timer(3.0).timeout.connect(
		func():
			if _replay_wait_id == mission_id and not _replaying:
				_replay_wait_id = ""
				_hud.cancel_deferred()
	)


func _on_replay(replay):
	var wanted = _replay_wait_id
	_replay_wait_id = ""
	if replay == null or replay.get("events", []).is_empty() or mission_running or _replaying:
		_hud.cancel_deferred()
		return
	if wanted != "" and replay.get("mission", {}).get("id", "") != wanted:
		_hud.cancel_deferred()
		return
	_replaying = true
	for agent in _agents.values():
		agent.set_hidden(true)
	_replay.start(replay, _roster(), self, _target_for, label_scale)
	_hud.begin_replay(replay["mission"].get("title", ""), _replay.duration_ms, _replay.markers)


func _end_replay():
	if not _replaying:
		return
	_replay.stop()
	_replaying = false
	for agent in _agents.values():
		agent.set_hidden(false)
	_hud.end_replay()


func _apply_agent(a, snap):
	var agent = _agents.get(a.get("id", ""))
	if agent == null or not is_instance_valid(agent):
		return
	if snap:
		agent.snap_to(a)
	else:
		agent.push_state(a)


# Roster cards follow what the 3D agent is showing, not the raw (possibly queued) feed.
func _on_agent_state_applied(agent):
	if _hud != null and not agent.data.is_empty():
		_hud.set_agent(agent.data)


func _on_unit_selected(unit):
	if "agent_id" in unit:
		_hud.select_agent(unit.agent_id)
	elif "building_id" in unit:
		_hud.select_building(unit.building_id)
		if unit.building_id == "human_approval":
			_hud.open_approval_if_pending()


func _focus_building(building_id):
	var b = _bdef(building_id)
	if b != null:
		_camera.set_position_safely(Vector3(b["x"], 0, b["z"]))


func _fit_view():
	display_settings.zoom = display_settings.clamp_zoom(display_settings.ZOOM_DEFAULT)
	_camera.set_size_safely(display_settings.zoom)
	_move_camera_to_initial_position()
	display_settings.save_settings()


# ---------------------------------------------------------------- expeditions

# Web research is an expedition: an agent searching the web at a Research building walks
# out through a gate to a site in the wild (one per task, so new searches explore new
# land), and uncovers the shroud wherever it goes.
const RESEARCH_TOOLS = ["search", "browse", "fetch", "news", "rss", "scrap"]


func expedition_site(location, agent_id) -> Variant:
	var agent = _agents.get(agent_id)
	if agent == null or not is_instance_valid(agent):
		return null
	var d = agent.data
	var state = d.get("state", "")
	var b = _bdef(location)
	if b == null or b.get("capability", "") != "research" or state in ["idle", "complete", "error", "approval", "waiting"]:
		return null
	var task = d.get("taskId")
	var detail = str(d.get("detail", "")).to_lower()
	# Starts with a web tool call; then lasts for the whole task (thinking between searches
	# happens out in the field too), so agents don't walk in and out between calls.
	var key = "%s|%s|%s" % [agent_id, task if task != null else detail, location]
	if not _expeditions.has(key):
		if state != "working" or not RESEARCH_TOOLS.any(func(t): return detail.contains(t)):
			return null
		_expeditions[key] = _pick_site(abs(hash(key)))
	return _expeditions[key]


var _expeditions = {}  # agent|task|location -> site


func _pick_site(h: int) -> Vector3:
	var gates = _gates()
	var lim_lo = -WORLD_MARGIN + 3.5
	var lim_hi = Departments.MAP_SIZE + WORLD_MARGIN - 3.5
	for attempt in gates.size():
		var g = gates[(h + attempt) % gates.size()]
		var out_dir = (g["outside"] - g["inside"]).normalized()
		var side = Vector3(-out_dir.z, 0, out_dir.x)
		for push in [0.0, 1.0, -1.0]:
			var site = g["outside"] + out_dir * (7.0 + (h >> 4) % 15) + side * (float(((h >> 9) % 25) - 12) + push * 14.0)
			site.x = clampf(site.x, lim_lo, lim_hi)
			site.z = clampf(site.z, lim_lo, lim_hi)
			if _scenery == null or not _scenery.has_method("is_water") or not _scenery.is_water(site):
				return site
	return _gates()[h % 8]["outside"]  # everything is water: stop just outside a gate


func _gates() -> Array:
	var size = Departments.MAP_SIZE
	var out = []
	for v in Departments.STREETS:
		out.append({"inside": Vector3(v, 0, 2.0), "outside": Vector3(v, 0, -3.0)})
		out.append({"inside": Vector3(v, 0, size - 2.0), "outside": Vector3(v, 0, size + 3.0)})
		out.append({"inside": Vector3(2.0, 0, v), "outside": Vector3(-3.0, 0, v)})
		out.append({"inside": Vector3(size - 2.0, 0, v), "outside": Vector3(size + 3.0, 0, v)})
	return out


static func _outside_base(p: Vector3) -> bool:
	var size = Departments.MAP_SIZE
	return p.x < -0.3 or p.z < -0.3 or p.x > size + 0.3 or p.z > size + 0.3


func _nearest_gate(p: Vector3) -> Dictionary:
	var best = null
	for g in _gates():
		if best == null or g["outside"].distance_to(p) < best["outside"].distance_to(p):
			best = g
	return best


# Where an agent walks for a location: the expedition site or the usual slot, with the
# legs through a gate when the walk crosses the wall.
func _route_for(location, agent_id) -> Variant:
	var site = expedition_site(location, agent_id)
	var final = site if site != null else _target_for(location, agent_id)
	var agent = _agents.get(agent_id)
	if agent == null or not is_instance_valid(agent) or not agent.is_inside_tree():
		return final
	var from = agent.global_position
	var legs = []
	if _outside_base(from) and not _outside_base(final):
		var g = _nearest_gate(from)
		legs = [g["outside"], g["inside"]]
	elif not _outside_base(from) and _outside_base(final):
		var g = _nearest_gate(final)
		legs = [g["inside"], g["outside"]]
	legs.append(final)
	return legs if legs.size() > 1 else final


func _reveal_explorers(delta):
	_reveal_tick += delta
	if _reveal_tick < 0.25 or _shroud == null:
		return
	_reveal_tick = 0.0
	for agent in _agents.values():
		if is_instance_valid(agent) and agent.is_inside_tree() and _outside_base(agent.global_position):
			_shroud.reveal(agent.global_position)


# The camera may roam past the base into the (shrouded) land around it.
func _recalculate_camera_bounding_planes(map_size: Vector2):
	_camera.bounding_planes[0] = Plane(1, 0, 0, -WORLD_MARGIN)
	_camera.bounding_planes[1] = Plane(-1, 0, 0, -(map_size.x + WORLD_MARGIN))
	_camera.bounding_planes[2] = Plane(0, 0, 1, -WORLD_MARGIN)
	_camera.bounding_planes[3] = Plane(0, 0, -1, -(map_size.y + WORLD_MARGIN))


# Start framing the whole base (Open RTS starts on the player's units).
func _move_camera_to_initial_position():
	_camera.set_position_safely(Vector3(Departments.MAP_SIZE * 0.5, 0, Departments.MAP_SIZE * 0.5 - 0.8))


func _focus_agent(agent_id):
	var agent = _agents.get(agent_id)
	if agent == null:
		return
	MatchSignals.deselect_all_units.emit()
	agent.find_child("Selection").select()
	_camera.set_position_safely(agent.global_position)


# Dev aid: --capture-dir=DIR --capture-at=5,12,20 [--quit-after-capture] [--open-settings|--open-build]
# saves viewport screenshots at those seconds (used for automated visual checks).
func _setup_capture():
	var dir = ""
	var times = []
	var quit_after = false
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--capture-dir="):
			dir = arg.substr(14)
		elif arg.begins_with("--capture-at="):
			for t in arg.substr(13).split(","):
				times.append(float(t))
		elif arg == "--quit-after-capture":
			quit_after = true
		elif arg.begins_with("--select-agent="):
			get_tree().create_timer(3.0).timeout.connect(_hud.select_agent.bind(arg.substr(15)))
		elif arg.begins_with("--select-building="):
			get_tree().create_timer(3.0).timeout.connect(_hud.select_building.bind(arg.substr(18)))
		elif arg == "--open-settings":
			_hud._toggle_settings.call_deferred()
		elif arg.begins_with("--tab="):
			_hud._switch_tab.call_deferred(arg.substr(6))
		elif arg == "--open-build":
			_hud.toggle_build.call_deferred()
		elif arg == "--open-build-terrain":
			_hud.toggle_build.call_deferred()
			_hud._build_panel._switch_tab.call_deferred("terrain")
		elif arg == "--open-build-character":
			_hud.toggle_build.call_deferred()
			_hud._build_panel._switch_tab.call_deferred("agents")
			_hud._build_panel._open_agent_form.call_deferred(null)
	if dir != "" and "--terrain-tour" in OS.get_cmdline_user_args():
		_terrain_tour(dir, quit_after)
		return
	if dir == "" or times.is_empty():
		return
	DirAccess.make_dir_recursive_absolute(dir)
	for t in times:
		get_tree().create_timer(t, true, false, true).timeout.connect(
			func():
				var img = get_viewport().get_texture().get_image()
				img.save_png("%s/shot_%03d.png" % [dir, int(t)])
				if quit_after and t == times.max():
					get_tree().quit()
		)


func _terrain_tour(dir: String, quit_after: bool):
	DirAccess.make_dir_recursive_absolute(dir)
	for i in Terrains.ORDER.size():
		var id = Terrains.ORDER[i]
		get_tree().create_timer(3.0 + i * 3.0, true, false, true).timeout.connect(func(): _apply_terrain(id))
		get_tree().create_timer(5.5 + i * 3.0, true, false, true).timeout.connect(
			func():
				get_viewport().get_texture().get_image().save_png("%s/terrain_%02d_%s.png" % [dir, i, id])
				if quit_after and i == Terrains.ORDER.size() - 1:
					get_tree().quit()
		)
