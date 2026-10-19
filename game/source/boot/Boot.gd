extends Node

# The start scene: picks the mode (GameMode.gd), applies its flags and window title, and opens
# Outpost Zero's colony or Open RTS's logos and main menu.
# `-- --mode=open-rts --classic-autoplay=MAP [--classic-speed=N]` plays an unattended match of
# computer players on that map (tools/classic_smoke.sh) and quits with the result.

const GameMode = preload("res://source/boot/GameMode.gd")


func _ready():
	var mode = GameMode.current()
	GameMode.apply_flags(mode)
	if DisplayServer.get_name() != "headless":
		DisplayServer.window_set_title(GameMode.TITLES[mode])
	var autoplay = ""
	var speed = 1.0
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--classic-autoplay="):
			autoplay = arg.substr(19)
		elif arg.begins_with("--classic-speed="):
			speed = float(arg.substr(16))
	if mode == GameMode.OPEN_RTS:
		_setup_capture()
	# Test hook (tools/classic_smoke.sh): switch modes 4 s after start, as the buttons do.
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--test-switch-to="):
			var target = arg.substr(17)
			get_tree().create_timer(4.0).timeout.connect(GameMode.switch_to.bind(get_tree(), target))
	if mode == GameMode.OPEN_RTS and autoplay != "":
		_autoplay.call_deferred(autoplay, speed)
		return
	get_tree().change_scene_to_file.call_deferred(GameMode.SCENES[mode])


func _autoplay(map_name: String, speed: float):
	var smoke = load("res://source/boot/ClassicSmoke.gd").new()
	smoke.map_name = map_name
	smoke.speed = speed
	get_tree().root.add_child(smoke)
	queue_free()


# Screenshots in Open RTS mode (Outpost Zero's scene has its own): `--capture-dir=DIR
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
