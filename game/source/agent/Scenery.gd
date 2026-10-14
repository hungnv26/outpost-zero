extends Node3D

# Scenery around the base, per terrain: low-poly trees (built here, in the Kenney style),
# cacti, rocks, craters and crystals from the Space Kit, and water. All of it stands outside
# the playable map, so it frames the base without getting in the way: no collision, no
# navigation, no animation. Drawn with one MultiMesh per part.

const KIT = "res://assets/models/kenney-spacekit/"

# terrain -> [kind, share] and extras. Kinds: pine, snowpine, round, cactus, rock, rocklarge,
# mesa, crater, meteor, crystal.
const SETS = {
	"grassland": {"items": [["pine", 0.5], ["round", 0.35], ["rock", 0.1], ["rocklarge", 0.05]], "count": 420, "foliage": [Color(0.22, 0.42, 0.18), Color(0.3, 0.5, 0.2), Color(0.38, 0.55, 0.22)], "water": "lake"},
	"sahara": {"items": [["rock", 0.45], ["rocklarge", 0.25], ["cactus", 0.3]], "count": 160, "foliage": [Color(0.35, 0.5, 0.25)]},
	"arctic": {"items": [["snowpine", 0.65], ["rock", 0.2], ["rocklarge", 0.15]], "count": 320, "foliage": [Color(0.2, 0.33, 0.28), Color(0.25, 0.38, 0.32)]},
	"beach": {"items": [["round", 0.55], ["rock", 0.3], ["rocklarge", 0.15]], "count": 260, "foliage": [Color(0.3, 0.55, 0.22), Color(0.4, 0.62, 0.25)], "water": "sea"},
	"canyon": {"items": [["mesa", 0.25], ["rocklarge", 0.35], ["rock", 0.25], ["cactus", 0.15]], "count": 170, "foliage": [Color(0.35, 0.48, 0.25)]},
	"mars": {"items": [["rock", 0.55], ["rocklarge", 0.3], ["crater", 0.08], ["meteor", 0.07]], "count": 170},
	"moon": {"items": [["crater", 0.25], ["rock", 0.5], ["meteor", 0.25]], "count": 190},
	"venus": {"items": [["rocklarge", 0.35], ["rock", 0.4], ["meteor", 0.1], ["alientree", 0.15]], "count": 170},
	"europa": {"items": [["crystal", 0.35], ["rock", 0.35], ["crater", 0.3]], "count": 180},
	"titan": {"items": [["rock", 0.45], ["rocklarge", 0.25], ["crater", 0.12], ["alientree", 0.18]], "count": 170},
}
const ROCK_TINT = {
	"grassland": Color(0.62, 0.62, 0.6), "sahara": Color(0.85, 0.66, 0.45), "arctic": Color(0.8, 0.84, 0.9),
	"beach": Color(0.75, 0.7, 0.62), "canyon": Color(0.78, 0.45, 0.3), "mars": Color(0.56, 0.34, 0.24),
	"moon": Color(0.6, 0.6, 0.6), "venus": Color(0.55, 0.45, 0.32), "europa": Color(0.85, 0.85, 0.88), "titan": Color(0.5, 0.36, 0.22),
}

var map_size = 44.0


func build(terrain: String):
	for c in get_children():
		c.queue_free()
	var spec = SETS.get(terrain, SETS["mars"])
	var rng = RandomNumberGenerator.new()
	rng.seed = hash(terrain)
	var placements = {}  # kind -> [Transform3D]
	var items = spec["items"]
	var placed = 0
	var tries = 0
	var target = int(spec["count"] * 2.2)  # the land past the base is bigger now
	while placed < target and tries < target * 20:
		tries += 1
		var p = Vector3(rng.randf_range(-52, map_size + 52), 0, rng.randf_range(-52, map_size + 52))
		var out = _outside(p)
		if out < 0.8:
			continue
		# Denser near the base, thinning out further away.
		if rng.randf() > clampf(1.15 - out / 40.0, 0.25, 1.0):
			continue
		if spec.get("water", "") != "" and _in_water(spec["water"], p, 1.5):
			continue
		if _on_approach_road(p):
			continue
		var kind = _pick(items, rng.randf())
		var s = rng.randf_range(0.75, 1.35)
		if kind == "mesa":
			s = rng.randf_range(3.0, 5.5)
		elif kind == "rocklarge":
			s = rng.randf_range(1.2, 2.4)
		elif kind == "crater":
			s = rng.randf_range(1.5, 3.5)
		elif kind == "alientree":
			s = rng.randf_range(0.3, 0.5)  # the Quaternius trees are big at scale 1
		var t = Transform3D(Basis(Vector3.UP, rng.randf() * TAU).scaled(Vector3.ONE * s), p)
		if not placements.has(kind):
			placements[kind] = []
		placements[kind].append(t)
		placed += 1
	var foliage = spec.get("foliage", [Color(0.3, 0.5, 0.2)])
	var rock_tint = ROCK_TINT.get(terrain, Color(0.6, 0.6, 0.6))
	for kind in placements:
		for part in _parts(kind, foliage, rock_tint):
			_multimesh(part[0], part[1], placements[kind], part[2] if part.size() > 2 else Transform3D.IDENTITY)
	_water_kind = spec.get("water", "")
	if _water_kind != "":
		_water(_water_kind)


# How far outside the map a point is (0 inside).
func _outside(p: Vector3) -> float:
	var dx = max(0.0, max(-p.x, p.x - map_size))
	var dz = max(0.0, max(-p.z, p.z - map_size))
	return Vector2(dx, dz).length()


# The dirt roads that leave the base through its gates (WorldDecor) stay clear.
func _on_approach_road(p: Vector3) -> bool:
	for v in [15.0, 29.0]:
		if absf(p.x - v) < 2.2 and (p.z < 0.0 or p.z > map_size):
			return true
		if absf(p.z - v) < 2.2 and (p.x < 0.0 or p.x > map_size):
			return true
	return false


static func _pick(items: Array, r: float) -> String:
	var acc = 0.0
	for it in items:
		acc += it[1]
		if r <= acc:
			return it[0]
	return items[items.size() - 1][0]


# Each kind is one or more [mesh, material, local transform] parts sharing placements.
func _parts(kind: String, foliage: Array, rock_tint: Color) -> Array:
	var bark = _mat(Color(0.36, 0.25, 0.17))
	match kind:
		"pine", "snowpine":
			var out = [[_cyl(0.1, 0.13, 0.7, 6), bark, Transform3D(Basis(), Vector3(0, 0.35, 0))]]
			var green = _mat(foliage[0])
			var tiers = [[0.85, 1.1, 0.75], [0.65, 0.95, 1.35], [0.42, 0.8, 1.9]]
			for i in tiers.size():
				var tr = tiers[i]
				var m = green if not (kind == "snowpine" and i == 2) else _mat(Color(0.93, 0.95, 0.98))
				out.append([_cyl(0.0, tr[0], tr[1], 7), m, Transform3D(Basis(), Vector3(0, tr[2], 0))])
			if kind == "snowpine":
				out.append([_cyl(0.0, 0.5, 0.35, 7), _mat(Color(0.93, 0.95, 0.98)), Transform3D(Basis(), Vector3(0, 1.62, 0))])
			return out
		"round":
			var out2 = [[_cyl(0.1, 0.14, 0.9, 6), bark, Transform3D(Basis(), Vector3(0, 0.45, 0))]]
			out2.append([_sphere(0.75, 1.3), _mat(foliage[1 % foliage.size()]), Transform3D(Basis(), Vector3(0, 1.35, 0))])
			out2.append([_sphere(0.5, 0.9), _mat(foliage[foliage.size() - 1]), Transform3D(Basis(), Vector3(0.35, 1.75, 0.15))])
			return out2
		"cactus":
			var c = _mat(foliage[0])
			return [
				[_capsule(0.16, 1.3), c, Transform3D(Basis(), Vector3(0, 0.65, 0))],
				[_capsule(0.1, 0.55), c, Transform3D(Basis(), Vector3(0.24, 0.85, 0))],
				[_capsule(0.1, 0.45), c, Transform3D(Basis(), Vector3(-0.22, 0.7, 0))],
			]
		"mesa":
			return [[_cyl(0.75, 1.0, 0.9, 7), _mat(rock_tint), Transform3D(Basis(), Vector3(0, 0.45, 0))]]
		"rock":
			return _kit("rocks_smallA", rock_tint)
		"rocklarge":
			return _kit("rock_largeA", rock_tint)
		"crater":
			return _kit("crater", rock_tint.darkened(0.3))
		"meteor":
			return _kit("meteor_half", rock_tint)
		"crystal":
			return _kit("rock_crystals", Color(0, 0, 0, 0))
		"alientree":
			return _kit("res://assets/models/quaternius-space/TreeSpiral_A.glb", Color(0, 0, 0, 0))
	return []


# A Space Kit model's meshes, recoloured to the terrain's rock colour (tint alpha 0 keeps it).
func _kit(model: String, tint: Color) -> Array:
	var scene = load(model if model.begins_with("res://") else KIT + model + ".glb").instantiate()
	var out = []
	for mi in scene.find_children("*", "MeshInstance3D", true, false):
		var rel = Transform3D.IDENTITY
		var n = mi
		while n != scene:
			rel = n.transform * rel
			n = n.get_parent()
		var mat = null
		if tint.a > 0.0:
			mat = _mat(tint)
		out.append([mi.mesh, mat, rel])
	scene.free()
	return out


func _multimesh(mesh: Mesh, mat: Material, transforms: Array, local: Transform3D):
	var mm = MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = mesh
	mm.instance_count = transforms.size()
	for i in transforms.size():
		mm.set_instance_transform(i, transforms[i] * local)
	var mmi = MultiMeshInstance3D.new()
	mmi.multimesh = mm
	if mat != null:
		mmi.material_override = mat
	mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	add_child(mmi)


var _water_kind = ""


func is_water(p: Vector3) -> bool:
	return _water_kind != "" and _in_water(_water_kind, p, 2.0)


func _in_water(kind: String, p: Vector3, margin: float) -> bool:
	match kind:
		"lake":
			return Vector2(p.x - (-16.0), p.z - 30.0).length() < 13.0 + margin
		"sea":
			return p.z > map_size + 9.0 - margin
	return false


func _water(kind: String):
	var mat = StandardMaterial3D.new()
	mat.albedo_color = Color(0.16, 0.42, 0.55, 0.92)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.metallic = 0.15
	mat.roughness = 0.08
	mat.rim_enabled = true
	mat.rim = 0.4
	mat.render_priority = -20  # before the shroud, so unexplored water darkens too
	var mi = MeshInstance3D.new()
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	match kind:
		"lake":
			var c = CylinderMesh.new()
			c.top_radius = 13.0
			c.bottom_radius = 13.0
			c.height = 0.02
			c.radial_segments = 40
			mi.mesh = c
			mi.position = Vector3(-16.0, 0.03, 30.0)
			add_child(_shore(Vector3(-16.0, 0.02, 30.0), 14.2))
		"sea":
			var pl = PlaneMesh.new()
			pl.size = Vector2(240, 80)
			mi.mesh = pl
			mi.position = Vector3(map_size * 0.5, 0.03, map_size + 9.0 + 40.0)
	add_child(mi)


# A pale sandy ring under the lake's edge.
func _shore(at: Vector3, r: float) -> MeshInstance3D:
	var c = CylinderMesh.new()
	c.top_radius = r
	c.bottom_radius = r
	c.height = 0.02
	c.radial_segments = 40
	var mi = MeshInstance3D.new()
	mi.mesh = c
	mi.material_override = _mat(Color(0.72, 0.66, 0.5))
	mi.position = at
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi


static func _mat(c: Color) -> StandardMaterial3D:
	var m = StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = 0.9
	return m


static func _cyl(top: float, bottom: float, h: float, sides: int) -> CylinderMesh:
	var c = CylinderMesh.new()
	c.top_radius = top
	c.bottom_radius = bottom
	c.height = h
	c.radial_segments = sides
	c.rings = 1
	return c


static func _sphere(r: float, h: float) -> SphereMesh:
	var s = SphereMesh.new()
	s.radius = r
	s.height = h
	s.radial_segments = 8
	s.rings = 4
	return s


static func _capsule(r: float, h: float) -> CapsuleMesh:
	var c = CapsuleMesh.new()
	c.radius = r
	c.height = h
	c.radial_segments = 8
	c.rings = 2
	return c
