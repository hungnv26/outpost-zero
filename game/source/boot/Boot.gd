extends Node

# The start scene: picks the mode (GameMode.gd), applies its flags and window title, and opens
# Outpost Zero's colony or Outpost War's logos and main menu.
# `-- --mode=outpost-war --war-autoplay=MAP [--war-speed=N]` plays an unattended match of
# computer players on that map (tools/war_smoke.sh) and quits with the result.

const GameMode = preload("res://source/boot/GameMode.gd")


func _ready():
	var mode = GameMode.current()
	GameMode.running = mode
	GameMode.apply_flags(mode)
	GameMode.keep_title(get_tree())
	var autoplay = ""
	var speed = 1.0
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--war-autoplay="):
			autoplay = arg.substr(15)
		elif arg.begins_with("--war-speed="):
			speed = float(arg.substr(12))
	if mode == GameMode.OUTPOST_WAR:
		_setup_capture()
	# Test hook (tools/war_smoke.sh): switch modes 4 s after start, as the buttons do.
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--test-switch-to="):
			var target = arg.substr(17)
			get_tree().create_timer(4.0).timeout.connect(GameMode.switch_to.bind(get_tree(), target))
	if mode == GameMode.OUTPOST_WAR and autoplay != "":
		_autoplay.call_deferred(autoplay, speed)
		return
	if mode == GameMode.OUTPOST_WAR:
		# Battles and their settings come from the Arena Setup page (docs/outpost-war.md).
		var client = load("res://source/war/BattleClient.gd").new()
		client.name = "BattleClient"
		get_tree().root.add_child.call_deferred(client)
	get_tree().change_scene_to_file.call_deferred(GameMode.SCENES[mode])


func _autoplay(map_name: String, speed: float):
	var smoke = load("res://source/boot/WarSmoke.gd").new()
	smoke.map_name = map_name
	smoke.speed = speed
	get_tree().root.add_child(smoke)
	queue_free()


# Screenshots in Outpost War mode (Outpost Zero's scene has its own): `--capture-dir=DIR
# --capture-at=4,20 [--quit-after-capture]`, taken by a node that outlives scene changes.
func _setup_capture():
	var capture = load("res://source/boot/Capture.gd").new()
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--capture-dir="):
			capture.dir = arg.substr(14)
		elif arg.begins_with("--capture-at="):
			for t in arg.substr(13).split(","):
				capture.times.append(float(t))
		elif arg == "--quit-after-capture":
			capture.quit_after = true
	if capture.dir == "" or capture.times.is_empty():
		capture.free()
		return
	get_tree().root.add_child.call_deferred(capture)
