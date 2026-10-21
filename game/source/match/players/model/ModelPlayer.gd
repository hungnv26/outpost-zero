extends "res://source/match/players/Player.gd"

# A player commanded by an AI model (docs/rts-arena.md). The model never steers single units: the
# battle service asks this node what its side can see (observe) and hands it orders (execute),
# which it carries out with Open RTS's own actions, checked the way a human click would be.
#
# Standing behaviour, so a model that is thinking (or out of budget) is not helpless:
# - workers with nothing to do gather (the resource the model last chose for them, else the
#   scarcer one), and a structure left unfinished gets the nearest worker;
# - combat units with nothing to do fight anything in range (Open RTS's own idle behaviour);
# - an attack order is an attack-move: units head for the target and fight what they meet.
# A side with no buildings left is out of the battle.
# Fog is honest: enemies show only while one of this side's units can see them, enemy buildings
# are remembered where they were last seen, deposits once they have been seen.

const Structure = preload("res://source/match/units/Structure.gd")
const Worker = preload("res://source/match/units/Worker.gd")
const CommandCenter = preload("res://source/match/units/CommandCenter.gd")
const ResourceUnit = preload("res://source/match/units/non-player/ResourceUnit.gd")
const Moving = preload("res://source/match/units/actions/Moving.gd")
const MovingToUnit = preload("res://source/match/units/actions/MovingToUnit.gd")
const AutoAttacking = preload("res://source/match/units/actions/AutoAttacking.gd")
const Constructing = preload("res://source/match/units/actions/Constructing.gd")
const CollectingResourcesSequentially = preload(
	"res://source/match/units/actions/CollectingResourcesSequentially.gd"
)

const COLOR_NAMES = ["blue", "red", "green", "purple", "darkgreen", "khaki", "navy", "turquoise"]
const UNIT_SCENES = {
	"worker": "res://source/match/units/Worker.tscn",
	"tank": "res://source/match/units/Tank.tscn",
	"helicopter": "res://source/match/units/Helicopter.tscn",
	"drone": "res://source/match/units/Drone.tscn",
}
const PRODUCERS = {
	"worker": "CommandCenter",
	"tank": "VehicleFactory",
	"helicopter": "AircraftFactory",
	"drone": "AircraftFactory",
}
const STRUCTURE_SCENES = {
	"command_center": "res://source/match/units/CommandCenter.tscn",
	"vehicle_factory": "res://source/match/units/VehicleFactory.tscn",
	"aircraft_factory": "res://source/match/units/AircraftFactory.tscn",
	"ground_turret": "res://source/match/units/AntiGroundTurret.tscn",
	"air_turret": "res://source/match/units/AntiAirTurret.tscn",
}
const TYPE_NAMES = {
	"Worker": "worker",
	"Tank": "tank",
	"Helicopter": "helicopter",
	"Drone": "drone",
	"CommandCenter": "command_center",
	"VehicleFactory": "vehicle_factory",
	"AircraftFactory": "aircraft_factory",
	"AntiGroundTurret": "ground_turret",
	"AntiAirTurret": "air_turret",
}
# Ids never look like grid cells (A1-J10): no prefix is a single letter from A to J.
const ID_PREFIX = {
	"worker": "w",
	"tank": "t",
	"helicopter": "hc",
	"drone": "dr",
	"command_center": "cc",
	"vehicle_factory": "vf",
	"aircraft_factory": "af",
	"ground_turret": "gt",
	"air_turret": "at",
}
const GRID = 10  # cells per side: columns A-J west to east, rows 1-10 north to south
const TICK_S = 0.5
const ENGAGE_RADIUS_M = 10.0
const WORKERS_PER_DEPOSIT = 3
const REASSIGN_COOLDOWN_S = 20.0
const MAX_PLANS = 3
const DEPOSIT_REACH_M = 16.0
const MAX_BUILD_DRIFT_M = 16.0  # how far from the asked-for place a building may land (never past the enemy side check)

var color_name = ""

var _ids = {}  # instance id -> short id ("t3"), own units, enemies ("x12") and deposits ("ra4")
var _units_by_id = {}
var _counters = {}
var _seen_buildings = {}  # instance id -> {player, type, cell, x, z, at}
var _seen_deposits = {}  # instance id -> true
var _attack_targets = {}  # own unit instance id -> {"pos": Vector3, "unit": target or null}
var _gather_choice = {}  # worker instance id -> "a" or "b"
var _moved_at = {}  # worker instance id -> game time it was last moved to another resource
var _time = 0.0
var _tick_left = TICK_S
var _ready_done = false
var _plans = []  # builds ordered before they were affordable: [{structure, near}], started in order
var _plan_news = []  # what happened to planned builds since the last observation
var _income = []  # [game time, resource, amount] for every delivery in the last minute
var _last_a = 0
var _last_b = 0

@onready var _match = find_parent("Match")


func _ready():
	if not _match.is_node_ready():
		await _match.ready
	await get_tree().physics_frame
	var index = get_index()
	color_name = COLOR_NAMES[index] if index < COLOR_NAMES.size() else "player%d" % index
	_last_a = resource_a
	_last_b = resource_b
	changed.connect(_on_resources_changed)
	_ready_done = true


# Income: every rise in a resource is a delivery (spending only lowers them).
func _on_resources_changed():
	if resource_a > _last_a:
		_income.append([_time, "a", resource_a - _last_a])
	if resource_b > _last_b:
		_income.append([_time, "b", resource_b - _last_b])
	_last_a = resource_a
	_last_b = resource_b


func _process(delta):
	if not _ready_done:
		return
	_time += delta
	_tick_left -= delta
	if _tick_left > 0.0:
		return
	_tick_left = TICK_S
	var started_us = Time.get_ticks_usec()
	_remember_what_is_seen()
	_keep_workers_busy()
	_finish_unfinished_structures()
	_carry_out_attacks()
	_start_planned_builds()
	_report_slow("standing orders", started_us)


# ---- observation ----


func observe() -> Dictionary:
	var started_us = Time.get_ticks_usec()
	var result = _observe()
	_report_slow("observe", started_us)
	return result


func _observe() -> Dictionary:
	var own = _own_units()
	if not own.any(func(u): return u is Structure):
		return {"eliminated": true, "you": color_name}
	var units = []
	var buildings = []
	for unit in own:
		var type = _type(unit)
		if unit is Structure:
			var entry = {"id": _id(unit), "type": type, "hp": _hp(unit), "cell": _cell(unit.global_position)}
			if not unit.is_constructed():
				entry["built"] = "%d%%" % int(unit._construction_progress * 100.0)
			var queue = unit.find_child("ProductionQueue")
			if queue != null and queue.size() > 0:
				entry["training"] = queue.get_elements().map(
					func(e): return TYPE_NAMES.get(_scene_type(e.unit_prototype.resource_path), "?")
				)
			buildings.append(entry)
		else:
			units.append(
				{"id": _id(unit), "type": type, "hp": _hp(unit), "cell": _cell(unit.global_position), "doing": _doing(unit)}
			)
	var enemies = []
	for unit in _visible_enemies():
		enemies.append(
			{
				"id": _id(unit),
				"player": _player_name(unit.player),
				"type": _type(unit),
				"hp": _hp(unit),
				"cell": _cell(unit.global_position),
			}
		)
	var last_seen = []
	for key in _seen_buildings:
		var b = _seen_buildings[key]
		if instance_from_id(key) != null and _is_visible(instance_from_id(key)):
			continue  # in sight right now: listed with the enemies
		last_seen.append(
			{"player": b["player"], "type": b["type"], "cell": b["cell"], "seen_s_ago": int(_time - b["at"])}
		)
	var deposits = []
	for key in _seen_deposits.keys():
		var d = instance_from_id(key)
		if d == null or not is_instance_valid(d):
			_seen_deposits.erase(key)
			continue
		var kind = "a" if "resource_a" in d else "b"
		deposits.append(
			{"id": _id(d), "resource": kind, "left": int(d.get("resource_" + kind)), "cell": _cell(d.global_position)}
		)
	var starts = {}
	var alive = []
	for p in get_tree().get_nodes_in_group("players"):
		starts[_player_name(p)] = _cell(_spawn_position(p))
		if p != self and _units_of(p).any(func(u): return u is Structure):
			alive.append(_player_name(p))
	return {
		"you": color_name,
		"game_time_s": int(_time),
		"resources": {"a": resource_a, "b": resource_b},
		"economy": _economy(),
		"planned_builds": _plans.map(func(p): return p["structure"]),
		"planned_build_news": _take_plan_news(),
		"map": "%dx%d m, grid columns A-J (west to east) and rows 1-10 (north to south), cells %.1f x %.1f m" % [_map_size().x, _map_size().y, _map_size().x / GRID, _map_size().y / GRID],
		"start_positions": starts,
		"enemies_alive": alive,
		"my_units": units,
		"my_buildings": buildings,
		"enemies_in_sight": enemies,
		"enemy_buildings_last_seen": last_seen,
		"deposits_seen": deposits,
	}


# ---- orders ----


func execute(order: Dictionary) -> Dictionary:
	var started_us = Time.get_ticks_usec()
	var result = _execute(order)
	_report_slow("order %s" % order.get("order", "?"), started_us)
	return result


func _report_slow(what: String, started_us: int):
	var ms = (Time.get_ticks_usec() - started_us) / 1000.0
	if ms >= 50.0:
		print("SLOW %s %s: %d ms (%d units on the map)" % [color_name, what, ms, get_tree().get_nodes_in_group("units").size()])


func _execute(order: Dictionary) -> Dictionary:
	if not _own_units().any(func(u): return u is Structure):
		return _refuse("you have been eliminated")
	var kind = str(order.get("order", ""))
	match kind:
		"build":
			return _build(str(order.get("structure", "")), str(order.get("near", "base")))
		"train":
			return _train(str(order.get("unit", "")), int(order.get("count", 1)))
		"gather":
			return _gather(str(order.get("resource", "")), order.get("workers", "all"))
		"attack":
			return _attack(order.get("units", "army"), str(order.get("target", "")))
		"move":
			return _move(order.get("units", "army"), str(order.get("to", "")))
		"scout":
			return _move(order.get("units", "drones"), str(order.get("to", "")))
	return _refuse("unknown order %s (build, train, gather, attack, move, scout)" % kind)


func _build(structure: String, near: String, from_plan := false) -> Dictionary:
	if not STRUCTURE_SCENES.has(structure):
		return _refuse("unknown structure %s (%s)" % [structure, ", ".join(STRUCTURE_SCENES.keys())])
	var path = STRUCTURE_SCENES[structure]
	var cost = Constants.Match.Units.CONSTRUCTION_COSTS[path]
	# Not affordable yet: plan it. Its cost is set aside from then on (worker training cannot spend
	# it) and it starts as soon as the resources are there, so it needs ordering only once.
	if not from_plan and not _has_after_plans(cost):
		if _plans.any(func(p): return p["structure"] == structure):
			return _ok("%s is already planned; it starts when you have %s (you have a %d, b %d)" % [structure, _cost_text(cost), resource_a, resource_b])
		if _plans.size() >= MAX_PLANS:
			return _refuse("%s costs %s; you have a %d, b %d, and %d builds are already planned" % [structure, _cost_text(cost), resource_a, resource_b, _plans.size()])
		_plans.append({"structure": structure, "near": near})
		return _ok("%s planned: it starts by itself when you have %s (you have a %d, b %d); resources for it are set aside" % [structure, _cost_text(cost), resource_a, resource_b])
	var workers = _own_units().filter(func(u): return u is Worker)
	if workers.is_empty():
		return _refuse("no workers to build with")
	var place = _place(near if near != "" else "base")
	if place == null:
		return _refuse("unknown place %s (base, center, a cell like D4, a start position colour or an id)" % near)
	var unit_to_spawn = load(path).instantiate()
	var nav = _match.navigation.get_navigation_map_rid_by_domain(unit_to_spawn.movement_domain)
	var blockers = _build_blockers()
	var position = _find_build_spot(place, unit_to_spawn.radius + Constants.Match.Units.EMPTY_SPACE_RADIUS_SURROUNDING_STRUCTURE_M, blockers, nav)
	# The search stops MAX_BUILD_DRIFT_M from the place asked for (Open RTS's own search went as far as
	# it had to, and once put a red turret on blue's side). Nowhere free: refuse, nothing spent.
	if position == null:
		unit_to_spawn.free()
		return _refuse(
			"no free spot for %s within %d m of %s; pick another place" % [structure, int(MAX_BUILD_DRIFT_M), _cell(place)]
		)
	# Never on the enemy's side: nearer any enemy's start than this side's base.
	var home = _base_position() * Vector3(1, 0, 1)
	for p in get_tree().get_nodes_in_group("players"):
		if p != self and _units_of(p).any(func(u): return u is Structure):
			if (_spawn_position(p) * Vector3(1, 0, 1)).distance_to(position * Vector3(1, 0, 1)) < home.distance_to(position * Vector3(1, 0, 1)):
				unit_to_spawn.free()
				return _refuse("%s near %s would stand on the enemy's side (%s); pick a place nearer your base" % [structure, _cell(place), _cell(position)])
	var target_transform = Transform3D(Basis(), position).looking_at(
		position + Vector3(0, 0, 1), Vector3.UP
	)
	subtract_resources(cost)
	_clear_footprint(position, unit_to_spawn.radius + 1.5)
	MatchSignals.setup_and_spawn_unit.emit(unit_to_spawn, target_transform, self)
	var builder = _closest(workers.filter(func(w): return not (w.action is Constructing)), position)
	if builder == null:
		builder = _closest(workers, position)
	builder.action = Constructing.new(unit_to_spawn)
	return _ok(
		"%s %s placed at %s; %s is building it" % [structure, _id(unit_to_spawn), _cell(position), _id(builder)]
	)


# What a new building may not overlap: every building, deposit and enemy unit. This side's own
# workers and fighters step aside instead (_clear_footprint): with a busy base they otherwise
# filled every spot near home, and builds landed 20 m away.
func _build_blockers() -> Array:
	var out = get_tree().get_nodes_in_group("resource_units").duplicate()
	for u in get_tree().get_nodes_in_group("units"):
		if u is Structure or u.player != self:
			out.append(u)
	return out


# The free spot nearest `place` within MAX_BUILD_DRIFT_M, or null. Each ring is searched from the
# side facing away from the map's centre, alternating either way round, and between two mirror-image
# spots the northern one first: so mirrored bases fill up the same way (a search starting due east
# went toward the middle for one side and into the map's edge for the other).
func _find_build_spot(place: Vector3, radius: float, blockers: Array, nav: RID):
	var at = place * Vector3(1, 0, 1)
	var valid = Utils.Match.Unit.Placement.VALID
	if Utils.Match.Unit.Placement.validate_agent_placement_position(at, radius, blockers, nav) == valid:
		return at
	var center = Vector3(_map_size().x / 2.0, 0, _map_size().y / 2.0)
	var back = (at - center).normalized() if at.distance_to(center) > 0.5 else Vector3(0, 0, -1)
	var ring = 1.0
	while ring <= MAX_BUILD_DRIFT_M:
		var steps = max(4, int(PI * ring / 1.2))  # each way round
		for k in steps + 1:
			var angle = PI * k / steps
			var pair = [at + back.rotated(Vector3.UP, angle) * ring, at + back.rotated(Vector3.UP, -angle) * ring]
			if pair[1].z < pair[0].z - 0.01:
				pair.reverse()
			for p in pair:
				if Utils.Match.Unit.Placement.validate_agent_placement_position(p, radius, blockers, nav) == valid:
					return p
		ring += 1.0
	return null


func _clear_footprint(at: Vector3, radius: float):
	for u in _own_units():
		if u is Structure or not Moving.is_applicable(u):
			continue
		var d = u.global_position_yless - at * Vector3(1, 0, 1)
		if d.length() < radius:
			var away = d.normalized() if d.length() > 0.1 else Vector3.RIGHT.rotated(Vector3.UP, randf() * TAU)
			u.action = Moving.new(_ground(u, at + away * (radius + 1.5)))


# What a model needs to plan its spending: income over the last minute, workers per resource, how
# many workers the deposits near home can use, and what it can afford right now.
func _economy() -> Dictionary:
	_income = _income.filter(func(e): return e[0] >= _time - 60.0)
	var per_minute = {"a": 0, "b": 0}
	for e in _income:
		per_minute[e[1]] += e[2]
	var span = clampf(_time, 1.0, 60.0) / 60.0
	var on = {"a": 0, "b": 0, "other": 0}
	for w in _own_units().filter(func(u): return u is Worker):
		var g = _gathering(w)
		on[g if g != "" else "other"] += 1
	var useful = _useful_workers()
	var affordable = []
	for name in ["worker", "tank", "helicopter", "drone"]:
		if has_resources(Constants.Match.Units.PRODUCTION_COSTS[UNIT_SCENES[name]]):
			affordable.append(name)
	for name in STRUCTURE_SCENES:
		if has_resources(Constants.Match.Units.CONSTRUCTION_COSTS[STRUCTURE_SCENES[name]]):
			affordable.append(name)
	return {
		"income_per_minute": {"a": int(per_minute["a"] / span), "b": int(per_minute["b"] / span)},
		"workers_on": on,
		"useful_workers": useful,
		"can_afford_now": affordable,
	}


# Deposits near this side's command centers can each keep about WORKERS_PER_DEPOSIT busy; more
# workers queue at them and add nothing.
func _useful_workers() -> int:
	var homes = _own_units().filter(func(u): return u is CommandCenter)
	var deposits = 0
	for d in get_tree().get_nodes_in_group("resource_units"):
		for h in homes:
			if h.global_position_yless.distance_to(d.global_position * Vector3(1, 0, 1)) <= DEPOSIT_REACH_M:
				deposits += 1
				break
	return max(4, deposits * WORKERS_PER_DEPOSIT)


# Planned builds, first come first served, once their resources are there.
func _start_planned_builds():
	if _plans.is_empty():
		return
	var plan = _plans[0]
	var cost = Constants.Match.Units.CONSTRUCTION_COSTS[STRUCTURE_SCENES[plan["structure"]]]
	if not has_resources(cost):
		return
	_plans.pop_front()
	var r = _build(plan["structure"], plan["near"], true)
	_plan_news.append(("planned " + r["message"]) if r["ok"] else "planned %s could not start: %s" % [plan["structure"], r["message"]])


func _take_plan_news() -> Array:
	var out = _plan_news
	_plan_news = []
	return out


# Resources left once planned builds have their share.
func _has_after_plans(cost: Dictionary) -> bool:
	var a = resource_a
	var b = resource_b
	for p in _plans:
		var c = Constants.Match.Units.CONSTRUCTION_COSTS[STRUCTURE_SCENES[p["structure"]]]
		a -= c.get("resource_a", 0)
		b -= c.get("resource_b", 0)
	return a >= cost.get("resource_a", 0) and b >= cost.get("resource_b", 0)


func _train(unit_name: String, count: int) -> Dictionary:
	if not UNIT_SCENES.has(unit_name):
		return _refuse("unknown unit %s (%s)" % [unit_name, ", ".join(UNIT_SCENES.keys())])
	if unit_name == "worker":
		var workers = _own_units().filter(func(u): return u is Worker).size()
		var queued = 0
		for b in _own_units().filter(func(u): return u is CommandCenter):
			queued += b.production_queue.size()
		var room = _useful_workers() - workers - queued
		if room <= 0:
			return _refuse(
				"you have %d workers (%d more training) and your deposits keep only about %d busy; more would add nothing. Spend resource a on a factory or army instead"
				% [workers, queued, _useful_workers()]
			)
		count = min(count, room)
	count = clamp(count, 1, 10)
	var producer_type = PRODUCERS[unit_name]
	var producers = _own_units().filter(
		func(u): return u is Structure and u.is_constructed() and _script_name(u) == producer_type
	)
	if producers.is_empty():
		return _refuse("%s needs a finished %s" % [unit_name, TYPE_NAMES[producer_type]])
	var scene = load(UNIT_SCENES[unit_name])
	var cost = Constants.Match.Units.PRODUCTION_COSTS[UNIT_SCENES[unit_name]]
	var queued = 0
	for _i in range(count):
		producers.sort_custom(func(x, y): return x.production_queue.size() < y.production_queue.size())
		var producer = producers[0]
		if producer.production_queue.size() >= Constants.Match.Units.PRODUCTION_QUEUE_LIMIT:
			break
		# Workers, up to useful_workers (checked above), come before planned builds: a side that
		# planned its factory in the first seconds once kept 2 workers all battle, because every
		# worker order found the money set aside.
		if not (has_resources(cost) if unit_name == "worker" else _has_after_plans(cost)):
			break
		var before = producer.production_queue.size()
		producer.production_queue.produce(scene)
		if producer.production_queue.size() == before:
			break
		queued += 1
	if queued == 0:
		return _refuse(
			"could not train %s: costs %s each, you have a %d, b %d%s, queue limit %d per building"
			% [unit_name, _cost_text(cost), resource_a, resource_b, (" (set aside for your planned " + ", ".join(_plans.map(func(p): return p["structure"])) + ")") if not _plans.is_empty() else "", Constants.Match.Units.PRODUCTION_QUEUE_LIMIT]
		)
	return _ok("training %d %s%s" % [queued, unit_name, "" if queued == count else " (no room or resources for the rest)"])


func _gather(resource: String, workers_arg) -> Dictionary:
	resource = resource.to_lower().replace("resource_", "").replace("resource ", "")
	if resource != "a" and resource != "b":
		return _refuse("resource must be a or b")
	var workers = _own_units().filter(func(u): return u is Worker and not (u.action is Constructing))
	if workers.is_empty():
		return _refuse("no free workers (all are building)")
	var count = workers.size()
	if typeof(workers_arg) in [TYPE_INT, TYPE_FLOAT]:
		count = clamp(int(workers_arg), 1, workers.size())
	elif typeof(workers_arg) == TYPE_ARRAY:
		var picked = _resolve_units(workers_arg).filter(func(u): return u is Worker)
		if not picked.is_empty():
			workers = picked
			count = picked.size()
	# Workers already on that resource keep going: re-sending them would restart their trip, and a
	# model that repeats the order every turn would never earn anything. Others are moved over.
	# A worker moved less than REASSIGN_COOLDOWN_S ago also keeps its job: a model that switched
	# its workers between a and b every turn (one did, 2026-10-21) restarted every trip and earned
	# nothing for a minute.
	var already = workers.filter(func(w): return _gathering(w) == resource)
	var others = workers.filter(func(w): return _gathering(w) != resource)
	var settling = others.filter(func(w): return _time - float(_moved_at.get(w.get_instance_id(), -1000.0)) < REASSIGN_COOLDOWN_S)
	others = others.filter(func(w): return not settling.has(w))
	for worker in already:
		_gather_choice[worker.get_instance_id()] = resource
	var sent = 0
	for worker in others.slice(0, max(0, count - already.size())):
		_gather_choice[worker.get_instance_id()] = resource
		if _send_gathering(worker, resource):
			_moved_at[worker.get_instance_id()] = _time
			sent += 1
	var total = min(count, already.size()) + sent
	var kept = ""
	if not settling.is_empty():
		kept = "; %d workers were moved less than %d s ago and keep their trip (switching restarts it, so they would deliver nothing)" % [settling.size(), int(REASSIGN_COOLDOWN_S)]
	if total == 0 and settling.is_empty():
		return _refuse("no deposit of resource %s found within reach" % resource)
	if sent == 0:
		return _ok("%d workers were already gathering resource %s (no change)%s" % [total, resource, kept])
	return _ok("%d workers gathering resource %s (%d moved over)%s" % [total, resource, sent, kept])


func _attack(units_arg, target: String) -> Dictionary:
	var units = _resolve_units(units_arg).filter(func(u): return u.attack_range != null and not u is Structure)
	if units.is_empty():
		return _refuse("no combat units for that (tanks and helicopters fight; drones and workers do not)")
	var target_unit = null
	var key = _key_for_id(target)
	if key != 0:
		var t = instance_from_id(key)
		if t != null and is_instance_valid(t) and "player" in t and t.player != self:
			target_unit = t
	var pos = null
	if target_unit != null:
		pos = target_unit.global_position
	else:
		pos = _enemy_position(target)
		if pos == null:
			pos = _place(target)
	if pos == null:
		return _refuse("unknown target %s (an enemy colour, an enemy id, a cell like D4)" % target)
	for unit in units:
		var old = _attack_targets.get(unit.get_instance_id())
		var same = old != null and old["unit"] == target_unit and (old["pos"] * Vector3(1, 0, 1)).distance_to(pos * Vector3(1, 0, 1)) < 3.0
		_attack_targets[unit.get_instance_id()] = {"pos": pos, "unit": target_unit}
		# The same attack repeated leaves units already fighting or on their way alone.
		if not (same and (unit.action is AutoAttacking or unit.action is Moving or unit.action is MovingToUnit)):
			_engage(unit)
	return _ok("%d units attacking toward %s" % [units.size(), _cell(pos)])


func _move(units_arg, to: String) -> Dictionary:
	var units = _resolve_units(units_arg).filter(func(u): return not u is Structure)
	if units.is_empty():
		return _refuse("no units match %s" % str(units_arg))
	var pos = _place(to)
	if pos == null:
		return _refuse("unknown place %s (base, center, a cell like D4, a start position colour or an id)" % to)
	for unit in units:
		_attack_targets.erase(unit.get_instance_id())
		if Moving.is_applicable(unit):
			unit.action = Moving.new(_ground(unit, pos))
	return _ok("%d units moving to %s" % [units.size(), _cell(pos)])


# ---- standing behaviour ----


func _remember_what_is_seen():
	for unit in _visible_enemies():
		if unit is Structure:
			_seen_buildings[unit.get_instance_id()] = {
				"player": _player_name(unit.player),
				"type": _type(unit),
				"cell": _cell(unit.global_position),
				"pos": unit.global_position,
				"at": _time,
			}
	for key in _seen_buildings.keys():
		var b = instance_from_id(key)
		if b == null or not is_instance_valid(b) or not b.is_inside_tree():
			# Destroyed where we could see it, or gone: drop it only when the spot is in sight.
			if _spot_in_sight(_seen_buildings[key]["pos"]):
				_seen_buildings.erase(key)
	for deposit in get_tree().get_nodes_in_group("resource_units"):
		if not _seen_deposits.has(deposit.get_instance_id()) and _spot_in_sight(deposit.global_position):
			_seen_deposits[deposit.get_instance_id()] = true


func _keep_workers_busy():
	for worker in _own_units().filter(func(u): return u is Worker and u.action == null):
		var choice = _gather_choice.get(worker.get_instance_id(), _scarcer_resource())
		if not _send_gathering(worker, choice):
			_send_gathering(worker, "b" if choice == "a" else "a")


func _finish_unfinished_structures():
	var unfinished = _own_units().filter(func(u): return u is Structure and not u.is_constructed())
	if unfinished.is_empty():
		return
	var workers = _own_units().filter(func(u): return u is Worker)
	for structure in unfinished:
		if workers.any(func(w): return w.action is Constructing and w.action._target_unit == structure):
			continue
		var free = workers.filter(func(w): return not (w.action is Constructing))
		var builder = _closest(free, structure.global_position)
		if builder != null:
			builder.action = Constructing.new(structure)


func _carry_out_attacks():
	for key in _attack_targets.keys():
		var unit = instance_from_id(key)
		if unit == null or not is_instance_valid(unit) or not unit.is_inside_tree():
			_attack_targets.erase(key)
			continue
		var busy = unit.action is AutoAttacking or unit.action is MovingToUnit or unit.action is Moving
		if not busy:
			_engage(unit)


# An attack-move step: fight the nearest enemy in reach, else head for the target.
func _engage(unit):
	var order = _attack_targets.get(unit.get_instance_id())
	if order == null:
		return
	var target_unit = order["unit"]
	if target_unit != null and (not is_instance_valid(target_unit) or not target_unit.is_inside_tree()):
		order["unit"] = null
		target_unit = null
	if target_unit != null and AutoAttacking.is_applicable(unit, target_unit):
		unit.action = AutoAttacking.new(target_unit)
		return
	var nearest = null
	var best = ENGAGE_RADIUS_M
	for enemy in _visible_enemies():
		var d = unit.global_position_yless.distance_to(enemy.global_position_yless)
		if d <= best and AutoAttacking.is_applicable(unit, enemy):
			best = d
			nearest = enemy
	if nearest != null:
		unit.action = AutoAttacking.new(nearest)
		return
	var goal = _ground(unit, order["pos"])
	if unit.global_position_yless.distance_to(goal * Vector3(1, 0, 1)) > 3.0:
		if Moving.is_applicable(unit):
			unit.action = Moving.new(goal)
	else:
		_attack_targets.erase(unit.get_instance_id())  # arrived, nothing left in reach


# The deposit a worker is sent to: the one nearest to where it delivers (this side's command
# centers), leaving out deposits nearer an enemy's start than to this side's base. Choosing by the
# worker's own position once sent one side's workers across the map into the enemy base when its
# own deposit ran out, while the mirror side found one at home: unfair on a mirrored map.
func _send_gathering(worker, resource: String) -> bool:
	var deposit = _deposit_for(worker, resource)
	if deposit == null:
		return false
	worker.action = CollectingResourcesSequentially.new(deposit)
	return true


func _deposit_for(worker, resource: String):
	var homes = _own_units().filter(func(u): return u is CommandCenter and u.is_constructed())
	var home_points = homes.map(func(cc): return cc.global_position_yless)
	if home_points.is_empty():
		home_points = [worker.global_position_yless]
	var enemy_starts = []
	for p in get_tree().get_nodes_in_group("players"):
		if p != self and _units_of(p).any(func(u): return u is Structure):
			enemy_starts.append(_spawn_position(p) * Vector3(1, 0, 1))
	var best = null
	var best_score = INF
	for d in get_tree().get_nodes_in_group("resource_units"):
		if not ("resource_" + resource) in d or not is_instance_valid(d):
			continue
		var spot = d.global_position * Vector3(1, 0, 1)
		var home_distance = INF
		for h in home_points:
			home_distance = min(home_distance, h.distance_to(spot))
		var score = home_distance
		for e in enemy_starts:
			if e.distance_to(spot) < home_distance:
				score += 1000.0  # on the enemy's side: only when nothing else is left
		if score < best_score:
			best_score = score
			best = d
	return best


# ---- helpers ----


func _own_units() -> Array:
	return get_tree().get_nodes_in_group("units").filter(func(u): return u.player == self)


func _units_of(p) -> Array:
	return get_tree().get_nodes_in_group("units").filter(func(u): return u.player == p)


func _visible_enemies() -> Array:
	return get_tree().get_nodes_in_group("units").filter(
		func(u): return u.player != self and _is_visible(u)
	)


func _is_visible(target) -> bool:
	return _spot_in_sight(target.global_position)


func _spot_in_sight(pos: Vector3) -> bool:
	var spot = pos * Vector3(1, 0, 1)
	for unit in _own_units():
		if unit.sight_range != null and unit.global_position_yless.distance_to(spot) <= unit.sight_range:
			return true
	return false


func _enemy_position(name: String):
	var target_player = null
	for p in get_tree().get_nodes_in_group("players"):
		if p != self and _player_name(p) == name.to_lower().replace(" ", ""):
			target_player = p
	if target_player == null:
		return null
	var mine = _base_position()
	var best = null
	var best_d = INF
	for unit in _visible_enemies().filter(func(u): return u.player == target_player):
		var d = unit.global_position.distance_to(mine)
		if d < best_d:
			best_d = d
			best = unit.global_position
	if best != null:
		return best
	for b in _seen_buildings.values():
		if b["player"] == _player_name(target_player):
			return b["pos"]
	return _spawn_position(target_player)


func _place(text: String):
	var t = text.strip_edges()
	var lower = t.to_lower()
	if lower in ["base", "my_base", "home", ""]:
		return _base_position()
	if lower in ["center", "centre", "middle"]:
		return Vector3(_map_size().x / 2.0, 0, _map_size().y / 2.0)
	var key = _key_for_id(lower)
	if key != 0:
		var node = instance_from_id(key)
		if node != null and is_instance_valid(node) and node.is_inside_tree():
			return node.global_position
	for p in get_tree().get_nodes_in_group("players"):
		if _player_name(p) == lower.replace(" ", ""):
			return _spawn_position(p)
	var m = RegEx.create_from_string("^([a-jA-J])\\s*(10|[1-9])$").search(t)
	if m != null:
		var col = m.get_string(1).to_upper().unicode_at(0) - "A".unicode_at(0)
		var row = int(m.get_string(2)) - 1
		var cell_size = _map_size() / GRID
		return Vector3((col + 0.5) * cell_size.x, 0, (row + 0.5) * cell_size.y)
	var xz = RegEx.create_from_string("^(-?[0-9.]+)\\s*,\\s*(-?[0-9.]+)$").search(t)
	if xz != null:
		return Vector3(
			clamp(float(xz.get_string(1)), 0, _map_size().x), 0, clamp(float(xz.get_string(2)), 0, _map_size().y)
		)
	return null


func _resolve_units(arg) -> Array:
	var own = _own_units().filter(func(u): return not u is Structure)
	if typeof(arg) == TYPE_ARRAY:
		var out = []
		for item in arg:
			out += _resolve_units(item)
		return out
	var text = str(arg).to_lower().strip_edges()
	match text:
		"army", "all", "all_army", "":
			return own.filter(func(u): return u.attack_range != null)
		"tanks", "tank":
			return own.filter(func(u): return _type(u) == "tank")
		"helicopters", "helicopter":
			return own.filter(func(u): return _type(u) == "helicopter")
		"drones", "drone":
			return own.filter(func(u): return _type(u) == "drone")
		"workers", "worker":
			return own.filter(func(u): return u is Worker)
	var key = _key_for_id(text)
	if key != 0:
		var unit = instance_from_id(key)
		if unit != null and is_instance_valid(unit) and unit.is_inside_tree() and unit.player == self:
			return [unit]
	return []


func _id(node) -> String:
	var key = node.get_instance_id()
	if _ids.has(key):
		return _ids[key]
	var prefix = "x"
	if node is ResourceUnit:
		prefix = "ra" if "resource_a" in node else "rb"
	elif "player" in node and node.player == self:
		prefix = ID_PREFIX.get(_type(node), "u")
	_counters[prefix] = _counters.get(prefix, 0) + 1
	var id = "%s%d" % [prefix, _counters[prefix]]
	_ids[key] = id
	_units_by_id[id] = key
	return id


func _key_for_id(text: String) -> int:
	return _units_by_id.get(text.to_lower().strip_edges(), 0)


func _type(unit) -> String:
	return TYPE_NAMES.get(_script_name(unit), _script_name(unit).to_lower())


func _script_name(unit) -> String:
	var path = unit.get_script().resource_path
	return path.substr(path.rfind("/") + 1).split(".")[0]


func _scene_type(path: String) -> String:
	return path.substr(path.rfind("/") + 1).split(".")[0]


func _hp(unit) -> String:
	return "%d/%d" % [unit.hp if unit.hp != null else 0, unit.hp_max if unit.hp_max != null else 0]


func _doing(unit) -> String:
	var a = unit.action
	if a == null:
		return "idle"
	if a is CollectingResourcesSequentially:
		return "gathering " + _gathering(unit)
	if a is Constructing:
		return "building"
	if a is AutoAttacking:
		return "attacking"
	if a is Moving or a is MovingToUnit:
		return "attack-moving" if _attack_targets.has(unit.get_instance_id()) else "moving"
	return "on guard" if unit.attack_range != null else "idle"


func _gathering(worker) -> String:
	if worker.action is CollectingResourcesSequentially:
		var d = worker.action.get_resource_unit()
		if d != null and is_instance_valid(d):
			return "a" if "resource_a" in d else "b"
	return ""


func _scarcer_resource() -> String:
	var a = 0
	var b = 0
	for w in _own_units().filter(func(u): return u is Worker):
		var g = _gathering(w)
		if g == "a":
			a += 1
		elif g == "b":
			b += 1
	return "a" if a <= b else "b"


func _cell(pos: Vector3) -> String:
	var size = _map_size()
	var col = clamp(int(pos.x / (size.x / GRID)), 0, GRID - 1)
	var row = clamp(int(pos.z / (size.y / GRID)), 0, GRID - 1)
	return "%s%d" % [String.chr("A".unicode_at(0) + col), row + 1]


func _map_size() -> Vector2:
	return _match.map.size


func _player_name(p) -> String:
	if p != null and "color_name" in p and p.color_name != "":
		return p.color_name
	var index = p.get_index() if p != null else -1
	return COLOR_NAMES[index] if index >= 0 and index < COLOR_NAMES.size() else "player%d" % index


func _spawn_position(p) -> Vector3:
	var points = _match.map.find_child("SpawnPoints")
	var index = p.get_index()
	if points != null and index < points.get_child_count():
		return points.get_child(index).global_position
	return Vector3(_map_size().x / 2.0, 0, _map_size().y / 2.0)


func _base_position() -> Vector3:
	var ccs = _own_units().filter(func(u): return u is CommandCenter)
	if not ccs.is_empty():
		return ccs[0].global_position
	var own = _own_units()
	return own[0].global_position if not own.is_empty() else _spawn_position(self)


func _ground(unit, pos: Vector3) -> Vector3:
	# Aircraft fly at their own height; ground units stay on the terrain.
	var y = unit.global_position.y if unit.movement_domain == Constants.Match.Navigation.Domain.AIR else 0.0
	return Vector3(pos.x, y, pos.z)


func _closest(units: Array, pos: Vector3):
	var best = null
	var best_d = INF
	for u in units:
		var d = u.global_position.distance_to(pos)
		if d < best_d:
			best_d = d
			best = u
	return best


func _cost_text(cost: Dictionary) -> String:
	return "a %d, b %d" % [cost.get("resource_a", 0), cost.get("resource_b", 0)]


func _ok(message: String) -> Dictionary:
	return {"ok": true, "message": message}


func _refuse(message: String) -> Dictionary:
	return {"ok": false, "message": message}
