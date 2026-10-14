extends "res://source/match/units/Structure.gd"

# A capability in the agent world (Research Lab, Code Factory, ...). Placed by AgentMatch.
# Kept plain on purpose: the model, its name, and a status line saying who is working
# inside (or that it needs you, for Human Approval). No lights, no effects.

const Fx = preload("res://source/agent/Fx.gd")

var building_id = ""
var label = ""
var model_path = ""
var model_size = 3.0  # footprint (largest horizontal extent) the model is fitted to
var accent = Color(0.4, 0.75, 1.0)  # department colour
var icon_kind = ""  # department icon for the name plate
var snapshots = null  # HUD renderer for the name plate (Snapshots.gd)

var alert = false:  # e.g. Human Approval has a pending request
	set(value):
		if alert != value:
			alert = value
			_render_status()

var _occupants = {}  # agent_id -> display name
var _label3d: Label3D
var _status3d: Label3D
var _pivot: Node3D


func _ready():
	if model_path != "":
		_pivot = Fx.fitted(model_path, model_size, 0.0, 4.2)  # tall models (rocket) stay in scale
		find_child("Geometry").add_child(_pivot)
		_add_extras()
	await super()
	var ui_scale = _match.label_scale if "label_scale" in _match else 1.0
	var top = max(2.4, (_pivot.get_meta("height", 2.0) if _pivot else 2.0) + 0.7)
	_label3d = Fx.label(self, label, 26, Color(1.0, 0.97, 0.92), ui_scale)
	_label3d.position = Vector3(0, top, 0)
	_status3d = Fx.label(self, "", 19, accent.lightened(0.2), ui_scale)
	_status3d.position = Vector3(0, top, 0)
	_status3d.offset = Vector2(0, -30)
	if snapshots != null and icon_kind != "":
		_make_name_plate(top, ui_scale)
	_render_status()


# Finishing touches on some models: a roof module on KayKit domes (picked per building,
# so neighbours differ) and a parked ship on landing pads.
const ROOFS = ["roofmodule_solarpanels", "roofmodule_cargo_A", "roofmodule_cargo_B", "roofmodule_solarpanels", "roofmodule_base"]


func _add_extras():
	var model = _pivot.get_child(0)
	var file = model_path.get_file().get_basename()
	if file.begins_with("basemodule_") and file != "basemodule_garage":
		var roof = load("res://assets/models/kaykit-spacebase/%s.gltf" % ROOFS[abs(hash(building_id)) % ROOFS.size()]).instantiate()
		roof.position = Vector3(0, 1.0, 0)
		model.add_child(roof)
		_pivot.set_meta("height", _pivot.get_meta("height", 2.0) * 1.5)
	elif file == "landingpad_large":
		var ship = load("res://assets/models/quaternius-space/Spaceship_A.glb").instantiate()
		ship.scale = Vector3.ONE * 0.15
		ship.position = Vector3(0, 0.5, 0)
		ship.rotation.y = PI * 0.25
		model.add_child(ship)
		_pivot.set_meta("height", 2.4)


# The name as a plate (department icon + name on a dark pill), rendered once by the HUD.
func _make_name_plate(top: float, ui_scale: float):
	var plate = Sprite3D.new()
	plate.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	plate.fixed_size = true
	plate.no_depth_test = true
	plate.render_priority = 2
	plate.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	plate.set_meta("base_px", 0.00052)
	plate.pixel_size = 0.00052 * ui_scale
	plate.add_to_group(Fx.LABEL_GROUP)
	plate.position = Vector3(0, top, 0)
	add_child(plate)
	snapshots.building_badge(label, icon_kind, accent, func(t):
		if is_instance_valid(plate):
			plate.texture = t
			_label3d.visible = false
	)
	_status3d.offset = Vector2(0, -46)


func set_occupant(agent_id, working, display_name = ""):
	var changed = false
	if working and not _occupants.has(agent_id):
		_occupants[agent_id] = display_name if display_name != "" else str(agent_id).capitalize()
		changed = true
	elif not working and _occupants.has(agent_id):
		_occupants.erase(agent_id)
		changed = true
	if changed:
		_render_status()


func _render_status():
	if _status3d == null:
		return
	if alert:
		_status3d.text = "Waiting for you"
		_status3d.modulate = Color(1.0, 0.62, 0.25)
	elif not _occupants.is_empty():
		_status3d.text = "%s working" % ", ".join(_occupants.values())
		_status3d.modulate = accent.lightened(0.25)
	else:
		_status3d.text = ""


func _setup_default_properties_from_constants():
	sight_range = 10.0
	hp = 20
	hp_max = 20
