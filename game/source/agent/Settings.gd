extends RefCounted

# Player display settings, saved to user://outpost_zero_settings.cfg.
#   window: windowed/fullscreen and window size in real pixels (up to 3840x2160 / 4K)
#   render_scale: 3D render resolution (0.5..1.0), UI and labels always stay sharp
#   msaa: 3D anti-aliasing (0 off, 1 = 2x, 2 = 4x)
#   text_size: menu/HUD text size; 1.0 = TEXT_BASE of the automatic size
#   label_size: size of the names/status above characters and buildings on the map
#   zoom: map zoom (camera size; smaller = closer)

const PATH = "user://outpost_zero_settings.cfg"
const WINDOW_SIZES = [
	Vector2i(1280, 720), Vector2i(1920, 1080), Vector2i(2560, 1440), Vector2i(3200, 1800), Vector2i(3840, 2160)
]
const RENDER_SCALES = [0.5, 0.67, 0.75, 1.0]
const TEXT_SIZES = [0.7, 0.8, 0.9, 1.0, 1.2]
const TEXT_DEFAULT = 0.8
const LABEL_SIZES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
const LABEL_DEFAULT = 0.6
# Text size scale. 100% is two steps below the earlier "Small" (0.8 x 0.85 x 0.85 of the
# original layout); the default is 80%, two steps smaller again.
const TEXT_BASE = 0.58
const ZOOM_MIN = 12.0
const ZOOM_MAX = 72.0
const ZOOM_DEFAULT = 44.0  # the whole 44-unit map, seen diagonally

var fullscreen = false
var window_size = Vector2i(1920, 1080)
var render_scale = 1.0
var msaa = 1
var text_size = TEXT_DEFAULT
var label_size = LABEL_DEFAULT
var zoom = ZOOM_DEFAULT
var has_saved_window = false
var path = PATH  # overridable with --settings-file=... (used by automated captures)


func _init():
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--settings-file="):
			path = arg.substr(16)


func load_settings():
	var cfg = ConfigFile.new()
	if cfg.load(path) != OK:
		return
	fullscreen = cfg.get_value("display", "fullscreen", fullscreen)
	window_size = cfg.get_value("display", "window_size", window_size)
	has_saved_window = cfg.has_section_key("display", "window_size")
	render_scale = cfg.get_value("display", "render_scale", render_scale)
	msaa = cfg.get_value("display", "msaa", msaa)
	text_size = clampf(cfg.get_value("display", "text_size", text_size), TEXT_SIZES[0], TEXT_SIZES[-1])
	label_size = clampf(cfg.get_value("display", "label_size", label_size), LABEL_SIZES[0], LABEL_SIZES[-1])
	zoom = cfg.get_value("map", "zoom", zoom)
	# Files saved by the first settings version stored the window in screen points and the
	# text as "ui_size" (relative to the original layout). Convert once.
	# (Not in headless runs: they can't see the screen scale.)
	if (
		cfg.has_section_key("display", "ui_size")
		and not cfg.has_section_key("display", "text_size")
		and DisplayServer.get_name() != "headless"
	):
		var scale = DisplayServer.screen_get_scale(DisplayServer.window_get_current_screen())
		window_size = Vector2i(Vector2(window_size) * scale)
		text_size = TEXT_DEFAULT
		save_settings()


func save_settings():
	if DisplayServer.get_name() == "headless":
		return  # automated/headless runs never touch the player's settings
	var cfg = ConfigFile.new()
	cfg.set_value("display", "fullscreen", fullscreen)
	cfg.set_value("display", "window_size", window_size)
	cfg.set_value("display", "render_scale", render_scale)
	cfg.set_value("display", "msaa", msaa)
	cfg.set_value("display", "text_size", text_size)
	cfg.set_value("display", "label_size", label_size)
	cfg.set_value("map", "zoom", zoom)
	cfg.save(path)


func apply_window():
	if DisplayServer.get_name() == "headless":
		return
	if fullscreen:
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN)
		return
	if DisplayServer.window_get_mode() != DisplayServer.WINDOW_MODE_WINDOWED:
		DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
	# `-- --window=x,y,w,h` places this window (in pixels), e.g. two team windows side by side.
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--window="):
			var n = arg.trim_prefix("--window=").split(",")
			if n.size() == 4:
				DisplayServer.window_set_size(Vector2i(int(n[2]), int(n[3])))
				DisplayServer.window_set_position(Vector2i(int(n[0]), int(n[1])))
				return
	var screen = DisplayServer.window_get_current_screen()
	var px = window_size
	var usable = DisplayServer.screen_get_usable_rect(screen)
	px = px.min(usable.size)
	DisplayServer.window_set_size(px)
	DisplayServer.window_set_position(usable.position + (usable.size - px) / 2)


func apply_render(viewport: Viewport):
	viewport.scaling_3d_scale = render_scale
	viewport.msaa_3d = [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X][clampi(msaa, 0, 2)]


func clamp_zoom(value: float) -> float:
	return clampf(value, ZOOM_MIN, ZOOM_MAX)
