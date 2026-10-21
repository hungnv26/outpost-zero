enum { VALID, COLLIDES_WITH_AGENT, NOT_NAVIGABLE }

const MAX_SEARCH_DISTANCE_M = 150.0

static var _verdicts = {}  # debug: why positions were refused during the current search


static func find_valid_position_radially(
	starting_position: Vector3, radius: float, navigation_map_rid: RID, scene_tree
):
	return find_valid_position_radially_yet_skip_starting_radius(
		starting_position, 0.0, radius, 0.0, Vector3(0, 0, 1), true, navigation_map_rid, scene_tree
	)


static func find_valid_position_radially_yet_skip_starting_radius(
	starting_position: Vector3,
	starting_radius: float,
	radius: float,
	spacing: float,
	starting_direction: Vector3,
	shuffle: bool,
	navigation_map_rid: RID,
	scene_tree
):
	var started_us = Time.get_ticks_usec()
	_verdicts = {}
	var starting_position_yless = starting_position * Vector3(1, 0, 1)
	var units = (
		scene_tree.get_nodes_in_group("units") + scene_tree.get_nodes_in_group("resource_units")
	)
	var starting_distance = (
		0 if is_zero_approx(starting_radius) else starting_radius + radius + spacing
	)
	var starting_offset = 1 if is_zero_approx(starting_radius) else 0
	if (
		is_zero_approx(starting_radius)
		and _is_agent_placement_position_valid(
			starting_position_yless, radius, units, navigation_map_rid
		)
	):
		return starting_position_yless
	for ring_number in range(starting_offset, 999999):
		var ring_distance_from_starting_position: float = (
			starting_distance + radius * 0.5 * ring_number
		)
		# Safety net: never search past any map's size (an empty navigation map once made this
		# loop run for minutes); fall back to the starting point.
		if ring_distance_from_starting_position > MAX_SEARCH_DISTANCE_M:
			_report_slow_search(started_us, ring_number, starting_position_yless, false)
			return starting_position_yless
		var rotation_angle_rad = asin((radius + spacing) / ring_distance_from_starting_position)
		var radial_positions = []
		var next_rotation_angle_rad = 0.0
		while next_rotation_angle_rad <= PI * 2.0 - rotation_angle_rad:
			radial_positions.append(
				(
					starting_position_yless
					+ (
						starting_direction.normalized().rotated(Vector3.UP, next_rotation_angle_rad)
						* ring_distance_from_starting_position
					)
				)
			)
			next_rotation_angle_rad += rotation_angle_rad
		if shuffle:
			radial_positions.shuffle()
		for radial_position in radial_positions:
			var verdict = validate_agent_placement_position(
				radial_position, radius, units, navigation_map_rid
			)
			_verdicts[verdict] = _verdicts.get(verdict, 0) + 1
			if verdict == VALID:
				_report_slow_search(started_us, ring_number, starting_position_yless, true)
				return radial_position
	assert(false, "unexpected flow")
	return Vector3.INF


# Outpost Zero: a placement search that takes long enough to stall a frame is logged (docs/rts-arena.md).
static func _report_slow_search(started_us: int, rings: int, at: Vector3, found: bool):
	var ms = (Time.get_ticks_usec() - started_us) / 1000.0
	if ms >= 50.0:
		print("SLOW placement search: %d ms, %d rings from (%.0f, %.0f), %s; collided %d, off the navmesh %d" % [ms, rings, at.x, at.z, "found" if found else "gave up", _verdicts.get(COLLIDES_WITH_AGENT, 0), _verdicts.get(NOT_NAVIGABLE, 0)])


static func validate_agent_placement_position(position, radius, existing_units, navigation_map_rid):
	for existing_unit in existing_units:
		if (
			(existing_unit.global_position * Vector3(1, 0, 1)).distance_to(
				position * Vector3(1, 0, 1)
			)
			<= existing_unit.radius + radius
		):
			return COLLIDES_WITH_AGENT
	var points_expected_to_be_navigable = []
	for x in [-1, 0, 1]:
		for z in [-1, 0, 1]:
			points_expected_to_be_navigable.append(
				position + Vector3(x, 0, z).normalized() * radius
			)
	for point_expected_to_be_navigable in points_expected_to_be_navigable:
		if not (point_expected_to_be_navigable * Vector3(1, 0, 1)).is_equal_approx(
			(
				NavigationServer3D.map_get_closest_point(
					navigation_map_rid, point_expected_to_be_navigable
				)
				* Vector3(1, 0, 1)
			)
		):
			return NOT_NAVIGABLE
	return VALID


static func _is_agent_placement_position_valid(
	position, radius, existing_units, navigation_map_rid
):
	return (
		validate_agent_placement_position(position, radius, existing_units, navigation_map_rid)
		== VALID
	)
