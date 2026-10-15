extends Node3D

# Another team's base on the match map (docs/arena.md): a read-only connection to that
# team's adapter, its buildings and walls rendered at its origin on this world, and a plate
# with its live numbers. No agents and no crowd: those stay in the team's own window.

const BaseDressingScript = preload("res://source/agent/BaseDressing.gd")
const WorldDecorScript = preload("res://source/agent/WorldDecor.gd")
const WorldClientScript = preload("res://source/agent/WorldClient.gd")
const Fx = preload("res://source/agent/Fx.gd")
const Terrains = preload("res://source/agent/Terrains.gd")
const SPOT_COLORS = {"rally_point": Color(1.0, 0.82, 0.35), "repair_bay": Color(1.0, 0.35, 0.35)}

var team = "B"
var ws_url = ""
var offset = Vector3.ZERO  # this base's origin relative to the window's own base
var make_building: Callable  # AgentMatch._make_building(def) -> Building node
var label_scale = 1.0
var view_back = Vector3(0.7071, 0, 0.7071)
var terrain_id = ""  # the window's terrain theme: the roads take its colour


func set_terrain(id: String):
	terrain_id = id
	if _decor != null and id != "":
		_decor.set_road_color(Terrains.get_preset(id)["road"])

# Units take their player from their parent (Unit.player = get_parent()); a remote base plays
# that part for its buildings, in a muted tint of the other team.
var color = Color(0.72, 0.68, 0.62)
var _color_material: StandardMaterial3D

var _client
var _dressing
var _decor
var _buildings = {}
var _layout = {}
var _plate: Label3D
var _colony = {}


func _ready():
	position = offset
	_dressing = BaseDressingScript.new()
	_dressing.view_back = view_back
	add_child(_dressing)
	_decor = WorldDecorScript.new()
	_decor.ui_scale = label_scale
	_decor.view_up = -view_back
	add_child(_decor)
	set_terrain(terrain_id)
	_plate = Fx.label(self, "Team %s" % team, 30, Color(1.0, 0.97, 0.92), label_scale)
	_plate.position = Vector3(22, 7.5, 22)
	_client = WorldClientScript.new()
	_client.url = ws_url
	_client.message_received.connect(_on_message)
	add_child(_client)


func get_color_material():
	if _color_material == null:
		_color_material = StandardMaterial3D.new()
		_color_material.vertex_color_use_as_albedo = true
		_color_material.albedo_color = color
		_color_material.metallic = 1
	return _color_material


func _on_message(msg):
	match msg.get("type", ""):
		"snapshot":
			var world = msg["world"]
			if world.has("layout"):
				_apply_layout(world["layout"])
			_apply_colony(world.get("resources", {}).get("colony"))
		"layout.update":
			_apply_layout(msg["layout"])
		"resource.update":
			_apply_colony(msg["resources"].get("colony"))


func _apply_layout(layout: Dictionary):
	_layout = layout
	var wanted = {}
	for def in layout.get("buildings", []):
		wanted[def["id"]] = true
		var node = _buildings.get(def["id"])
		var sig = "%s|%s|%s|%s" % [def.get("label", ""), def.get("model", ""), def.get("x", 0), def.get("z", 0)]
		if node != null and is_instance_valid(node) and node.get_meta("rsig", "") == sig:
			node.set_construction(float(def.get("progress", 0.0)) if def.get("status", "built") == "building" else -1.0)
			continue
		if node != null and is_instance_valid(node):
			node.queue_free()
		var b = make_building.call(def)
		b.set_meta("rsig", sig)
		add_child(b)
		b.position = Vector3(def["x"], 0, def["z"])
		_buildings[def["id"]] = b
	for id in _buildings.keys():
		if not wanted.has(id):
			if is_instance_valid(_buildings[id]):
				_buildings[id].queue_free()
			_buildings.erase(id)
	_dressing.build(layout)
	# The same ground markings as the own base: streets, district tints and names, spots.
	_decor.clear()
	_decor.buildings = {}
	_decor.spots = {}
	for b in layout.get("buildings", []):
		_decor.buildings[b["id"]] = {"pos": Vector3(b["x"], 0, b["z"]), "accent": Color.html(b.get("color", "#ffffff")), "size": 3.6}
	for sp in layout.get("spots", []):
		_decor.spots[sp["id"]] = {"pos": Vector3(sp["x"], 0, sp["z"]), "color": SPOT_COLORS.get(sp["id"], Color.WHITE), "label": sp.get("label", "")}
	if _decor.spots.has("rally_point") and _decor.spots.has("repair_bay") and _decor.buildings.has("command_centre"):
		_decor.build()


func _apply_colony(colony):
	if colony == null or colony.is_empty():
		return
	_colony = colony
	for b in colony.get("buildings", []):
		var node = _buildings.get(b["id"])
		if node != null and is_instance_valid(node):
			node.set_economy({"enabled": b.get("enabled", true), "powered": b.get("powered", true), "producing": b.get("producing", false), "crew": b.get("crew", 0)})
	var col = colony.get("colonists", {})
	_plate.text = "Team %s · sol %d · %d awake · %d in cryo · chapter %s" % [team, int(colony.get("sol", 0)), int(col.get("awake", 0)), int(col.get("cryo", 0)), str(colony.get("story", {}).get("chapter", "I"))]
