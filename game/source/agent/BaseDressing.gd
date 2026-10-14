extends Node3D

# Makes the base read like a strategy-game base: a perimeter wall with gates where the
# streets leave and towers at the corners, street lamps, a department banner in every
# district, and props that suit each department (cargo and trucks in Engineering, solar
# arrays and dishes in Research, a parked ship in the Commons...). All static: no lights,
# no animation, no collision. Props keep clear of buildings, their doors (where characters
# park) and the spots, and are laid out the same way every time for the same base.

const Departments = preload("res://source/agent/Departments.gd")
const K = "res://assets/models/kaykit-spacebase/"
const N = "res://assets/models/kenney-spacekit/"
const Q = "res://assets/models/quaternius-space/"
const KK = 1.6  # KayKit native scale -> world (its buildings are fitted to 3.6)
const KN = 1.2  # Kenney
# department -> [[model path, scale]]
const PROPS = {
	"research": [[K + "solarpanel.gltf", KK], [K + "solarpanel.gltf", KK], [N + "satelliteDish.glb", KN * 1.3], [N + "machine_wireless.glb", KN * 1.3], [K + "windturbine_low.gltf", KK]],
	"code": [[K + "cargo_A_stacked.gltf", KK], [K + "cargo_B_packed.gltf", KK], [K + "spacetruck.gltf", KK * 1.2], [K + "spacetruck_large.gltf", KK * 1.2], [N + "barrels.glb", KN * 1.4], [K + "cargo_A.gltf", KK]],
	"knowledge": [[K + "cargo_A.gltf", KK], [K + "cargo_B_packed.gltf", KK], [N + "satelliteDish.glb", KN * 1.2], [K + "solarpanel.gltf", KK], [N + "barrels_rail.glb", KN * 1.4]],
	"meeting": [[Q + "Spaceship_C.glb", 0.3], [Q + "RoundRover.glb", 0.3], [K + "cargo_A_stacked.gltf", KK], [K + "landingpad_small.gltf", KK], [N + "barrels.glb", KN * 1.4]],
	"command": [[Q + "Rover_A.glb", 0.32], [K + "cargo_B_packed.gltf", KK], [N + "barrels_rail.glb", KN * 1.4]],
}
const MAX_PROPS_PER_DISTRICT = 5

var map_size = 44.0
var view_back = Vector3(0.7071, 0, 0.7071)  # ground direction towards the camera
var buildings = []  # [{pos: Vector3, dept: String}]
var spots = []  # [Vector3]
var _wall_mat: StandardMaterial3D
var _trim_mat: StandardMaterial3D
var _metal_mat: StandardMaterial3D


func build(layout: Dictionary):
	for c in get_children():
		c.queue_free()
	map_size = float(layout.get("size", map_size))
	buildings = []
	for b in layout.get("buildings", []):
		buildings.append({"pos": Vector3(b["x"], 0, b["z"]), "dept": Departments.of(b["capability"])})
	spots = []
	for s in layout.get("spots", []):
		spots.append(Vector3(s["x"], 0, s["z"]))
	_wall_mat = _mat(Color(0.78, 0.76, 0.72))
	_trim_mat = _mat(Color(0.42, 0.44, 0.48))
	_metal_mat = _mat(Color(0.3, 0.32, 0.36), 0.5)
	_build_wall()
	_build_lamps()
	_build_banners()
	_build_props(layout)


# ---- perimeter -------------------------------------------------------------

func _build_wall():
	var e = -0.6  # just outside the map, so nothing inside is ever blocked
	var f = map_size + 0.6
	var gaps = Departments.STREETS
	for side in 4:
		var horizontal = side < 2
		var fixed = e if side % 2 == 0 else f
		var cuts = [e]
		for g in gaps:
			cuts.append(g - 1.6)
			cuts.append(g + 1.6)
		cuts.append(f)
		for i in range(0, cuts.size(), 2):
			var a = cuts[i]
			var b = cuts[i + 1]
			var mid = (a + b) * 0.5
			var length = b - a
			var pos = Vector3(mid, 0, fixed) if horizontal else Vector3(fixed, 0, mid)
			_box(pos + Vector3(0, 0.4, 0), Vector3(length, 0.8, 0.32) if horizontal else Vector3(0.32, 0.8, length), _wall_mat)
			_box(pos + Vector3(0, 0.84, 0), Vector3(length, 0.08, 0.4) if horizontal else Vector3(0.4, 0.08, length), _trim_mat)
			var posts = int(length / 4.0)
			for p in range(1, posts):
				var t = a + p * length / posts
				var pp = Vector3(t, 0, fixed) if horizontal else Vector3(fixed, 0, t)
				_box(pp + Vector3(0, 0.5, 0), Vector3(0.5, 1.0, 0.5), _trim_mat)
		# Gate pillars either side of each street.
		for g in gaps:
			for d in [-1.75, 1.75]:
				var gp = Vector3(g + d, 0, fixed) if horizontal else Vector3(fixed, 0, g + d)
				_box(gp + Vector3(0, 0.75, 0), Vector3(0.6, 1.5, 0.6), _wall_mat)
				_box(gp + Vector3(0, 1.55, 0), Vector3(0.75, 0.12, 0.75), _trim_mat)
	for c in [Vector3(e, 0, e), Vector3(f, 0, e), Vector3(e, 0, f), Vector3(f, 0, f)]:
		_tower(c)


func _tower(at: Vector3):
	var body = CylinderMesh.new()
	body.top_radius = 0.95
	body.bottom_radius = 1.1
	body.height = 2.2
	body.radial_segments = 8
	_mesh(body, at + Vector3(0, 1.1, 0), _wall_mat)
	var cap = CylinderMesh.new()
	cap.top_radius = 1.2
	cap.bottom_radius = 1.2
	cap.height = 0.25
	cap.radial_segments = 8
	_mesh(cap, at + Vector3(0, 2.3, 0), _trim_mat)
	_prop(N + "satelliteDish.glb", KN * 1.1, at + Vector3(0, 2.42, 0), PI * 0.25)


# ---- streets ---------------------------------------------------------------

func _build_lamps():
	var transforms = []
	for v in Departments.STREETS:
		var t = 2.5
		while t < map_size - 1.0:
			var near_crossing = false
			for w in Departments.STREETS:
				if absf(t - w) < 2.2:
					near_crossing = true
			if not near_crossing:
				for side in [-1.05, 1.05]:
					transforms.append(Transform3D(Basis().scaled(Vector3.ONE * KK * 0.8), Vector3(v + side, 0, t)))
					transforms.append(Transform3D(Basis().scaled(Vector3.ONE * KK * 0.8), Vector3(t, 0, v + side)))
			t += 7.0
	_multimesh(K + "lights.gltf", transforms)


# ---- districts -------------------------------------------------------------

# A banner in the department's colour at the back corner of every district.
func _build_banners():
	for r in 3:
		for c in 3:
			var dept = Departments.DISTRICTS[r][c]
			var col = Departments.COLORS[dept]
			var corner = Vector3(1.0 + c * Departments.CELL + 1.1, 0, 1.0 + r * Departments.CELL + 1.1)
			_banner(corner, col)


func _banner(at: Vector3, col: Color):
	var pole = CylinderMesh.new()
	pole.top_radius = 0.05
	pole.bottom_radius = 0.06
	pole.height = 2.8
	pole.radial_segments = 6
	_mesh(pole, at + Vector3(0, 1.4, 0), _metal_mat)
	var side = Vector3(-view_back.z, 0, view_back.x)  # across the screen
	var bar = _box(at + Vector3(0, 2.7, 0) + side * 0.35, Vector3(0.8, 0.05, 0.05), _metal_mat)
	bar.rotation.y = atan2(-side.z, side.x)
	var cloth = _box(at + Vector3(0, 2.15, 0) + side * 0.4, Vector3(0.72, 1.05, 0.04), _mat(col.darkened(0.1)))
	cloth.rotation.y = atan2(-side.z, side.x)
	var stripe = _box(at + Vector3(0, 1.72, 0) + side * 0.4 + view_back * 0.025, Vector3(0.72, 0.12, 0.02), _mat(Color(0.95, 0.95, 0.95)))
	stripe.rotation.y = atan2(-side.z, side.x)
	var base = CylinderMesh.new()
	base.top_radius = 0.18
	base.bottom_radius = 0.24
	base.height = 0.2
	base.radial_segments = 6
	_mesh(base, at + Vector3(0, 0.1, 0), _trim_mat)


func _build_props(layout: Dictionary):
	var rng = RandomNumberGenerator.new()
	rng.seed = hash(JSON.stringify(layout.get("buildings", []).map(func(b): return [b["id"], b["x"], b["z"]])))
	for r in 3:
		for c in 3:
			var dept = Departments.DISTRICTS[r][c]
			var lo = Vector3(1.0 + c * Departments.CELL, 0, 1.0 + r * Departments.CELL)
			var candidates = []
			for i in range(2, 13):
				for j in range(2, 13):
					var p = lo + Vector3(i + 0.5, 0, j + 0.5)
					var score = _free_score(p)
					if score > 0.0:
						candidates.append([score + rng.randf() * 0.6, p])
			candidates.sort_custom(func(a, b): return a[0] > b[0])
			var taken = []
			for cand in candidates:
				if taken.size() >= MAX_PROPS_PER_DISTRICT:
					break
				var p = cand[1]
				if taken.any(func(q): return q.distance_to(p) < 2.2):
					continue
				taken.append(p)
				var pool = PROPS[dept]
				var pick = pool[rng.randi() % pool.size()]
				_prop(pick[0], pick[1], p, rng.randi_range(0, 3) * PI * 0.5 + rng.randf_range(-0.12, 0.12))


# How good a spot is for a prop (<= 0: not allowed). Props stay off buildings, their
# doors, the spots and the district banner, and prefer the back of buildings.
func _free_score(p: Vector3) -> float:
	var best = 0.0
	for b in buildings:
		var d = p.distance_to(b["pos"])
		if d < 2.7:
			return 0.0
		var door = b["pos"] + view_back * 2.8
		if p.distance_to(door) < 2.9:
			return 0.0
		if d < 4.2:
			best = max(best, (p - b["pos"]).normalized().dot(-view_back))  # behind it
	for s in spots:
		if p.distance_to(s) < 3.2:
			return 0.0
	return 0.5 + best


# ---- helpers ---------------------------------------------------------------

func _prop(path: String, s: float, at: Vector3, yaw: float):
	var scene = load(path)
	if scene == null:
		return
	var n = scene.instantiate()
	n.scale = Vector3.ONE * s
	n.rotation.y = yaw
	n.position = at
	add_child(n)


func _multimesh(path: String, transforms: Array):
	var scene = load(path).instantiate()
	for mi in scene.find_children("*", "MeshInstance3D", true, false):
		var rel = Transform3D.IDENTITY
		var n = mi
		while n != scene:
			rel = n.transform * rel
			n = n.get_parent()
		var mm = MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = mi.mesh
		mm.instance_count = transforms.size()
		for i in transforms.size():
			mm.set_instance_transform(i, transforms[i] * rel)
		var mmi = MultiMeshInstance3D.new()
		mmi.multimesh = mm
		add_child(mmi)
	scene.free()


func _box(pos: Vector3, extent: Vector3, mat: Material) -> MeshInstance3D:
	var b = BoxMesh.new()
	b.size = extent
	return _mesh(b, pos, mat)


func _mesh(mesh: Mesh, pos: Vector3, mat: Material) -> MeshInstance3D:
	var mi = MeshInstance3D.new()
	mi.mesh = mesh
	mi.material_override = mat
	mi.position = pos
	add_child(mi)
	return mi


static func _mat(c: Color, metallic := 0.0) -> StandardMaterial3D:
	var m = StandardMaterial3D.new()
	m.albedo_color = c
	m.roughness = 0.8
	m.metallic = metallic
	return m
