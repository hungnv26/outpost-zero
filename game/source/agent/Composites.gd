extends RefCounted

# Models assembled from several Kenney parts (or Open RTS's own geometry scenes), usable
# anywhere a single model path is: Fx.fitted() accepts "composite:<name>".

const K = "res://assets/models/kenney-spacekit/"
const GEO = "res://source/match/units/structure-geometries/"

# Open RTS's own structure geometry scenes.
const SCENES = {
	"vehicle_factory": GEO + "VehicleFactory.tscn",
	"aircraft_factory": GEO + "AircraftFactory.tscn",
	"anti_ground_turret": GEO + "AntiGroundTurret.tscn",
	"anti_air_turret": GEO + "AntiAirTurret.tscn",
}


static func build(composite_name: String) -> Node3D:
	if SCENES.has(composite_name):
		return load(SCENES[composite_name]).instantiate()
	match composite_name:
		"rocket":
			return _rocket()
		"tank":
			return _tank()
		"monorail_train":
			return _train()
	var empty = Node3D.new()
	return empty


# Rocket parts stacked on their measured heights, fins at the base.
static func _rocket() -> Node3D:
	var root = Node3D.new()
	var y = 0.0
	for part in ["rocket_baseA", "rocket_fuelA", "rocket_sidesA", "rocket_fuelB", "rocket_topA"]:
		var m = load(K + part + ".glb").instantiate()
		root.add_child(m)
		var box = _aabb(m)
		if box == null:
			continue
		m.position = Vector3(-box.get_center().x, y - box.position.y, -box.get_center().z)
		y += box.size.y
	var fins = load(K + "rocket_finsA.glb").instantiate()
	root.add_child(fins)
	var fb = _aabb(fins)
	if fb != null:
		fins.position = Vector3(-fb.get_center().x, -fb.position.y, -fb.get_center().z)
	return root


# Open RTS's Tank: cargo hull with the miner rig on top (transforms from Tank.tscn).
static func _tank() -> Node3D:
	var root = Node3D.new()
	var hull = load(K + "craft_cargoB.glb").instantiate()
	hull.transform = Transform3D(Basis(), Vector3(-2, -0.107278, -1.5))
	root.add_child(hull)
	var rig = load(K + "craft_miner.glb").instantiate()
	rig.transform = Transform3D(Basis().scaled(Vector3.ONE * 0.7), Vector3(-1.4, 0.586939, -1.66923))
	root.add_child(rig)
	return root


# Monorail engine with one passenger car behind it, lined up along their long axis.
static func _train() -> Node3D:
	var root = Node3D.new()
	var offset = 0.0
	for part in ["monorail_trainFront", "monorail_trainPassenger"]:
		var m = load(K + part + ".glb").instantiate()
		root.add_child(m)
		var box = _aabb(m)
		if box == null:
			continue
		var along_x = box.size.x > box.size.z
		var length = box.size.x if along_x else box.size.z
		var c = box.get_center()
		if along_x:
			m.position = Vector3(-c.x + offset, -box.position.y, -c.z)
		else:
			m.position = Vector3(-c.x, -box.position.y, -c.z + offset)
		offset += length * 1.02
	return root


static func _aabb(root: Node3D):
	var box = null
	for mi in root.find_children("*", "MeshInstance3D", true, false):
		var rel = Transform3D.IDENTITY
		var n = mi
		while n != root:
			rel = n.transform * rel
			n = n.get_parent()
		var b = rel * mi.mesh.get_aabb()
		box = b if box == null else box.merge(b)
	return box
