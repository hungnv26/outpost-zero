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
var construction = -1.0  # 0..1 while under construction, -1 once built
var economy = {}  # this building's line in the colony view (enabled, powered, producing, crew...)
var _econ_sig = ""


func _ready():
	if model_path != "":
		_pivot = Fx.fitted(model_path, model_size, 0.0, 4.2)  # tall models (rocket) stay in scale
		find_child("Geometry").add_child(_pivot)
		_add_extras()
		_apply_construction()
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


# Construction progress from the adapter (-1 when the building is finished). The shell
# rises with the work: the model grows from a slab to full height.
func set_construction(progress: float):
	if is_equal_approx(construction, progress):
		return
	construction = progress
	_apply_construction()
	_render_status()


func _apply_construction():
	if _pivot == null:
		return
	if construction < 0.0:
		_pivot.scale = Vector3.ONE
	else:
		_pivot.scale = Vector3(1.0, 0.12 + 0.88 * clampf(construction, 0.0, 1.0), 1.0)


# The economy's view of this building (see docs/economy.md §13).
func set_economy(info: Dictionary):
	var sig = JSON.stringify(info)
	if sig == _econ_sig:
		return
	_econ_sig = sig
	economy = info
	_render_status()


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
	elif construction >= 0.0:
		_status3d.text = "Under construction %d%%" % int(round(construction * 100.0))
		_status3d.modulate = Color(1.0, 0.85, 0.5)
	elif not economy.is_empty() and not economy.get("enabled", true):
		_status3d.text = "Switched off"
		_status3d.modulate = Color(0.7, 0.72, 0.78)
	elif not economy.is_empty() and not economy.get("powered", true):
		_status3d.text = "No power"
		_status3d.modulate = Color(1.0, 0.45, 0.45)
	elif not _occupants.is_empty() or int(economy.get("crew", 0)) > 0:
		var parts = []
		if int(economy.get("crew", 0)) > 0:
			parts.append("%d colonists" % int(economy["crew"]))
		parts.append_array(_occupants.values())
		_status3d.text = "%s working" % ", ".join(parts)
		_status3d.modulate = accent.lightened(0.25)
	else:
		_status3d.text = ""


func _setup_default_properties_from_constants():
	sight_range = 10.0
	hp = 20
	hp_max = 20
