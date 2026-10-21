extends Node

# An unattended Outpost War match for tools/war_smoke.sh: computer players only, on one map,
# optionally sped up. Prints one WAR_SMOKE line and quits: exit 0 when the match ends with a
# single player left (the original Open RTS MatchEndHandler pauses the game then), 2 on a timeout.

const MatchSettings = preload("res://source/data-model/MatchSettings.gd")
const PlayerSettings = preload("res://source/data-model/PlayerSettings.gd")

var map_name = "PlainAndSimple"
var speed = 1.0
var players = 2
var timeout_s = 900.0  # real seconds

var _started = 0
var _last_report = 0


func _ready():
	process_mode = Node.PROCESS_MODE_ALWAYS  # keep watching after the match pauses at its end
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--war-players="):
			players = int(arg.substr(14))
		elif arg.begins_with("--war-timeout="):
			timeout_s = float(arg.substr(14))
	var map_path = "res://source/match/maps/%s.tscn" % map_name
	if not ResourceLoader.exists(map_path):
		_finish("error", "no map %s" % map_name, 3)
		return
	Engine.time_scale = speed
	Engine.max_physics_steps_per_frame = int(max(8, ceil(speed * 2)))
	var settings = MatchSettings.new()
	for i in players:
		var p = PlayerSettings.new()
		p.controller = Constants.PlayerType.SIMPLE_CLAIRVOYANT_AI
		p.color = Constants.Player.COLORS[i]
		settings.players.append(p)
	settings.visible_player = -1
	settings.visibility = settings.Visibility.ALL_PLAYERS
	var loading = load("res://source/main-menu/Loading.tscn").instantiate()
	loading.match_settings = settings
	loading.map_path = map_path
	get_tree().root.add_child.call_deferred(loading)
	(func(): get_tree().current_scene = loading).call_deferred()
	_started = Time.get_ticks_msec()
	print("WAR_SMOKE start map=%s players=%d speed=%s" % [map_name, players, speed])


func _process(_delta):
	var elapsed = (Time.get_ticks_msec() - _started) / 1000.0
	var counts = _unit_counts()
	if elapsed - _last_report >= 15.0:
		_last_report = elapsed
		print("WAR_SMOKE progress t=%ds units=%s" % [int(elapsed), counts])
	if get_tree().paused and get_tree().current_scene != null and get_tree().current_scene.name == "Match":
		var winner = counts.keys()[0] if counts.size() == 1 else "?"
		_finish("finished", "winner=player%s units=%s game_time=%ds" % [winner, counts, int(elapsed * speed)], 0)
	elif elapsed > timeout_s:
		# Scripted players can stall (tanks cannot hit a lone helicopter); a side holding 80% of
		# the remaining value has won in all but name. Anything else is a real failure.
		var share = _leader_share()
		if share[1] >= 0.8:
			_finish("decided", "leader=player%s share=%d%% units=%s" % [share[0], int(share[1] * 100), counts], 0)
		else:
			_finish("timeout", "units=%s detail=%s" % [counts, _detail()], 2)


func _unit_counts() -> Dictionary:
	var out = {}
	var ids = {}
	var ps = get_tree().get_nodes_in_group("players")
	for i in ps.size():
		ids[ps[i]] = i
	for unit in get_tree().get_nodes_in_group("units"):
		var k = ids.get(unit.player, -1)
		out[k] = out.get(k, 0) + 1
	return out


func _finish(result: String, detail: String, code: int):
	print("WAR_SMOKE result=%s map=%s %s" % [result, map_name, detail])
	set_process(false)
	get_tree().quit(code)


# Per player: unit kinds and resources, to tell a stalemate (only buildings left, no resources)
# from a stuck engine.
func _detail() -> String:
	var out = {}
	var ps = get_tree().get_nodes_in_group("players")
	for i in ps.size():
		out[i] = {"a": ps[i].get("resource_a"), "b": ps[i].get("resource_b"), "kinds": {}}
	for unit in get_tree().get_nodes_in_group("units"):
		var i = ps.find(unit.player)
		if i < 0:
			continue
		var kind = unit.get_script().resource_path.get_file().get_basename()
		out[i]["kinds"][kind] = out[i]["kinds"].get(kind, 0) + 1
	var left = get_tree().get_nodes_in_group("resource_units").size()
	return "%s resource_deposits_left=%d" % [out, left]


# [player index, share of all surviving value] for the side with the most (costs times health).
func _leader_share() -> Array:
	var ps = get_tree().get_nodes_in_group("players")
	var value = {}
	var total = 0.0
	for unit in get_tree().get_nodes_in_group("units"):
		var i = ps.find(unit.player)
		if i < 0:
			continue
		var path = unit.scene_file_path
		var cost = Constants.Match.Units.CONSTRUCTION_COSTS.get(path, Constants.Match.Units.PRODUCTION_COSTS.get(path, {}))
		var worth = float(cost.get("resource_a", 0) + cost.get("resource_b", 0))
		value[i] = value.get(i, 0.0) + worth
		total += worth
	var best = -1
	for i in value:
		if best == -1 or value[i] > value[best]:
			best = i
	return [best, value.get(best, 0.0) / total if total > 0.0 else 0.0]
