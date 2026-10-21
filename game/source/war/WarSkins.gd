extends Node

# Outpost Zero's models for Outpost War's units (docs/outpost-war.md). Each unit keeps its Open RTS
# body (collision, movement, health, weapons); only what you see changes: its own geometry is
# hidden and an Outpost Zero model takes its place inside the same Geometry node, so a building
# under construction still shows as one. A team-coloured ring at its feet tells the sides apart.
# Characters animate with what the unit is doing: walking, standing, shooting, flying.

const Fx = preload("res://source/agent/Fx.gd")
const AutoAttacking = preload("res://source/match/units/actions/AutoAttacking.gd")

const KENNEY = "res://assets/models/kenney-spacekit/"
const KAYKIT = "res://assets/models/kaykit-spacebase/"
const QUATERNIUS = "res://assets/models/quaternius-space/"

# Open RTS unit -> [[model, yaw] choices, footprint scale (x the unit's radius x 2), height or 0].
# Only machines and armed people (the user's choice, 2026-10-21): soldiers for workers, tanks and
# combat mechs for tanks, gunships for helicopters, a speeder for the scout drone; no creatures.
# Quaternius models face +Z while Open RTS units move toward -Z: they are turned round (PI).
const SKINS = {
	"Worker": [[[QUATERNIUS + "Astronaut_A.glb", PI], [QUATERNIUS + "Astronaut_B.glb", PI], [QUATERNIUS + "Astronaut_C.glb", PI]], 0.0, 1.25],
	"Tank": [[["composite:tank", 0.0], [QUATERNIUS + "Mech_A.glb", PI], ["composite:tank", 0.0], [QUATERNIUS + "Mech_C.glb", PI]], 0.0, 1.6],
	"Helicopter": [[[QUATERNIUS + "Spaceship_A.glb", PI], [QUATERNIUS + "Spaceship_C.glb", PI]], 2.0, 0.0],
	"Drone": [[[KENNEY + "craft_speederA.glb", 0.0]], 1.6, 0.0],
	"CommandCenter": [[[QUATERNIUS + "BaseLarge.glb", 0.0]], 1.15, 0.0],
	"VehicleFactory": [[[KAYKIT + "basemodule_garage.gltf", 0.0]], 1.1, 0.0],
	"AircraftFactory": [[[KENNEY + "hangar_largeA.glb", 0.0]], 1.1, 0.0],
	"AntiGroundTurret": [[[KENNEY + "turret_double.glb", 0.0]], 1.2, 0.0],
	"AntiAirTurret": [[[KENNEY + "turret_single.glb", 0.0]], 1.2, 0.0],
}
# Gun-carrying versions first: soldiers walk and stand with their weapon ready.
const ANIMS = {
	"idle": ["Idle_Gun", "Idle"],
	"walk": ["Walk_Gun", "Walk"],
	"shoot": ["Run_Gun_Shoot", "Shoot_Small", "Idle_Gun"],
}

var _animated = {}  # unit instance id -> {unit, player, names, last, current}


func _ready():
	MatchSignals.unit_spawned.connect(_on_unit_spawned)
	for unit in get_tree().get_nodes_in_group("units"):
		_skin.call_deferred(unit)


func _on_unit_spawned(unit):
	_skin.call_deferred(unit)


func _skin(unit):
	if not is_instance_valid(unit) or unit.has_meta("outpost_skin"):
		return
	if not unit.is_node_ready():
		await unit.ready
	var kind = unit.get_script().resource_path.get_file().get_basename()
	if not SKINS.has(kind):
		return
	unit.set_meta("outpost_skin", true)
	var spec = SKINS[kind]
	var geometry = unit.find_child("Geometry")
	if geometry == null:
		return
	for child in geometry.get_children():
		if child is VisualInstance3D or child.find_children("*", "VisualInstance3D", true, false).size() > 0:
			child.visible = false
	var choices: Array = spec[0]
	var choice = choices[abs(unit.get_instance_id()) % choices.size()]
	var radius = unit.radius if unit.radius != null else 1.0
	# A vehicle (no height given for it) is fitted to the unit's footprint instead.
	var vehicle = str(choice[0]).begins_with("composite:")
	var model = Fx.fitted(choice[0], radius * 2.2 if vehicle else radius * 2.0 * spec[1], 0.0 if vehicle else spec[2])
	model.rotation.y = choice[1]
	geometry.add_child(model)
	_ring(unit, radius)
	var players = model.find_children("*", "AnimationPlayer", true, false)
	if not players.is_empty():
		var names = _animation_names(players[0])
		_animated[unit.get_instance_id()] = {"unit": unit, "player": players[0], "names": names, "last": unit.global_position, "current": ""}
		_play(_animated[unit.get_instance_id()], "idle")


# A flat ring in the team's colour at the unit's feet (on the ground under aircraft).
func _ring(unit, radius: float):
	var mat = StandardMaterial3D.new()
	mat.albedo_color = unit.player.color
	mat.roughness = 0.8
	var ring = Fx.torus(radius * 0.9, radius * 1.05, mat)
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	unit.add_child(ring)
	ring.position.y = 0.04 - unit.global_position.y


func _animation_names(player: AnimationPlayer) -> Dictionary:
	var short = {}
	for full in player.get_animation_list():
		short[full.get_slice("|", full.get_slice_count("|") - 1)] = full
	var out = {}
	for role in ANIMS:
		for name in ANIMS[role]:
			if short.has(name):
				out[role] = short[name]
				break
	for role in ["idle", "walk"]:
		if out.has(role):
			player.get_animation(out[role]).loop_mode = Animation.LOOP_LINEAR
	return out


func _process(delta):
	if delta <= 0.0:
		return
	for key in _animated.keys():
		var a = _animated[key]
		var unit = a["unit"]
		if not is_instance_valid(unit) or not unit.is_inside_tree():
			_animated.erase(key)
			continue
		var speed = (unit.global_position - a["last"]).length() / delta
		a["last"] = unit.global_position
		var role = "idle"
		if speed > 0.3:
			role = "walk"
		elif unit.action is AutoAttacking:
			role = "shoot"
		_play(a, role)


func _play(a: Dictionary, role: String):
	var name = a["names"].get(role, a["names"].get("idle", ""))
	if name == "" or name == a["current"]:
		return
	a["current"] = name
	a["player"].play(name, 0.2)
	if role == "shoot":
		a["player"].get_animation(name).loop_mode = Animation.LOOP_LINEAR
