extends Node3D

# A stand-in for an agent during a mission replay (a translucent copy of its vehicle). Exposes the same fields the
# world reads from real agents (agent_id, state, location, role_color, is_moving()), so
# buildings, conduits and work beams react to the replay exactly as they did live.

const Fx = preload("res://source/agent/Fx.gd")
const STATE_STYLE = preload("res://source/agent/units/Agent.gd").STATE_STYLE
const ROVER = "res://assets/models/kenney-spacekit/rover.glb"
const MOVE_S = 0.75  # real seconds per walk, whatever the replay speed

var agent_id = ""
var display_name = ""
var role_color = Color.WHITE
var model_path = ROVER
var model_size = 1.1
var model_height = 0.0  # characters are fitted by height
var state = "idle"
var location = "command_centre"
var data = {}

var _from = Vector3.ZERO
var _to = Vector3.ZERO
var _t = 1.0
var _badge: Label3D
var _holo: StandardMaterial3D
var _model: Node3D
var _labels = []
var _label_offset = Vector3(0, 1.5, -0.8)


func setup(ui_scale: float):
	_holo = StandardMaterial3D.new()
	_holo.albedo_color = Color(role_color.lightened(0.15), 0.7)
	_holo.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_holo.roughness = 0.8
	_model = Fx.fitted(model_path, model_size, model_height)
	for mi in _model.find_children("*", "MeshInstance3D", true, false):
		mi.material_override = _holo
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_model.position.y = 0.15
	add_child(_model)
	_label_offset = Vector3(0, _model.get_meta("height", 1.0) + 0.35, -(model_size * 0.5 + 0.25))
	var name_label = Fx.label(self, display_name, 26, role_color.lightened(0.3), ui_scale)
	name_label.top_level = true
	name_label.offset = Vector2(0, 40)
	_badge = Fx.label(self, "", 20, Color.WHITE, ui_scale)
	_badge.top_level = true
	_labels = [name_label, _badge]


func snap(agent: Dictionary, pos: Vector3):
	data = agent
	state = agent.get("state", "idle")
	location = agent.get("location", "command_centre")
	position = pos
	_from = pos
	_to = pos
	_t = 1.0
	_render_badge()


func apply(agent: Dictionary, pos: Vector3):
	data = agent
	state = agent.get("state", "idle")
	var new_location = agent.get("location", location)
	if new_location != location or pos.distance_to(_to) > 0.05:
		_from = position
		_to = pos
		_t = 0.0
	location = new_location
	_render_badge()


func is_moving():
	return _t < 1.0


func _process(delta):
	var now = Time.get_ticks_msec() / 1000.0
	for l in _labels:
		l.global_position = global_position + _view_offset()
	if _t < 1.0:
		_t = min(1.0, _t + delta / MOVE_S)
		var e = _t * _t * (3.0 - 2.0 * _t)
		position = _from.lerp(_to, e)
		var dir = _to - _from
		if dir.length() > 0.01:
			look_at(global_position + Vector3(dir.x, 0, dir.z), Vector3.UP)
	if _model != null:
		_model.position.y = 0.15 + (0.08 * abs(sin(now * 6.0)) if state == "working" and _t >= 1.0 else 0.0)


func _render_badge():
	var style = STATE_STYLE.get(state, STATE_STYLE["idle"])
	var text = style["text"]
	var progress = data.get("progress")
	if state == "working" and progress != null:
		text += "  %d%%" % int(round(float(progress) * 100.0))
	_badge.text = text
	_badge.modulate = style["color"]


# _label_offset with its "back" part turned to screen-up for the current camera.
func _view_offset() -> Vector3:
	var cam = get_viewport().get_camera_3d()
	if cam == null:
		return _label_offset
	var z = cam.global_basis.z
	var up = -Vector3(z.x, 0, z.z).normalized()
	return Vector3(0, _label_offset.y, 0) + up * -_label_offset.z
