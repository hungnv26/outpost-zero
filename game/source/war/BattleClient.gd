extends Node

# Outpost War's link to the battle service (docs/outpost-war.md). The game has no setup screens:
# battles are set up on the Arena Setup page (http://127.0.0.1:8790), and the battle service
# (adapter/src/battle-main.ts, ws://127.0.0.1:8796/game) hands each one to this node. It starts the
# battle with the card's settings, watches for the end (one player left, the time limit, or the
# human leaving), reports the result and returns to the main menu. Lives under the root, so scene
# changes keep it.

signal status_changed(text)

const MatchSettings = preload("res://source/data-model/MatchSettings.gd")
const PlayerSettings = preload("res://source/data-model/PlayerSettings.gd")
const Structure = preload("res://source/match/units/Structure.gd")
const Options = preload("res://source/data-model/Options.gd")
const GameMode = preload("res://source/boot/GameMode.gd")
const SettingsScript = preload("res://source/agent/Settings.gd")
const UI_DESIGN_HEIGHT = 1080.0  # Open RTS's menus and HUD are laid out for 1080 pixels
const RECONNECT_S = 2.0
const COLOR_NAMES = ["blue", "red", "green", "purple", "darkgreen", "khaki", "navy", "turquoise"]
const FREEZE_S = 10.0  # the final scene stays frozen this long before the ending shows
const ENDING_S = 45.0  # the ending stays up this long (or until the next battle), then the menu

var status = "Connecting to the battle service…"

var _ws = WebSocketPeer.new()
var _url = OS.get_environment("OUTPOST_WAR_WS")
var _next_connect = 0.0
var _was_open = false
var _battle = null  # the card's settings while a battle runs
var _battle_id = null
var _game_time = 0.0
var _check_timer = 0.0
var _ended = false
var _display = null  # Outpost Zero's display settings (agent/Settings.gd), shared by both games
var _ending = null  # EndingScreen.gd while a battle's ending is shown
var _ended_battle = {}  # the finished battle's settings and result, for its ending
var _summary = []  # the models' figures for the finished battle (battle.summary)
var _pending = null  # a battle that arrived before the main menu was up: [id, battle]
var _framed = false  # the spectator camera has been set for this battle


func _ready():
	process_mode = Node.PROCESS_MODE_ALWAYS  # keep the link alive while a match is paused
	if _url == "":
		_url = "ws://127.0.0.1:8796/game"
	MatchSignals.match_aborted.connect(_on_match_aborted)
	_apply_display()


# The same display settings as Outpost Zero (user://outpost_zero_settings.cfg, and the Mission
# Control settings card): window size in real pixels up to 4K, 3D resolution and anti-aliasing.
# Open RTS on its own opened a 1600x900 window without anti-aliasing. The menus and HUD scale with
# the window, so they keep their size on a 4K window.
func _apply_display():
	_display = SettingsScript.new()
	_display.load_settings()
	if DisplayServer.get_name() == "headless":
		return
	if not GameMode.tool_window() and (_display.has_saved_window or _display.fullscreen):
		_display.apply_window()
	_display.apply_render(get_tree().root)
	if not get_tree().root.size_changed.is_connected(_fit_ui):
		get_tree().root.size_changed.connect(_fit_ui)
	_fit_ui()


func _fit_ui():
	var height = float(DisplayServer.window_get_size().y)
	get_tree().root.content_scale_factor = max(1.0, height / UI_DESIGN_HEIGHT)


var _last_frame_us = 0


func _process(delta):
	# A frame that took over half a second is a stall the players can see: log it (docs/rts-arena.md).
	var now_us = Time.get_ticks_usec()
	if _battle != null and _last_frame_us > 0 and now_us - _last_frame_us > 500000:
		print("STALL %.1f s at game time %d s (%d units on the map)" % [(now_us - _last_frame_us) / 1e6, int(_game_time), get_tree().get_nodes_in_group("units").size()])
	_last_frame_us = now_us
	_poll_socket()
	if _pending != null and _at_menu():
		var p = _pending
		_pending = null
		_start(p[0], p[1])
	if _battle == null or _ended:
		return
	if not get_tree().paused:
		_game_time += delta  # scaled by Engine.time_scale: game time
	_check_timer -= delta
	if _check_timer > 0.0:
		return
	_check_timer = 0.5
	if not _in_match():
		return
	if not _framed:
		_framed = true
		_dress_battlefield()
		var sound = load("res://source/war/WarSound.gd").new()
		sound.name = "WarSound"
		get_tree().current_scene.add_child(sound)
		_frame_all_bases()
	var alive = _players_alive()
	if alive.size() <= 1:
		_finish(alive[0] if alive.size() == 1 else -1, "one player left")
	elif _battle["minutes"] > 0 and _game_time >= _battle["minutes"] * 60.0:
		_finish(_leader_by_value(), "time limit reached; ahead on army and building value")


# ---- the socket ----


func _poll_socket():
	_ws.poll()
	var state = _ws.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _was_open:
			_was_open = true
			_set_status("Waiting for a battle from Arena Setup")
		while _ws.get_available_packet_count() > 0:
			var msg = JSON.parse_string(_ws.get_packet().get_string_from_utf8())
			if msg is Dictionary:
				_on_message(msg)
	elif state == WebSocketPeer.STATE_CLOSED:
		if _was_open:
			_was_open = false
			_set_status("Lost the link to the battle service; reconnecting…")
		var now = Time.get_ticks_msec() / 1000.0
		if now >= _next_connect:
			_next_connect = now + RECONNECT_S
			_ws = WebSocketPeer.new()
			_ws.connect_to_url(_url)


func _send(msg: Dictionary):
	if _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(JSON.stringify(msg))


func _on_message(msg: Dictionary):
	match msg.get("type", ""):
		"battle.start":
			# A fresh window plays its intro first, and the intro's switch to the menu would free
			# the battle's loading screen: hold the battle until the menu is up.
			if _at_menu():
				_start(msg.get("id"), msg.get("battle", {}))
			else:
				_pending = [msg.get("id"), msg.get("battle", {})]
				_set_status("Battle received; starting after the intro")
				# A battle does not wait for the title sequence (war/WarIntro.gd).
				var scene = get_tree().current_scene
				var intro = scene.find_child("WarIntro", true, false) if scene != null else null
				if intro != null and intro.has_method("skip"):
					intro.skip()
		"battle.stop":
			_pending = null
			if _battle != null:
				_end_and_return("Battle stopped from Arena Setup.")
		"settings":
			_apply_settings(msg.get("settings"))
		"battle.summary":
			_summary = msg.get("commanders", [])
			if _ending != null and is_instance_valid(_ending):
				_ending.set_commanders(_summary)
		"war.observe", "war.order":
			_answer_model_request(msg)


func _set_status(text: String):
	status = text
	status_changed.emit(text)


# ---- a battle ----


func _start(id, battle: Dictionary):
	_close_ending()
	_battle = battle
	_framed = false
	_battle_id = id
	_game_time = 0.0
	_ended = false
	var settings = MatchSettings.new()
	var offset = 0
	var slots = {}
	for p in battle.get("players", []):
		slots[int(p["slot"])] = p
	var top = slots.keys().max()
	for slot in range(top + 1):
		if not slots.has(slot):
			offset += 1
			continue
		var ps = PlayerSettings.new()
		match slots[slot]["controller"]:
			"human":
				ps.controller = Constants.PlayerType.HUMAN
			"model":
				ps.controller = Constants.PlayerType.MODEL
			_:
				ps.controller = Constants.PlayerType.SIMPLE_CLAIRVOYANT_AI
		ps.color = Constants.Player.COLORS[slot]
		ps.spawn_index_offset = offset
		offset = 0
		settings.players.append(ps)
	settings.visible_player = -1
	for i in settings.players.size():
		if settings.players[i].controller == Constants.PlayerType.HUMAN:
			settings.visible_player = i
	# Fog off, or nobody human to play (a spectator watching models or scripted players): the
	# whole map shows, battlefield and scenery included.
	if not battle.get("fog", true) or settings.visible_player == -1:
		settings.visibility = settings.Visibility.FULL
	# The card's display settings (Outpost War has no Options screen).
	Globals.options.screen = Options.Screen.FULL if battle.get("screen") == "fullscreen" else Options.Screen.WINDOW
	Globals.options.mouse_restricted = battle.get("mouse") == "restricted"
	Engine.time_scale = float(battle.get("speed", 1.0))
	_set_status("Battle on %s" % battle.get("mapName", ""))
	get_tree().paused = false
	var loading = load("res://source/main-menu/Loading.tscn").instantiate()
	loading.match_settings = settings
	loading.map_path = "res://source/match/maps/%s.tscn" % battle.get("map", "PlainAndSimple")
	var old = get_tree().current_scene
	get_tree().root.add_child(loading)
	get_tree().current_scene = loading
	if old != null:
		old.queue_free()


func _at_menu() -> bool:
	var scene = get_tree().current_scene
	# By file: the intro (res://source/Main.tscn) has a root called Main too.
	return scene != null and scene.scene_file_path == "res://source/main-menu/Main.tscn"


# The battle's battlefield (one of Outpost Zero's, chosen on Arena Setup) dresses the plain map:
# terrain, light, scenery and a mirrored layout of structures and obstacles (war/WarDressing.gd).
func _dress_battlefield():
	var field = _battle.get("field") if _battle != null else null
	if not (field is Dictionary):
		return
	var match_node = get_tree().current_scene
	var dressing = load("res://source/war/WarDressing.gd").new()
	dressing.name = "WarDressing"
	match_node.add_child(dressing)
	dressing.dress(match_node, field)


# With no human player the window is a spectator's: start the camera over the middle of the map,
# zoomed out to show every base, rather than on the first player's base.
func _frame_all_bases():
	if _battle == null or _battle.get("players", []).any(func(p): return p["controller"] == "human"):
		return
	var match_node = get_tree().current_scene
	var camera = match_node.find_child("IsometricCamera3D")
	var points = match_node.map.find_child("SpawnPoints") if match_node.map != null else null
	if camera == null or points == null:
		return
	# The middle of the map, zoomed to show all of it (the bases sit near its edges).
	var map_size: Vector2 = match_node.map.size
	var center = Vector3(map_size.x / 2.0, 0, map_size.y / 2.0)
	var size = map_size.x * 0.8
	camera.size_max = max(camera.size_max, size)
	camera.set_size_safely(size)
	camera.set_position_safely(center)


func _in_match() -> bool:
	var scene = get_tree().current_scene
	return scene != null and scene.name == "Match"


func _players() -> Array:
	return get_tree().get_nodes_in_group("players")


# A side is out once it has no buildings left (finished or being built), as in most strategy games:
# a few aircraft hiding in a corner that the winner's tanks cannot hit no longer keep a lost battle
# going.
func _players_alive() -> Array:
	var ps = _players()
	var alive = []
	for unit in get_tree().get_nodes_in_group("units"):
		if not unit is Structure:
			continue
		var i = ps.find(unit.player)
		if i >= 0 and not alive.has(i):
			alive.append(i)
	return alive


# At the time limit: the side with the most surviving value (costs times health).
func _leader_by_value() -> int:
	var ps = _players()
	var value = {}
	for unit in get_tree().get_nodes_in_group("units"):
		var i = ps.find(unit.player)
		if i < 0:
			continue
		var path = unit.scene_file_path
		var cost = Constants.Match.Units.CONSTRUCTION_COSTS.get(path, Constants.Match.Units.PRODUCTION_COSTS.get(path, {}))
		var worth = float(cost.get("resource_a", 0) + cost.get("resource_b", 0))
		var hp = unit.get("hp")
		var hp_max = unit.get("hp_max")
		if hp != null and hp_max != null and hp_max > 0:
			worth *= float(hp) / float(hp_max)
		value[i] = value.get(i, 0.0) + worth
	var best = -1
	for i in value:
		if best == -1 or value[i] > value[best]:
			best = i
	return best


func _finish(winner_index: int, reason: String):
	_ended = true
	var ps = _players()
	var players = []
	var colors = _card_colors()
	for i in ps.size():
		var units = 0
		var structures = 0
		for unit in get_tree().get_nodes_in_group("units"):
			if unit.player == ps[i]:
				if unit is Structure:
					structures += 1
				else:
					units += 1
		players.append({
			"color": colors[i] if i < colors.size() else "?",
			"controller": _controller_name(ps[i]),
			"units": units,
			"structures": structures,
			"alive": structures > 0,
		})
	var result = {
		"type": "battle.finished",
		"winner": colors[winner_index] if winner_index >= 0 and winner_index < colors.size() else null,
		"reason": reason,
		"gameTimeS": int(_game_time),
		"players": players,
	}
	_send(result)
	_set_status("Battle over. Waiting for the next battle from Arena Setup")
	# Freeze the final scene for a moment, then show the ending over it (EndingScreen.gd); the menu
	# returns after ENDING_S, or the next battle replaces it.
	get_tree().paused = true
	_ended_battle = {"battle": _battle.duplicate(true), "result": result, "id": _battle_id}
	_summary = []
	var id = _battle_id
	get_tree().create_timer(FREEZE_S, true, false, true).timeout.connect(func(): _show_ending(id))


func _show_ending(id):
	if _ended_battle.get("id") != id or _battle_id != id:
		return  # another battle has started since
	_ending = load("res://source/war/EndingScreen.gd").new()
	get_tree().root.add_child(_ending)
	_ending.show_result(_ended_battle["result"], _ended_battle["battle"])
	if not _summary.is_empty():
		_ending.set_commanders(_summary)
	get_tree().create_timer(ENDING_S, true, false, true).timeout.connect(func():
		if _ended_battle.get("id") == id and _battle_id == id:
			_end_and_return("")
	)


func _close_ending():
	if _ending != null and is_instance_valid(_ending):
		_ending.queue_free()
	_ending = null


func _controller_name(player) -> String:
	var path = player.get_script().resource_path
	if path.contains("human"):
		return "human"
	if path.contains("/model/"):
		return "model"
	return "ai"


# The battle service's requests for a model player (docs/rts-arena.md): what its side can see,
# and its orders. Each gets one reply with the same req id.
func _answer_model_request(msg: Dictionary):
	var reply = {"type": "war.reply", "req": msg.get("req")}
	var player = _model_player(str(msg.get("color", "")))
	if _battle == null or _ended or not _in_match():
		reply["error"] = "no battle is running"
	elif player == null:
		reply["error"] = "no model player is %s" % msg.get("color", "")
	elif msg.get("type") == "war.observe":
		reply["data"] = player.observe()
	else:
		var order = msg.get("order", {})
		reply["data"] = player.execute(order if order is Dictionary else {})
	_send(reply)


func _model_player(color_name: String):
	var slot = COLOR_NAMES.find(color_name)
	for p in _players():
		if p.get_index() == slot and p.has_method("execute"):
			return p
	return null


func _card_colors() -> Array:
	var out = []
	var players = _battle.get("players", []) if _battle != null else []
	var sorted = players.duplicate()
	sorted.sort_custom(func(a, b): return int(a["slot"]) < int(b["slot"]))
	for p in sorted:
		out.append(p["color"])
	return out


func _end_and_return(note: String):
	_close_ending()
	_battle = null
	_battle_id = null
	_ended = false
	Engine.time_scale = 1.0
	get_tree().paused = false
	if note != "":
		_set_status(note + " Waiting for the next battle.")
	else:
		_set_status("Waiting for a battle from Arena Setup")
	get_tree().change_scene_to_file("res://source/main-menu/Main.tscn")


# The human left through the match menu: that ends the battle without a winner.
func _on_match_aborted():
	if _battle == null or _ended:
		return
	_ended = true
	_send({"type": "battle.finished", "winner": null, "reason": "the human player left the battle", "gameTimeS": int(_game_time), "players": []})
	_battle = null
	_battle_id = null
	Engine.time_scale = 1.0
	_set_status("You left the battle. Waiting for the next battle from Arena Setup")


# The Mission Control settings card (docs/settings.md): which game this window shows, and its
# display between battles (a running battle keeps its card's screen setting).
func _apply_settings(settings):
	if not (settings is Dictionary):
		return
	GameMode.follow(get_tree(), str(settings.get("game", "")))
	if _display == null or GameMode.tool_window() or DisplayServer.get_name() == "headless":
		return
	var changed = false
	if settings.has("window_size"):
		var ws = settings["window_size"]
		var size = Vector2i(int(ws[0]), int(ws[1]))
		if size != _display.window_size or not _display.has_saved_window:
			_display.window_size = size
			_display.has_saved_window = true
			changed = true
	for key in ["render_scale", "msaa"]:
		if settings.has(key) and absf(float(settings[key]) - float(_display.get(key))) > 0.001:
			_display.set(key, int(settings[key]) if key == "msaa" else float(settings[key]))
			changed = true
	if settings.has("fullscreen") and bool(settings["fullscreen"]) != _display.fullscreen:
		_display.fullscreen = bool(settings["fullscreen"])
		changed = true
	if not changed:
		return
	_display.save_settings()
	_display.apply_render(get_tree().root)
	# A battle's own window/fullscreen choice stays until it ends.
	if _battle == null:
		_display.apply_window()
		_fit_ui()
