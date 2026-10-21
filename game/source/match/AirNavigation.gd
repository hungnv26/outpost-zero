extends Node3D

# air needs to be put on separate map so that air agents do not collide with terrain ones:
@onready var navigation_map_rid = NavigationServer3D.map_create()

@onready var _navigation_region = find_child("NavigationRegion3D")
@onready var _reference_static_collider_shape = find_child("CollisionShape3D")


func _ready():
	assert(_safety_checks())
	NavigationServer3D.map_set_cell_size(navigation_map_rid, Constants.Match.Air.Navmesh.CELL_SIZE)
	NavigationServer3D.map_set_cell_height(
		navigation_map_rid, Constants.Match.Air.Navmesh.CELL_HEIGHT
	)
	# Through the node, so the node itself knows its map (see bake()).
	_navigation_region.set_navigation_map(navigation_map_rid)
	# Godot 4.5+ builds region data on a background thread by default; on this separately created
	# map that build never lands, so the air map stayed empty. Build it in place instead.
	NavigationServer3D.region_set_use_async_iterations(_navigation_region.get_region_rid(), false)
	NavigationServer3D.map_force_update(navigation_map_rid)
	NavigationServer3D.map_set_active(navigation_map_rid, true)
	_reference_static_collider_shape.global_transform.origin.y = Constants.Match.Air.Y


func bake(map):
	assert(
		_navigation_region.navigation_mesh.get_polygon_count() == 0,
		"bake() should be called exactly once - during runtime"
	)
	var shape = BoxShape3D.new()
	shape.size = Vector3(map.size.x, 0, map.size.y)
	_reference_static_collider_shape.shape = shape
	_reference_static_collider_shape.global_transform.origin.x = map.size.x / 2.0
	_reference_static_collider_shape.global_transform.origin.z = map.size.y / 2.0
	_navigation_region.bake_navigation_mesh(false)
	# Outpost Zero: with the air map empty, every helicopter or drone searched up to 150 m for a free
	# spot and froze the game for seconds (see _ready). Make sure the region has the baked mesh.
	_navigation_region.navigation_mesh = _navigation_region.navigation_mesh


func _safety_checks():
	assert(
		is_equal_approx(
			_navigation_region.navigation_mesh.agent_radius,
			Constants.Match.Air.Navmesh.MAX_AGENT_RADIUS
		),
		"Navmesh 'agent_radius' must match established constant"
	)
	assert(
		is_equal_approx(
			_navigation_region.navigation_mesh.cell_size, Constants.Match.Air.Navmesh.CELL_SIZE
		),
		"Navmesh 'cell_size' must match established constant"
	)
	assert(
		is_equal_approx(
			_navigation_region.navigation_mesh.cell_height, Constants.Match.Air.Navmesh.CELL_HEIGHT
		),
		"Navmesh 'cell_height' must match established constant"
	)
	return true
