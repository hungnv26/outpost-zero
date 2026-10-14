extends NavigationObstacle3D

@export var domain = Constants.Match.Navigation.Domain.TERRAIN
@export var path_height_offset = 0.0

@onready var _match = find_parent("Match")
@onready var _unit = get_parent()


func _ready():
	await get_tree().process_frame  # wait for navigation to be operational
	set_navigation_map(_match.navigation.get_navigation_map_rid_by_domain(domain))
	_align_unit_position_to_navigation()
	_affect_navigation_if_needed()


func _exit_tree():
	if affect_navigation_mesh:
		remove_from_group(Constants.Match.Navigation.DOMAIN_TO_GROUP_MAPPING[domain])
		MatchSignals.schedule_navigation_rebake.emit(domain)


func _align_unit_position_to_navigation():
	var origin = get_parent().global_transform.origin
	var closest = NavigationServer3D.map_get_closest_point(get_navigation_map(), origin)
	# Godot 4.4+ bakes and syncs navigation asynchronously, so the map can still be empty
	# here and return (0, 0, 0). The snap is only meant to fix height, never to move the
	# unit sideways, so ignore results that would.
	if (closest * Vector3(1, 0, 1)).distance_to(origin * Vector3(1, 0, 1)) > 1.0:
		return
	_unit.global_transform.origin = closest - Vector3(0, path_height_offset, 0)


func _affect_navigation_if_needed():
	if affect_navigation_mesh:
		add_to_group(Constants.Match.Navigation.DOMAIN_TO_GROUP_MAPPING[domain])
		MatchSignals.schedule_navigation_rebake.emit(domain)
