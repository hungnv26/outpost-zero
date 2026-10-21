extends Node3D

# Outpost Zero's look for an Outpost War battle (docs/outpost-war.md): one of Outpost Zero's ten
# battlefields (design/maps.json) dresses the plain Open RTS map.
# - Terrain: the battlefield's ground textures and light (agent/Terrains.gd), with the textured
#   ground running on past the map's edge.
# - Scenery: Outpost Zero's trees, rocks, craters, mesas and water around the map
#   (agent/Scenery.gd), outside the playable area, so they never get in the way.
# - Units: Outpost Zero's astronauts, mechs, craft and buildings in place of Open RTS's models
#   (war/WarSkins.gd).
# - Battlefield: the battlefield's own structures and obstacles (wrecks, relays, ruins, ridges,
#   craters, lakes...) placed between the bases and drawn by agent/Battlefield.gd. Unlike the
#   scenery they block movement and building, so the layout is fair: it is generated in one
#   quarter of the map and mirrored into the other three, as the maps' spawns are. Spawn areas,
#   deposits and a lane from each base to the centre stay clear, and every item keeps a gap a tank
#   fits through, so there is always a way round.

const Terrains = preload("res://source/agent/Terrains.gd")
const SceneryScript = preload("res://source/agent/Scenery.gd")
const BattlefieldScript = preload("res://source/agent/Battlefield.gd")
const TERRAIN_SHADER = preload("res://source/agent/terrain.gdshader")

const LINE_KINDS = ["ridge", "chasm", "monorail", "pipeline"]
const SPAWN_CLEAR_M = 9.5  # on Plain & Simple; scaled with the map. Leaves room to build at home.
const LANE_HALF_WIDTH_M = 2.6
const GAP_M = 2.6  # between items: wider than a tank (agent radius 0.9)

var field_name = ""
var placed = 0  # items on the map, all four quarters


# `field`: {id, name, terrain, obstacles: [{kind, ...}], structures: [{kind, ...}]} from the
# battle service. Call once the match is in the tree.
func dress(match_node: Node, field: Dictionary):
	var terrain = str(field.get("terrain", "mars"))
	field_name = str(field.get("name", ""))
	var map = match_node.map
	var size: Vector2 = map.size
	_ground(map, size, terrain)
	_light(match_node, terrain)
	# As in Outpost Zero (agent/AgentMatch.tscn): no haze past the map's edge, and when the whole
	# map is shown no fog-of-war layer either, so the land and scenery around the map show.
	var haze = match_node.find_child("Fog", false)
	if haze != null:
		haze.visible = false
	if match_node.settings.visibility == match_node.settings.Visibility.FULL:
		var overlay = match_node.find_child("ScreenOverlay", true, false)
		if overlay != null:
			overlay.visible = false
	var scenery = SceneryScript.new()
	scenery.map_size = size.x
	scenery.map_depth = size.y
	add_child(scenery)
	scenery.build(terrain)
	# The layout checks each spot against the ground's navigation map, which Godot builds in the
	# background when the match starts: wait until it answers (on a bigger map it is not ready yet
	# on the first frames, and every spot then looked blocked).
	var nav = match_node.navigation.get_navigation_map_rid_by_domain(Constants.Match.Navigation.Domain.TERRAIN)
	for _i in range(300):
		if _navigation_ready(nav, size):
			break
		await get_tree().physics_frame
	var spec = _layout(match_node, field, size)
	placed = spec["obstacles"].size() + spec["structures"].size()
	var drawn = BattlefieldScript.new()
	add_child(drawn)
	drawn.set_battlefield(spec, Vector3.ZERO)
	_block(spec)
	print("Battlefield %s (%s): %d items" % [field_name, terrain, placed])
	# Outpost Zero's models for the units and buildings themselves (war/WarSkins.gd).
	var skins = load("res://source/war/WarSkins.gd").new()
	skins.name = "WarSkins"
	add_child(skins)


func _ground(map, size: Vector2, terrain: String):
	var mat = ShaderMaterial.new()
	mat.shader = TERRAIN_SHADER
	Terrains.apply_to_material(mat, terrain)
	var ground = map.find_child("Terrain")
	var mesh = ground.mesh.duplicate()
	mesh.material = mat
	ground.mesh = mesh
	# The same ground beyond the edge, under the scenery (not part of navigation).
	var backdrop = MeshInstance3D.new()
	var plane = PlaneMesh.new()
	plane.size = size + Vector2(260, 260)
	plane.center_offset = Vector3(size.x / 2.0, 0, size.y / 2.0)
	plane.material = mat
	backdrop.mesh = plane
	backdrop.position.y = -0.03
	backdrop.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(backdrop)


# As AgentMatch._apply_terrain: the terrain's sun and ambient light, soft shadows, no haze.
func _light(match_node: Node, terrain: String):
	var t = Terrains.get_preset(terrain)
	var env_node = match_node.find_child("WorldEnvironment", false)
	var sun = match_node.find_child("DirectionalLight3D", false)
	if env_node != null:
		env_node.environment = env_node.environment.duplicate()
		var env = env_node.environment
		env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
		env.ambient_light_color = t["ambient"]
		env.ambient_light_energy = t["ambient_energy"]
		env.fog_enabled = false
		env.volumetric_fog_enabled = false
		env.tonemap_mode = Environment.TONE_MAPPER_ACES
		env.adjustment_enabled = true
		env.adjustment_saturation = 1.12
		env.adjustment_contrast = 1.05
		env.ssao_enabled = true
		env.ssao_radius = 1.4
		env.ssao_intensity = 1.8
	if sun != null:
		sun.light_color = t["sun"]
		sun.light_energy = t["sun_energy"] * 1.1
		sun.light_angular_distance = 1.5
		sun.shadow_blur = 1.2


static func _navigation_ready(nav: RID, size: Vector2) -> bool:
	for f in [Vector2(0.5, 0.5), Vector2(0.25, 0.25), Vector2(0.75, 0.75), Vector2(0.25, 0.75), Vector2(0.75, 0.25)]:
		var probe = Vector3(size.x * f.x, 0, size.y * f.y)
		var closest = NavigationServer3D.map_get_closest_point(nav, probe)
		if Vector2(closest.x, closest.z).distance_to(Vector2(probe.x, probe.z)) < 0.05:
			return true
	return false


# ---- the mirrored battlefield ----


func _layout(match_node: Node, field: Dictionary, size: Vector2) -> Dictionary:
	var scale = sqrt(size.x * size.y) / 50.0  # item sizes and clearances grow with the map's area
	var rng = RandomNumberGenerator.new()
	rng.seed = hash(str(field.get("id", "")) + str(size))
	var spawns = []
	var points = match_node.map.find_child("SpawnPoints")
	for p in points.get_children():
		spawns.append(Vector2(p.global_position.x, p.global_position.z))
	var deposits = []
	for d in get_tree().get_nodes_in_group("resource_units"):
		deposits.append(Vector2(d.global_position.x, d.global_position.z))
	var lanes = _lanes(spawns, size)
	var nav = match_node.navigation.get_navigation_map_rid_by_domain(
		Constants.Match.Navigation.Domain.TERRAIN
	)
	var kinds = []
	for item in field.get("obstacles", []):
		kinds.append(["obstacle", item])
	for item in field.get("structures", []):
		# A decorative turret looks just like a working one in Outpost War: a generator instead.
		if str(item.get("kind", "")) == "turret":
			item = item.duplicate()
			item["kind"] = "generator"
		kinds.append(["structure", item])
	var out = {"id": str(field.get("id", "")), "terrain": str(field.get("terrain", "mars")), "obstacles": [], "structures": []}
	if kinds.is_empty():
		return out
	var half = size / 2.0
	var target = int(round(5 * scale))  # items per quarter, if they fit
	var accepted = []  # [{kind info, circles: [[Vector2, r]], item}]
	var tries = 0
	while accepted.size() < target and tries < 400:
		tries += 1
		var pick = kinds[rng.randi() % kinds.size()]
		var item = _sized(pick[1], rng, scale)
		var at = Vector2(rng.randf_range(2.0, half.x - 1.0), rng.randf_range(2.0, half.y - 1.0))
		var circles = []
		if str(item["kind"]) in LINE_KINDS:
			var length = rng.randf_range(4.0, 6.5) * scale
			var dir = Vector2.RIGHT.rotated(rng.randf() * TAU)
			var b = at + dir * length
			item["x2"] = b.x
			item["z2"] = b.y
			var w = float(item.get("w", 2.0))
			var steps = int(ceil(length / 1.5))
			for i in steps + 1:
				circles.append([at.lerp(b, float(i) / steps), w * 0.5 + 0.4])
		else:
			circles.append([at, _radius(item)])
		item["x"] = at.x
		item["z"] = at.y
		if not _fits(circles, accepted, spawns, deposits, lanes, half, nav, scale):
			continue
		accepted.append({"pick": pick[0], "item": item, "circles": circles})
	for a in accepted:
		for mirror in [Vector2(1, 1), Vector2(-1, 1), Vector2(1, -1), Vector2(-1, -1)]:
			var copy = a["item"].duplicate()
			var m = func(x: float, z: float) -> Vector2:
				return Vector2(x if mirror.x > 0 else size.x - x, z if mirror.y > 0 else size.y - z)
			var p = m.call(float(copy["x"]), float(copy["z"]))
			copy["x"] = p.x
			copy["z"] = p.y
			if copy.has("x2"):
				var q = m.call(float(copy["x2"]), float(copy["z2"]))
				copy["x2"] = q.x
				copy["z2"] = q.y
			if copy.has("rot"):
				var yaw = float(copy["rot"])
				if mirror.x < 0:
					yaw = -yaw
				if mirror.y < 0:
					yaw = 180.0 - yaw
				copy["rot"] = yaw
			out["obstacles" if a["pick"] == "obstacle" else "structures"].append(copy)
	return out


# The battlefield's item with sizes for an Outpost War map.
func _sized(base: Dictionary, rng: RandomNumberGenerator, scale: float) -> Dictionary:
	var item = {"kind": str(base.get("kind", "rock"))}
	if base.has("liquid"):
		item["liquid"] = base["liquid"]
	match item["kind"]:
		"crater", "lake", "crystals", "meteors":
			item["r"] = rng.randf_range(1.2, 2.0) * scale
		"mesa":
			item["r"] = rng.randf_range(1.2, 1.8) * scale
			item["h"] = rng.randf_range(2.5, 4.0) * scale
		"ridge", "chasm":
			item["w"] = 1.6 * scale
		"monorail", "pipeline":
			item["w"] = 1.2 * scale
		_:
			item["size"] = rng.randf_range(2.8, 4.0) * scale
			item["rot"] = rng.randf() * 360.0
	return item


func _radius(item: Dictionary) -> float:
	if item.has("r"):
		return float(item["r"]) + (1.0 if item["kind"] == "mesa" else 0.3)
	return float(item.get("size", 4.0)) * 0.5


# Lanes kept open: each spawn to the map's centre.
func _lanes(spawns: Array, size: Vector2) -> Array:
	var center = size / 2.0
	var out = []
	for s in spawns:
		out.append([s, center])
	return out


func _fits(circles: Array, accepted: Array, spawns: Array, deposits: Array, lanes: Array, half: Vector2, nav: RID, scale: float) -> bool:
	for c in circles:
		var p: Vector2 = c[0]
		var r: float = c[1]
		# Inside its quarter, clear of the mirror lines (so the copies do not touch) and the edge.
		if p.x - r < 1.5 or p.y - r < 1.5 or p.x + r > half.x - GAP_M * 0.5 or p.y + r > half.y - GAP_M * 0.5:
			return false
		for s in spawns:
			if p.distance_to(s) < SPAWN_CLEAR_M * scale + r:
				return false
		for d in deposits:
			if p.distance_to(d) < r + 3.0:
				return false
		for lane in lanes:
			if _distance_to_segment(p, lane[0], lane[1]) < r + LANE_HALF_WIDTH_M:
				return false
		for a in accepted:
			for other in a["circles"]:
				if p.distance_to(other[0]) < r + other[1] + GAP_M:
					return false
		# Open ground now (not on the map's own walls and rocks).
		for k in 9:
			var probe = p if k == 8 else p + Vector2(r, 0).rotated(TAU * k / 8.0)
			var v = Vector3(probe.x, 0, probe.y)
			var closest = NavigationServer3D.map_get_closest_point(nav, v)
			if Vector2(closest.x, closest.z).distance_to(probe) > 0.05:
				return false
	return true


static func _distance_to_segment(p: Vector2, a: Vector2, b: Vector2) -> float:
	var ab = b - a
	var t = clamp((p - a).dot(ab) / max(ab.length_squared(), 0.0001), 0.0, 1.0)
	return p.distance_to(a + ab * t)


# Every item blocks movement and building: a navigation obstacle per footprint circle, carved
# into the ground's navigation mesh as Open RTS's own buildings are.
func _block(spec: Dictionary):
	for item in spec["obstacles"] + spec["structures"]:
		var a = Vector2(float(item["x"]), float(item["z"]))
		if item.has("x2"):
			var b = Vector2(float(item["x2"]), float(item["z2"]))
			var w = float(item.get("w", 2.0))
			var steps = int(ceil(a.distance_to(b) / 1.5))
			for i in steps + 1:
				_obstacle(a.lerp(b, float(i) / steps), w * 0.5 + 0.2)
		else:
			_obstacle(a, _radius(item) - 0.2)
	MatchSignals.schedule_navigation_rebake.emit(Constants.Match.Navigation.Domain.TERRAIN)


func _obstacle(at: Vector2, r: float):
	var o = NavigationObstacle3D.new()
	var verts = PackedVector3Array()
	for i in 10:
		var v = Vector2(r, 0).rotated(TAU * i / 10.0)
		verts.append(Vector3(v.x, 0, v.y))
	o.vertices = verts
	o.height = 2.0
	o.affect_navigation_mesh = true
	o.avoidance_enabled = false
	o.position = Vector3(at.x, 0, at.y)
	add_child(o)
	o.add_to_group(Constants.Match.Navigation.DOMAIN_TO_GROUP_MAPPING[Constants.Match.Navigation.Domain.TERRAIN])
