extends Control

# Outpost War's intro, in place of the Godot logo (docs/outpost-war.md): about 3.5 seconds. Dark,
# then OUTPOST WAR fades in large over the menu's own desert backdrop with a low boom, a line draws
# out under it, the tagline follows, and it all fades into the menu (same backdrop, no jump).
# A click or key skips it; so does a battle arriving (BattleClient calls skip()).

const BACKGROUND = "res://source/main-menu/Background.tscn"
const BOOM = "res://assets/sfx/explosion_large.wav"
const TITLE = "OUTPOST WAR"
const TAGLINE = "AI COMMANDERS  ·  REAL-TIME WAR"

var _cover: ColorRect
var _title: Label
var _line: ColorRect
var _tagline: Label
var _tween: Tween
var _leaving = false


func _ready():
	name = "WarIntro"
	process_mode = Node.PROCESS_MODE_ALWAYS
	# The intro scene's root has no size of its own: cover the whole window directly.
	top_level = true
	position = Vector2.ZERO
	size = get_viewport_rect().size
	get_viewport().size_changed.connect(func(): size = get_viewport_rect().size)
	mouse_filter = Control.MOUSE_FILTER_STOP
	var background = load(BACKGROUND).instantiate()
	add_child(background)
	_cover = ColorRect.new()
	_cover.color = Color(0.03, 0.035, 0.035, 1.0)
	_cover.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(_cover)

	var middle = CenterContainer.new()
	middle.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(middle)
	var column = VBoxContainer.new()
	column.alignment = BoxContainer.ALIGNMENT_CENTER
	column.add_theme_constant_override("separation", 18)
	middle.add_child(column)
	_title = _label(TITLE, 96, Color(0.95, 0.94, 0.9))
	_title.add_theme_constant_override("outline_size", 0)
	column.add_child(_title)
	var holder = CenterContainer.new()
	holder.custom_minimum_size = Vector2(0, 3)
	column.add_child(holder)
	_line = ColorRect.new()
	_line.color = Color(0.82, 0.48, 0.31)  # the warm accent of the menu
	_line.custom_minimum_size = Vector2(0, 3)
	holder.add_child(_line)
	_tagline = _label(TAGLINE, 22, Color(0.78, 0.76, 0.72))
	column.add_child(_tagline)
	_spaced(_title, 10)
	_spaced(_tagline, 4)
	_title.modulate.a = 0.0
	_tagline.modulate.a = 0.0
	_title.pivot_offset = Vector2(0, 0)
	_play()


func _play():
	_title.scale = Vector2(1.04, 1.04)
	_tween = create_tween().set_parallel(true)
	# 0.0 to 0.9 s: the title arrives with the boom; the cover lifts to show the backdrop.
	_tween.tween_property(_title, "modulate:a", 1.0, 0.9).set_delay(0.15).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	_tween.tween_property(_title, "scale", Vector2.ONE, 1.2).set_delay(0.15).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	_tween.tween_property(_cover, "color:a", 0.6, 1.4).set_delay(0.3)
	_tween.tween_callback(_boom).set_delay(0.15)
	# 0.6 to 1.3 s: the line draws out under the title.
	_tween.tween_property(_line, "custom_minimum_size:x", 520.0, 0.7).set_delay(0.6).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	# 1.2 s: the tagline.
	_tween.tween_property(_tagline, "modulate:a", 1.0, 0.6).set_delay(1.2)
	# 2.9 s: fade into the menu.
	_tween.tween_callback(skip).set_delay(2.9)
	_center_title.call_deferred()


func _center_title():
	_title.pivot_offset = _title.size / 2.0


func _boom():
	var stream = AudioStreamWAV.load_from_file(BOOM)
	if stream == null:
		return
	var player = AudioStreamPlayer.new()
	player.stream = stream
	player.volume_db = -8.0
	add_child(player)
	player.play()


# Fades out and leaves; the intro scene then opens the menu.
func skip():
	if _leaving:
		return
	_leaving = true
	if _tween != null and _tween.is_valid():
		_tween.kill()
	var out = create_tween().set_parallel(true)
	out.tween_property(_title, "modulate:a", 0.0, 0.45)
	out.tween_property(_tagline, "modulate:a", 0.0, 0.45)
	out.tween_property(_line, "modulate:a", 0.0, 0.45)
	out.tween_property(_cover, "color:a", 0.0, 0.45)
	out.chain().tween_callback(queue_free)


func _gui_input(event):
	if (event is InputEventMouseButton and event.pressed) or (event is InputEventKey and event.pressed):
		skip()


func _unhandled_input(event):
	if event is InputEventKey and event.pressed:
		skip()


# Wider letter spacing, on the theme's own font.
static func _spaced(label: Label, pixels: int):
	var font = FontVariation.new()
	font.base_font = label.get_theme_font("font")
	font.spacing_glyph = pixels
	label.add_theme_font_override("font", font)


static func _label(text: String, size: int, color: Color) -> Label:
	var l = Label.new()
	l.text = text
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l
