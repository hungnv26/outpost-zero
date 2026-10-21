extends RefCounted

# Two games in one project (docs/outpost-war.md): Outpost Zero, the colony with real AI agents,
# and Outpost War, the real-time strategy battle (Open RTS by Lampe Games, the game this project
# is built on). The mode comes from the command line (`-- --mode=outpost-war`), else the last
# choice saved in user://game_mode.cfg, else Outpost Zero. The old id "open-rts" still works.
# Switching restarts the game, so nothing from one mode (the world feed, the shroud, lighting,
# window settings) leaks into the other.

const OUTPOST_ZERO = "outpost-zero"
const OUTPOST_WAR = "outpost-war"
const LEGACY_IDS = {"open-rts": "outpost-war"}
const SAVE_PATH = "user://game_mode.cfg"
const SCENES = {
	OUTPOST_ZERO: "res://source/agent/AgentMatch.tscn",
	OUTPOST_WAR: "res://source/Main.tscn",
}
const TITLES = {OUTPOST_ZERO: "Outpost Zero", OUTPOST_WAR: "OUTPOST WAR"}

# The mode this window is running (set by Boot).
static var running = ""


# The window's title bar shows the game's name. Godot's own title is the project's name plus
# " (DEBUG)" (this runs on the editor build), and it puts that back whenever the window changes
# size or mode, so the title is set on the OS window again after every such change.
static func apply_title(tree: SceneTree):
	if DisplayServer.get_name() == "headless" or not TITLES.has(running):
		return
	DisplayServer.window_set_title(TITLES[running])


static func keep_title(tree: SceneTree):
	var again = func(): apply_title.call_deferred(tree)
	tree.root.size_changed.connect(again)
	tree.root.focus_entered.connect(again)
	apply_title.call_deferred(tree)


static func from_command_line() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--mode="):
			var m = LEGACY_IDS.get(arg.substr(7), arg.substr(7))
			if SCENES.has(m):
				return m
	return ""


static func saved() -> String:
	var cfg = ConfigFile.new()
	if cfg.load(SAVE_PATH) == OK:
		var m = str(cfg.get_value("game", "mode", ""))
		m = LEGACY_IDS.get(m, m)
		if SCENES.has(m):
			return m
	return ""


# `--prefer-mode=` (scripts/start.sh --war) picks the first mode but, unlike --mode, still lets
# the Mission Control settings card switch it.
static func preferred() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--prefer-mode="):
			var m = LEGACY_IDS.get(arg.substr(14), arg.substr(14))
			if SCENES.has(m):
				return m
	return ""


static func current() -> String:
	var m = from_command_line()
	if m == "":
		m = preferred()
	if m == "":
		m = saved()
	return m if m != "" else OUTPOST_ZERO


# A window started with an explicit --mode (recorders, captures, team windows, smoke tests) keeps
# that mode; every other window follows the Mission Control settings card (docs/settings.md).
static func explicit() -> bool:
	return from_command_line() != ""


# A window started for a tool (screenshots, movies, placed team windows) keeps its own display.
static func tool_window() -> bool:
	if "--write-movie" in OS.get_cmdline_args():
		return true
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--capture-dir=") or arg.begins_with("--window=") or arg.begins_with("--settings-file="):
			return true
	return false


# The settings card's `game`: switch to it unless this window was told its mode.
static func follow(tree: SceneTree, game: String):
	if game == "" or not SCENES.has(game) or explicit() or game == running:
		return
	switch_to(tree, game)


static func save(mode: String):
	var cfg = ConfigFile.new()
	cfg.load(SAVE_PATH)
	cfg.set_value("game", "mode", mode)
	cfg.save(SAVE_PATH)


# Each mode's feature flags. Outpost Zero runs its own match end; Outpost War gets its victory and
# defeat back. Neither shows a logo intro. God mode (a developer shortcut) stays off in
# both; the toggle_god_mode key still works in Outpost War.
static func apply_flags(mode: String):
	if mode == OUTPOST_WAR:
		# No Godot logo intro (the user's choice, 2026-10-22): the window opens on the menu.
		FeatureFlags.show_logos_on_startup = false
		FeatureFlags.handle_match_end = true
	else:
		FeatureFlags.show_logos_on_startup = false
		FeatureFlags.handle_match_end = false
	FeatureFlags.god_mode = false


# Saves the choice and restarts the game in that mode (same command line, minus any --mode flag,
# so the saved choice applies).
static func switch_to(tree: SceneTree, mode: String):
	save(mode)
	# The new process may start in another working directory (macOS relaunches the app bundle),
	# so pass the project folder as an absolute --path.
	var args = []
	var given = Array(OS.get_cmdline_args())
	var i = 0
	while i < given.size():
		if given[i] == "--path" and i + 1 < given.size():
			i += 2
			continue
		args.append(given[i])
		i += 1
	args = ["--path", ProjectSettings.globalize_path("res://")] + args
	var user = Array(OS.get_cmdline_user_args()).filter(
		func(a): return not a.begins_with("--mode=") and not a.begins_with("--prefer-mode=") and not a.begins_with("--test-switch-to=")
	)
	if not user.is_empty():
		args.append("--")
		args.append_array(user)
	OS.set_restart_on_exit(true, PackedStringArray(args))
	tree.quit()
