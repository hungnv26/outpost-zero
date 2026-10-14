extends Node3D

# The colonists as a crowd: simple figures with no AI of their own. Every game hour the
# colony says which lines are crewed and by how many; figures walk in straight lines to the
# front of their building, and back to the Habitat at night or when they have no shift.
# Only as many figures as colonists are awake (capped for frame rate).

const MAX_FIGURES = 72
const SPEED = 1.8
const SUIT = Color(0.9, 0.84, 0.72)
const VISOR = Color(0.18, 0.2, 0.28)

var _figures = []  # [{node, target}]
var _body_mesh: CapsuleMesh
var _head_mesh: SphereMesh
var _suit_mat: StandardMaterial3D
var _visor_mat: StandardMaterial3D
var awake = 0


func _ready():
	_body_mesh = CapsuleMesh.new()
	_body_mesh.radius = 0.16
	_body_mesh.height = 0.62
	_head_mesh = SphereMesh.new()
	_head_mesh.radius = 0.13
	_head_mesh.height = 0.26
	_suit_mat = StandardMaterial3D.new()
	_suit_mat.albedo_color = SUIT
	_suit_mat.roughness = 0.8
	_visor_mat = StandardMaterial3D.new()
	_visor_mat.albedo_color = VISOR
	_visor_mat.roughness = 0.4


func _make_figure() -> Node3D:
	var n = Node3D.new()
	var body = MeshInstance3D.new()
	body.mesh = _body_mesh
	body.material_override = _suit_mat
	body.position = Vector3(0, 0.31, 0)
	n.add_child(body)
	var head = MeshInstance3D.new()
	head.mesh = _head_mesh
	head.material_override = _visor_mat
	head.position = Vector3(0, 0.75, 0)
	n.add_child(head)
	return n


func _ensure(n: int, spawn_at: Vector3):
	while _figures.size() < n:
		var node = _make_figure()
		node.position = spawn_at + Vector3(randf() - 0.5, 0, randf() - 0.5) * 2.0
		add_child(node)
		_figures.append({"node": node, "target": node.position})
	while _figures.size() > n:
		var f = _figures.pop_back()
		f["node"].queue_free()


# `pos_of` maps a building id to its map position; `facing` is the side the camera sees.
func update(colony: Dictionary, layout: Dictionary, pos_of: Callable, facing: Vector3):
	awake = int(colony.get("colonists", {}).get("awake", 0))
	var homes = []
	var fallback = null
	for b in layout.get("buildings", []):
		if b.get("kind", "") == "habitat" and b.get("status", "built") != "building":
			homes.append(pos_of.call(b["id"]))
		elif b.get("id", "") == "landing_module":
			fallback = pos_of.call(b["id"])
	if homes.is_empty():
		homes.append(fallback if fallback != null else Vector3(22, 0, 22))
	var n = min(awake, MAX_FIGURES)
	_ensure(n, homes[0])
	var targets = []
	if colony.get("daylight", true):
		for b in colony.get("buildings", []):
			var crew = int(b.get("crew", 0))
			if crew <= 0:
				continue
			var p = pos_of.call(b["id"])
			if p == null:
				continue
			for i in crew:
				targets.append(_slot(p, facing, i, crew, 2.3))
	var k = 0
	while targets.size() < n:
		var home = homes[k % homes.size()]
		targets.append(_slot(home, facing, k / homes.size(), max(1, n - targets.size() + k), 2.4))
		k += 1
	for i in n:
		_figures[i]["target"] = targets[i]


# Slot i of n on arcs in front of a point (front row first, then a row further out).
static func _slot(pos: Vector3, facing: Vector3, i: int, n: int, base_r: float) -> Vector3:
	var r = base_r
	var idx = i
	var row_cap = max(1, int(PI * 1.1 * r / 0.7))
	while idx >= row_cap:
		idx -= row_cap
		r += 0.8
		row_cap = max(1, int(PI * 1.1 * r / 0.7))
	var j = (idx + 1) / 2 * (1 if idx % 2 == 1 else -1)
	var a = atan2(facing.z, facing.x) + j * (0.7 / r)
	return pos + Vector3(cos(a), 0, sin(a)) * r


func _process(delta):
	for f in _figures:
		var node = f["node"]
		var to = f["target"] - node.position
		to.y = 0
		var d = to.length()
		if d < 0.05:
			continue
		var step = min(d, SPEED * delta)
		node.position += to / d * step
		node.rotation.y = atan2(to.x, to.z)
