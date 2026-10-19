extends RefCounted

# Two games in one project (docs/open-rts-mode.md): Outpost Zero, the colony with real AI agents,
# and Open RTS, the original deathmatch it was built on. The mode comes from the command line
# (`-- --mode=open-rts`), else the last choice saved in user://game_mode.cfg, else Outpost Zero.
# Switching restarts the game, so nothing from one mode (the world feed, the shroud, lighting,
# window settings) leaks into the other.

const OUTPOST_ZERO = "outpost-zero"
const OPEN_RTS = "open-rts"
const SAVE_PATH = "user://game_mode.cfg"
const SCENES = {
	OUTPOST_ZERO: "res://source/agent/AgentMatch.tscn",
	OPEN_RTS: "res://source/Main.tscn",
}
const TITLES = {OUTPOST_ZERO: "Outpost Zero", OPEN_RTS: "Open RTS"}


static func from_command_line() -> String:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--mode="):
			var m = arg.substr(7)
			if SCENES.has(m):
				return m
	return ""


static func saved() -> String:
	var cfg = ConfigFile.new()
	if cfg.load(SAVE_PATH) == OK:
		var m = str(cfg.get_value("game", "mode", ""))
		if SCENES.has(m):
			return m
	return ""


static func current() -> String:
	var m = from_command_line()
	if m == "":
		m = saved()
	return m if m != "" else OUTPOST_ZERO


static func save(mode: String):
	var cfg = ConfigFile.new()
	cfg.load(SAVE_PATH)
	cfg.set_value("game", "mode", mode)
	cfg.save(SAVE_PATH)


# Each mode's feature flags. Outpost Zero runs its own match end and no logos; Open RTS gets its
# logos and its victory and defeat back. God mode (a developer shortcut) stays off in both; the
# toggle_god_mode key still works in Open RTS.
static func apply_flags(mode: String):
	if mode == OPEN_RTS:
		FeatureFlags.show_logos_on_startup = true
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
		func(a): return not a.begins_with("--mode=") and not a.begins_with("--test-switch-to=")
	)
	if not user.is_empty():
		args.append("--")
		args.append_array(user)
	OS.set_restart_on_exit(true, PackedStringArray(args))
	tree.quit()
