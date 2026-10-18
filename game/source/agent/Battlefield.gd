extends Node3D

# A match's battlefield (design/maps.json battlefields, sent by the adapter in the arena info):
# structures and obstacles in the wild between the bases. Static scenery, like Scenery.gd: no
# collision, no navigation, no animation. Items are in match-world units (base A's corner at
# 0,0); `origin` is this window's base on that map, so everything is drawn relative to it.

const Fx = preload("res://source/agent/Fx.gd")
const KIT = "res://assets/models/kenney-spacekit/"
const ROCK_TINT = preload("res://source/agent/Scenery.gd").ROCK_TINT
const LIQUID = {
	"water": [Color(0.16, 0.34, 0.46), 0.15],
	"ice": [Color(0.55, 0.74, 0.88), 0.2],
	"lava": [Color(0.62, 0.24, 0.08), 0.6],
	"methane": [Color(0.2, 0.15, 0.1), 0.1],
}

var origin = Vector3.ZERO
var terrain = "mars"
var _id = ""


# Builds the battlefield once per id; an empty spec clears it.
func set_battlefield(spec: Dictionary, my_origin: Vector3) -> bool:
	var id = str(spec.get("id", ""))
	if id == _id and my_origin == origin:
		return false
	_id = id
	origin = my_origin
	terrain = str(spec.get("terrain", "mars"))
	for c in get_children():
		c.queue_free()
	if id == "":
		return true
	var rng = RandomNumberGenerator.new()
	rng.seed = hash(id)
	for item in spec.get("obstacles", []):
		_obstacle(item, rng)
	for item in spec.get("structures", []):
		_structure(item, rng)
	return true


# Rect2s (window xz) the items cover, so Scenery keeps its props off them.
func footprints(spec: Dictionary, my_origin: Vector3) -> Array:
	var out = []
	for item in spec.get("obstacles", []) + spec.get("structures", []):
		var a = _at(item, "x", "z", my_origin)
		var r = float(item.get("r", float(item.get("size", 6.0)) * 0.5)) + 1.5
		if item.has("x2"):
			var b = _at(item, "x2", "z2", my_origin)
			var lo = Vector2(min(a.x, b.x), min(a.z, b.z)) - Vector2(3, 3)
			out.append(Rect2(lo, Vector2(absf(a.x - b.x), absf(a.z - b.z)) + Vector2(6, 6)))
		else:
			out.append(Rect2(a.x - r, a.z - r, 2 * r, 2 * r))
	return out


static func _at(item: Dictionary, kx: String, kz: String, o: Vector3) -> Vector3:
	return Vector3(float(item.get(kx, 0.0)), 0, float(item.get(kz, 0.0))) - o


func _structure(item: Dictionary, rng: RandomNumberGenerator):
	var p = _at(item, "x", "z", origin)
	var yaw = deg_to_rad(float(item.get("rot", 0.0)))
	var size = float(item.get("size", 6.0))
	match str(item.get("kind", "")):
		"wreck":
			# A crashed craft: tilted, half buried.
			var w = _model(["craft_cargoA", "craft_cargoB"][rng.randi() % 2], size, p, yaw)
			w.rotate_object_local(Vector3.FORWARD, deg_to_rad(rng.randf_range(10, 22)))
			w.position.y -= 0.35
			_scatter(["rocks_smallA", "rocks_smallB", "barrel"], p, size * 0.7, 5, 0.8, 1.4, rng)
		"wreckLarge":
			var m = _model("craft_miner", size, p, yaw)
			m.rotate_object_local(Vector3.RIGHT, deg_to_rad(rng.randf_range(-14, -8)))
			m.position.y -= 0.5
			_scatter(["rocks_smallA", "meteor_half", "barrels"], p, size * 0.8, 7, 0.9, 1.6, rng)
		"relay":
			_model("satelliteDish_large", size * 0.7, p, yaw)
			_model("machine_wireless", size * 0.25, p + Vector3(size * 0.4, 0, 0).rotated(Vector3.UP, yaw), yaw)
		"ruins":
			# Old stone-coloured blocks nobody on Earth built: a ring of walls around a core.
			var tint = ROCK_TINT.get(terrain, Color(0.6, 0.6, 0.6)).darkened(0.1)
			_model("structure_detailed", size * 0.5, p, yaw, tint)
			for i in 9:
				var a = yaw + TAU * i / 9.0 + rng.randf_range(-0.15, 0.15)
				var at = p + Vector3(size * 0.55, 0, 0).rotated(Vector3.UP, a)
				var piece = _model(["corridor_wall", "structure", "corridor_wallCorner"][rng.randi() % 3], size * rng.randf_range(0.26, 0.36), at, a + PI / 2, tint)
				if rng.randf() < 0.4:
					piece.rotate_object_local(Vector3.RIGHT, deg_to_rad(rng.randf_range(8, 25)))
		"hangar":
			_model("hangar_roundA", size, p, yaw)
			_scatter(["barrels", "machine_barrel"], p, size * 0.75, 3, 0.8, 1.2, rng)
		"rocket":
			# An abandoned launch stand.
			var n = Fx.fitted("composite:rocket", size * 0.6, 0.0, size * 1.6)
			n.position = p
			n.rotation.y = yaw
			add_child(n)
			_model("platform_large", size, p - Vector3(0, 0.05, 0), yaw)
		"turret":
			_model("turret_double", size * 0.8, p, yaw)
			_model("platform_small", size, p - Vector3(0, 0.05, 0), yaw)
		"generator":
			_model("machine_generatorLarge", size * 0.7, p, yaw)
			_scatter(["machine_barrelLarge", "pipe_end"], p, size * 0.6, 3, 0.8, 1.2, rng)
		"monorail":
			var b = _at(item, "x2", "z2", origin)
			_line(["monorail_trackStraight"], p, b, 2.0, 2.0, 1.0, 0.0, rng, Color(0, 0, 0, 0), 1.0)
			_line(["monorail_trackSupport"], p, b, 4.0, 0.4, 1.0, 0.0, rng, Color(0, 0, 0, 0), 0.0)
		"pipeline":
			var b2 = _at(item, "x2", "z2", origin)
			_line(["pipe_straight"], p, b2, 2.6, 2.6, 1.0, 0.0, rng, Color(0, 0, 0, 0), 0.0)


func _obstacle(item: Dictionary, rng: RandomNumberGenerator):
	var p = _at(item, "x", "z", origin)
	var r = float(item.get("r", 4.0))
	var tint = ROCK_TINT.get(terrain, Color(0.6, 0.6, 0.6))
	match str(item.get("kind", "")):
		"ridge":
			var b = _at(item, "x2", "z2", origin)
			var w = float(item.get("w", 3.0))
			_line(["rock_largeA", "rock_largeB"], p, b, 1.5, rng.randf_range(2.0, 3.0), 1.6, w * 0.5, rng, tint, 0.0)
		"chasm":
			# A rift: a dark cut in the ground with broken rock along both lips.
			var b = _at(item, "x2", "z2", origin)
			var w = float(item.get("w", 3.0))
			var d = b - p
			var cut = MeshInstance3D.new()
			var box = BoxMesh.new()
			box.size = Vector3(w, 0.04, d.length())
			cut.mesh = box
			cut.material_override = _mat(tint.darkened(0.82), 0.95)
			cut.position = (p + b) * 0.5 + Vector3(0, 0.03, 0)
			cut.rotation.y = atan2(d.x, d.z)
			add_child(cut)
			var side = Vector3(d.z, 0, -d.x).normalized() * (w * 0.5 + 0.4)
			_line(["rocks_smallA", "rocks_smallB", "rock"], p + side, b + side, 1.2, 1.3, 1.5, 0.3, rng, tint.darkened(0.15), 0.0)
			_line(["rocks_smallA", "rocks_smallB", "rock"], p - side, b - side, 1.2, 1.3, 1.5, 0.3, rng, tint.darkened(0.15), 0.0)
		"crater":
			var n = _model("craterLarge", 2.0 * r, p, rng.randf() * TAU, tint)
			n.position.y = -0.05
		"lake":
			var spec = LIQUID.get(str(item.get("liquid", "water")), LIQUID["water"])
			var shore = _disc(r + 0.9, tint.darkened(0.25), 0.9)
			shore.position = p + Vector3(0, 0.025, 0)
			var lake = _disc(r, spec[0], 1.0 - spec[1])
			lake.position = p + Vector3(0, 0.05, 0)
			lake.scale = Vector3(1.0, 1.0, rng.randf_range(0.75, 1.0))
			shore.scale = lake.scale
		"mesa":
			var h = float(item.get("h", 5.0))
			var m = MeshInstance3D.new()
			var cyl = CylinderMesh.new()
			cyl.top_radius = r * 0.78
			cyl.bottom_radius = r
			cyl.height = h
			cyl.radial_segments = 9
			cyl.rings = 1
			m.mesh = cyl
			m.material_override = _mat(tint, 0.95)
			m.position = p + Vector3(0, h * 0.5, 0)
			m.rotation.y = rng.randf() * TAU
			add_child(m)
			_scatter(["rock_largeA", "rock_largeB"], p, r + 1.2, 6, 1.2, 2.2, rng, tint)
		"crystals":
			_scatter(["rock_crystalsLargeA", "rock_crystalsLargeB", "rock_crystals"], p, r, 9, 1.6, 3.6, rng)
		"meteors":
			_scatter(["meteor_detailed", "meteor", "meteor_half"], p, r, 7, 1.2, 2.6, rng, tint)
			_scatter(["crater"], p, r, 4, 2.0, 3.5, rng, tint)


# One kit model fitted to `size`, at p, turned by yaw; a tint with alpha 0 keeps its colours.
func _model(model: String, size: float, p: Vector3, yaw: float, tint := Color(0, 0, 0, 0)) -> Node3D:
	var n = Fx.fitted(KIT + model + ".glb", size)
	n.position = p
	n.rotation.y = yaw
	if tint.a > 0.0:
		var m = _mat(tint, 0.95)
		for mi in n.find_children("*", "MeshInstance3D", true, false):
			mi.material_override = m
	add_child(n)
	return n


# Models scattered within `radius` of p.
func _scatter(models: Array, p: Vector3, radius: float, count: int, smin: float, smax: float, rng: RandomNumberGenerator, tint := Color(0, 0, 0, 0)):
	for i in count:
		var at = p + Vector3(sqrt(rng.randf()) * radius, 0, 0).rotated(Vector3.UP, rng.randf() * TAU)
		_model(models[rng.randi() % models.size()], rng.randf_range(smin, smax), at, rng.randf() * TAU, tint)


# Models along the segment a..b every `step`, each `size` across; `jitter` sideways, `lift` up.
func _line(models: Array, a: Vector3, b: Vector3, step: float, size: float, size_var: float, jitter: float, rng: RandomNumberGenerator, tint: Color, lift: float):
	var d = b - a
	var n = max(1, int(d.length() / step))
	var yaw = atan2(d.x, d.z)
	var side = Vector3(d.z, 0, -d.x).normalized()
	for i in n + 1:
		var at = a + d * (float(i) / n) + side * rng.randf_range(-jitter, jitter) + Vector3(0, lift, 0)
		var s = size * (rng.randf_range(1.0, size_var) if size_var > 1.0 else 1.0)
		var rot = yaw if jitter == 0.0 else rng.randf() * TAU
		_model(models[rng.randi() % models.size()], s, at, rot, tint)


func _disc(radius: float, color: Color, roughness: float) -> MeshInstance3D:
	var m = MeshInstance3D.new()
	var cyl = CylinderMesh.new()
	cyl.top_radius = radius
	cyl.bottom_radius = radius
	cyl.height = 0.04
	cyl.radial_segments = 40
	cyl.rings = 1
	m.mesh = cyl
	m.material_override = _mat(color, roughness)
	m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(m)
	return m


static func _mat(c: Color, roughness: float) -> StandardMaterial3D:
	var m = StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = roughness
	return m
