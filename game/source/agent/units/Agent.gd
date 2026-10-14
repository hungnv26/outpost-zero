extends "res://source/match/units/Unit.gd"

# One AI agent. The adapter decides *what* the agent is doing; this node decides *how it
# looks*: it walks between locations, shows a status badge, and paces fast state changes
# so every step stays readable (an agent that finishes a task in 200 ms still visibly
# walks to the building and back).

signal state_applied(agent)

const Moving = preload("res://source/match/units/actions/Moving.gd")
const Fx = preload("res://source/agent/Fx.gd")

const MIN_DWELL_S = 1.2  # stay at least this long after arriving before walking on
const MAX_TRAVEL_WAIT_S = 9.0  # don't let a stuck walk block the queue forever
const MAX_QUEUE = 4

const STATE_STYLE = {
	"idle": {"text": "IDLE", "color": Color(0.72, 0.76, 0.82)},
	"thinking": {"text": "THINKING", "color": Color(0.75, 0.62, 1.0)},
	"working": {"text": "WORKING", "color": Color(0.35, 0.85, 1.0)},
	"waiting": {"text": "WAITING", "color": Color(1.0, 0.82, 0.35)},
	"approval": {"text": "NEEDS APPROVAL", "color": Color(1.0, 0.55, 0.2)},
	"error": {"text": "ERROR", "color": Color(1.0, 0.35, 0.35)},
	"complete": {"text": "DONE", "color": Color(0.4, 0.95, 0.55)},
}

var agent_id = ""
var display_name = ""
var role_color = Color.WHITE
var model_path = ""  # vehicle model; replaces the default rover
var model_size = 1.15
var model_height = 0.0  # > 0: an animated character, fitted to this height
# Callable(location_id: String, agent_id: String) -> Vector3
var resolve_target: Callable

var data = {}  # last applied agent dict from the adapter
var state = "idle"
var location = "command_centre"

var _queue = []
var _waypoints = []  # remaining legs of a multi-leg walk (e.g. out through a gate)
var _moving = false
var _move_started_at = -100.0
var _arrived_at = -100.0
var _badge: Label3D
var _name_label: Label3D
var _thinking_ring: MeshInstance3D
var _geometry: Node3D
var _geometry_base_y = 0.0
var _hidden = false
var _label_y = 1.35
var _label_back = 0.8  # labels sit screen-up (north) of the vehicle, clear of its body
var _anim: AnimationPlayer  # animated characters only
var _anim_names = {}  # role (idle, walk, run, work, call, yes, no) -> animation name
var _anim_current = ""
var _route: MeshInstance3D  # dashed line to where the agent is going, in its colour
var _route_mesh: ImmediateMesh


func _ready():
	if model_path != "":
		var geometry = find_child("Geometry")
		for child in geometry.get_children():
			geometry.remove_child(child)
			child.queue_free()
		var vehicle = Fx.fitted(model_path, model_size, model_height)
		geometry.add_child(vehicle)
		_setup_animations(vehicle)
		_label_y = vehicle.get_meta("height", 1.0) + 0.35  # just above the roof
		_label_back = model_size * 0.5 + 0.25
	await super()
	_geometry = find_child("Geometry")
	_geometry_base_y = _geometry.position.y
	_name_label = _make_label(26, Vector3(0, _label_y, 0))
	_name_label.offset = Vector2(0, 40)
	_name_label.text = display_name
	_name_label.modulate = role_color.lightened(0.25)
	_badge = _make_label(20, Vector3(0, _label_y, 0))
	_thinking_ring = _make_thinking_ring()
	_make_route()
	_make_ring()
	_render_badge()
	if _hidden:
		set_hidden(true)  # hidden before the labels existed (e.g. spawned during a replay)


func push_state(agent_dict):
	_queue.append(agent_dict)
	# Too far behind: drop intermediate steps, keep the MAX_QUEUE most recent.
	while _queue.size() > MAX_QUEUE:
		_queue.remove_at(0)


func snap_to(agent_dict):
	_queue.clear()
	_apply(agent_dict, false)
	# Stand there now: drop any walk _apply started and the spawn-time movement target.
	_waypoints.clear()
	action = null
	_moving = false
	var t = resolve_target.call(location, agent_id)
	global_position = t[t.size() - 1] if t is Array else t
	var nav = find_child("Movement")
	if nav != null:
		nav.move(global_position)


# Walk to where this agent's place is now (after the base layout changed).
func repark():
	if not resolve_target.is_valid() or _moving:
		return
	var t = resolve_target.call(location, agent_id)
	var dest = t[t.size() - 1] if t is Array else t
	if Vector2(dest.x - global_position.x, dest.z - global_position.z).length() < 0.3:
		return
	_waypoints = t.slice(1) if t is Array else []
	action = Moving.new(t[0] if t is Array else t)
	_moving = true
	_move_started_at = Time.get_ticks_msec() / 1000.0


func is_moving():
	return _moving


# Hide the agent's visuals (used while a replay's ghosts are on stage). The unit node
# itself can't be hidden: Open RTS's visibility handler re-shows units every frame.
func set_hidden(hidden: bool):
	_hidden = hidden
	for child in get_children():
		if child is Node3D:
			child.visible = not hidden
	if not hidden and _thinking_ring != null:
		_thinking_ring.visible = state == "thinking"


func _process(delta):
	var now = Time.get_ticks_msec() / 1000.0
	if not (action != null and action is Moving) and not _waypoints.is_empty():
		action = Moving.new(_waypoints.pop_front())
	var still_moving = action != null and action is Moving
	if _moving and not still_moving:
		_arrived_at = now
	_moving = still_moving

	if not _queue.is_empty():
		var next = _queue[0]
		if next.get("location", location) == location:
			_queue.remove_at(0)
			_apply(next, false)
		elif (
			(not _moving and now - _arrived_at >= MIN_DWELL_S)
			or (_moving and now - _move_started_at > MAX_TRAVEL_WAIT_S)
			or _queue.size() >= MAX_QUEUE
		):
			_queue.remove_at(0)
			_apply(next, true)
			_move_started_at = now

	_animate(delta, now)
	_place_labels()
	_draw_route()


func _apply(agent_dict, walk):
	data = agent_dict
	state = agent_dict.get("state", "idle")
	var new_location = agent_dict.get("location", location)
	var changed = new_location != location
	location = new_location
	# Always evaluated, so the current research site stays in sync.
	var new_site = resolve_target.is_valid() and _wants_new_site()
	if (walk and changed or (new_site and not changed)) and resolve_target.is_valid():
		var t = resolve_target.call(location, agent_id)
		_waypoints = t.slice(1) if t is Array else []
		action = Moving.new(t[0] if t is Array else t)
		_moving = true
		_move_started_at = Time.get_ticks_msec() / 1000.0  # also for same-location (expedition) walks
	_render_badge()
	state_applied.emit(self)


# A new research task at the same building sends the agent to a new site outside; the end
# of one brings it back inside.
var _site_task = null


func _wants_new_site() -> bool:
	if not _match.has_method("expedition_site"):
		return false
	var site = _match.expedition_site(location, agent_id)
	var key = str(site) if site != null else null
	var changed = key != _site_task  # a new site, or the expedition is over (walk back)
	_site_task = key
	return changed


func _render_badge():
	if _badge == null:
		return
	var style = STATE_STYLE.get(state, STATE_STYLE["idle"])
	var text = style["text"]
	var progress = data.get("progress")
	if state == "working" and progress != null:
		text += "  %d%%" % int(round(float(progress) * 100.0))
	if _moving:
		text = "> " + text
	_badge.text = text
	_badge.modulate = style["color"]


func _animate(delta, now):
	if _geometry == null:
		return
	_play_for_state()
	var bob = 0.0
	if _anim == null and state == "working" and not _moving:
		bob = 0.08 * abs(sin(now * 6.0))
	_geometry.position.y = lerpf(_geometry.position.y, _geometry_base_y + bob, clampf(delta * 12.0, 0.0, 1.0))

	_thinking_ring.visible = state == "thinking" and not _hidden

	if _badge != null:
		_badge.modulate.a = 1.0
	_render_badge_moving_prefix()


func _render_badge_moving_prefix():
	if _badge == null:
		return
	var has_prefix = _badge.text.begins_with("> ")
	if has_prefix != _moving:
		_render_badge()


func _make_label(font_size, pos):
	var label_scale = _match.label_scale if "label_scale" in _match else 1.0
	var l = Fx.label(self, "", font_size, Color.WHITE, label_scale, 0.0008)
	l.top_level = true  # don't turn with the vehicle; positioned in _place_labels
	l.position = pos
	return l


func _place_labels():
	# Screen-up of the vehicle, whichever way the camera faces.
	var up = Vector3(0, 0, -1)
	var cam = get_viewport().get_camera_3d()
	if cam != null:
		var z = cam.global_basis.z
		up = -Vector3(z.x, 0, z.z).normalized()
	var p = global_position + Vector3(0, _label_y, 0) + up * _label_back
	if _name_label != null:
		_name_label.global_position = p
	if _badge != null:
		_badge.global_position = p


# Characters act out the agent's state: walk or run while travelling, a working loop at a
# building, wave for attention (approval, waiting), shake the head after an error.
const ANIM_ROLES = {
	"idle": ["Idle", "Flying_Idle"],
	"walk": ["Walk", "Fast_Flying"],
	"run": ["Run", "Fast_Flying"],
	"work": ["Pickup", "Yes", "Punch"],
	"call": ["Wave", "Hello", "Yes"],
	"no": ["No"],
	"yes": ["Yes", "Hello", "Wave"],
}


func _setup_animations(model: Node3D):
	var players = model.find_children("*", "AnimationPlayer", true, false)
	if players.is_empty():
		return
	_anim = players[0]
	var names = {}
	for full in _anim.get_animation_list():
		names[full.get_slice("|", full.get_slice_count("|") - 1)] = full
	for role in ANIM_ROLES:
		for short in ANIM_ROLES[role]:
			if names.has(short):
				_anim_names[role] = names[short]
				break
	for role in ["idle", "walk", "run", "work", "call", "no"]:
		if _anim_names.has(role):
			_anim.get_animation(_anim_names[role]).loop_mode = Animation.LOOP_LINEAR


func _play_for_state():
	if _anim == null:
		return
	var role = "idle"
	if _moving:
		role = "run" if global_position.distance_to(_route_end()) > 8.0 else "walk"
	else:
		match state:
			"working", "thinking":
				role = "work" if state == "working" else "idle"
			"approval", "waiting":
				role = "call"
			"error":
				role = "no"
			"complete":
				role = "yes"
	var anim_name = _anim_names.get(role, _anim_names.get("idle", ""))
	if anim_name != "" and anim_name != _anim_current:
		_anim_current = anim_name
		_anim.play(anim_name, 0.25)


func _route_end() -> Vector3:
	var nav = find_child("Movement")
	if nav != null:
		var path = nav.get_current_navigation_path()
		if path.size() > 0:
			return path[path.size() - 1]
	return global_position


# A thin ring in the agent's colour at its feet: who is who, at a glance.
func _make_ring():
	var mat = StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = role_color
	var r = max(0.45, model_size * 0.45)
	var ring = Fx.torus(r - 0.06, r, mat, 0.04)
	ring.position = Vector3(0, 0.05, 0)
	add_child(ring)


func _make_route():
	_route_mesh = ImmediateMesh.new()
	_route = MeshInstance3D.new()
	_route.mesh = _route_mesh
	_route.top_level = true
	_route.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mat = StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_color = Color(role_color.lightened(0.15), 0.9)
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	_route.material_override = mat
	add_child(_route)


# Dashes along the navigation path still ahead of a moving agent (none when it stands).
func _draw_route():
	if _route_mesh == null:
		return
	_route_mesh.clear_surfaces()
	var nav = find_child("Movement")
	if not _moving or _hidden or nav == null:
		return
	var pts = [global_position]
	var path = nav.get_current_navigation_path()
	for i in range(nav.get_current_navigation_path_index(), path.size()):
		pts.append(path[i])
	if pts.size() < 2:
		return
	const DASH = 0.42
	const GAP = 0.3
	const HALF_W = 0.07
	# Cumulative distance along the path, then one dash per (DASH + GAP) step.
	var dist = [0.0]
	for i in range(1, pts.size()):
		dist.append(dist[i - 1] + Vector2(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z).length())
	var total = dist[dist.size() - 1]
	if total < 0.05:
		return
	_route.global_transform = Transform3D.IDENTITY
	_route_mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	for k in int(total / (DASH + GAP)) + 1:
		var s0 = k * (DASH + GAP)
		var s1 = min(s0 + DASH, total)
		if s1 - s0 < 0.02:
			continue
		var p0 = _point_at(pts, dist, s0)
		var p1 = _point_at(pts, dist, s1)
		var dir = (p1 - p0).normalized()
		var side = Vector3(-dir.z, 0, dir.x) * HALF_W
		for v in [p0 - side, p0 + side, p1 + side, p0 - side, p1 + side, p1 - side]:
			_route_mesh.surface_add_vertex(v)
	_route_mesh.surface_end()


static func _point_at(pts: Array, dist: Array, d: float) -> Vector3:
	for i in range(1, pts.size()):
		if d <= dist[i] or i == pts.size() - 1:
			var seg = max(0.0001, dist[i] - dist[i - 1])
			var p = pts[i - 1].lerp(pts[i], clampf((d - dist[i - 1]) / seg, 0.0, 1.0))
			return Vector3(p.x, 0.07, p.z)
	return Vector3(pts[0].x, 0.07, pts[0].z)


func _make_thinking_ring():
	var ring = MeshInstance3D.new()
	var torus = TorusMesh.new()
	torus.inner_radius = 0.18
	torus.outer_radius = 0.26
	ring.mesh = torus
	var mat = StandardMaterial3D.new()
	mat.albedo_color = Color(0.95, 0.95, 0.98)
	mat.roughness = 0.8
	ring.material_override = mat
	ring.position = Vector3(0, _label_y - 0.15, 0)
	ring.visible = false
	add_child(ring)
	return ring


# Paint the vehicle's trim (Kenney's yellow/orange accent surfaces) in the agent's colour.
func _setup_color():
	var mat = StandardMaterial3D.new()
	mat.albedo_color = role_color
	mat.roughness = 0.6
	for mi in find_child("Geometry").find_children("*", "MeshInstance3D", true, false):
		for i in mi.get_surface_override_material_count():
			var m = mi.get_active_material(i)
			if m is BaseMaterial3D and _is_trim(m.albedo_color):
				mi.set_surface_override_material(i, mat)


static func _is_trim(c: Color) -> bool:
	return c.r > 0.75 and c.g > 0.45 and c.b < 0.6 and c.r - c.b > 0.3


func _setup_default_properties_from_constants():
	sight_range = 6.0
	hp = 10
	hp_max = 10
