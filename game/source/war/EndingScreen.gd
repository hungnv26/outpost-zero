extends CanvasLayer

# The ending of an Outpost War battle (docs/outpost-war.md), shown over the frozen final scene: who
# won and how, the game time, and each side's units and buildings left, with each AI model's turns,
# tokens and orders when the battle service has sent them (battle.summary). Built in code; plain
# panel, team colours only on the names.

const TEAM_COLORS = {
	"blue": Color("66b1ff"), "red": Color("ff5c73"), "green": Color("a5ff99"), "purple": Color("ed85ff"),
	"darkgreen": Color("3fa34d"), "khaki": Color("bdb76b"), "navy": Color("6f7fe0"), "turquoise": Color("48d1cc"),
}

var _rows: GridContainer = null
var _result: Dictionary = {}
var _battle: Dictionary = {}
var _commanders = {}  # colour -> stats from the battle service


func show_result(result: Dictionary, battle: Dictionary):
	_result = result
	_battle = battle
	layer = 50
	process_mode = Node.PROCESS_MODE_ALWAYS
	var shade = ColorRect.new()
	shade.color = Color(0, 0, 0, 0.55)
	shade.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(shade)
	var center = CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	var panel = PanelContainer.new()
	var style = StyleBoxFlat.new()
	style.bg_color = Color(0.09, 0.1, 0.11, 0.94)
	style.border_color = Color(1, 1, 1, 0.12)
	style.set_border_width_all(1)
	style.set_corner_radius_all(6)
	style.set_content_margin_all(36)
	panel.add_theme_stylebox_override("panel", style)
	center.add_child(panel)
	var box = VBoxContainer.new()
	box.add_theme_constant_override("separation", 14)
	panel.add_child(box)

	var winner = str(result.get("winner")) if result.get("winner") != null else ""
	var title = _label("%s WINS" % _name(winner).to_upper() if winner != "" else "NO WINNER", 46)
	if winner != "":
		title.add_theme_color_override("font_color", TEAM_COLORS.get(winner, Color.WHITE))
	box.add_child(title)
	if winner != "":
		box.add_child(_label(_played_by(winner), 22, Color(0.85, 0.85, 0.85)))
	var minutes = int(result.get("gameTimeS", 0)) / 60
	var seconds = int(result.get("gameTimeS", 0)) % 60
	var field = battle.get("field")
	var where = str(battle.get("mapName", ""))
	if field is Dictionary and field.has("name"):
		where += ", " + str(field["name"])
	box.add_child(_label("%s · %d:%02d of game time · %s" % [_reason(str(result.get("reason", ""))), minutes, seconds, where], 17, Color(0.7, 0.7, 0.7)))
	box.add_child(HSeparator.new())
	_rows = GridContainer.new()
	_rows.add_theme_constant_override("h_separation", 28)
	_rows.add_theme_constant_override("v_separation", 8)
	box.add_child(_rows)
	_fill_rows()


# The models' figures, sent by the battle service once the battle is over.
func set_commanders(list: Array):
	for c in list:
		if c is Dictionary:
			_commanders[str(c.get("color", ""))] = c
	if _rows != null:
		_fill_rows()


func _fill_rows():
	for c in _rows.get_children():
		c.queue_free()
	var with_models = not _commanders.is_empty()
	var headers = ["Side", "Played by", "Units", "Buildings"]
	if with_models:
		headers += ["Turns", "Tokens", "Orders"]
	_rows.columns = headers.size()
	for h in headers:
		_rows.add_child(_label(h.to_upper(), 13, Color(0.6, 0.6, 0.6), HORIZONTAL_ALIGNMENT_LEFT))
	for p in _result.get("players", []):
		var color = str(p.get("color", ""))
		var name = _label(_name(color), 19, TEAM_COLORS.get(color, Color.WHITE), HORIZONTAL_ALIGNMENT_LEFT)
		_rows.add_child(name)
		_rows.add_child(_label(_player_label(color), 19, Color.WHITE, HORIZONTAL_ALIGNMENT_LEFT))
		_rows.add_child(_label(str(p.get("units", 0)), 19, Color.WHITE, HORIZONTAL_ALIGNMENT_LEFT))
		var buildings = int(p.get("structures", 0))
		_rows.add_child(_label(str(buildings) if buildings > 0 else "none left", 19, Color.WHITE if buildings > 0 else Color(0.7, 0.45, 0.45), HORIZONTAL_ALIGNMENT_LEFT))
		if with_models:
			var c = _commanders.get(color, {})
			_rows.add_child(_label(str(int(c.get("turns", 0))) if not c.is_empty() else "", 19, Color.WHITE, HORIZONTAL_ALIGNMENT_LEFT))
			_rows.add_child(_label("%dk" % int(round(float(c.get("tokens", 0)) / 1000.0)) if not c.is_empty() else "", 19, Color.WHITE, HORIZONTAL_ALIGNMENT_LEFT))
			_rows.add_child(_label("%d (%d refused)" % [int(c.get("orders", 0)), int(c.get("refused", 0))] if not c.is_empty() else "", 19, Color.WHITE, HORIZONTAL_ALIGNMENT_LEFT))


func _player_label(color: String) -> String:
	for p in _battle.get("players", []):
		if str(p.get("color", "")) == color:
			match str(p.get("controller", "")):
				"model":
					return str(p.get("model", "AI model"))
				"human":
					return "You"
				_:
					return "Scripted computer player"
	return ""


func _played_by(color: String) -> String:
	var who = _player_label(color)
	return who if who != "" else ""


static func _name(color: String) -> String:
	return "dark green" if color == "darkgreen" else color


static func _reason(reason: String) -> String:
	if reason == "one player left":
		return "Last side with buildings standing"
	if reason.begins_with("time limit"):
		return "Ahead on army and building value at the time limit"
	return reason.capitalize() if reason != "" else ""


static func _label(text: String, size: int, color := Color.WHITE, align := HORIZONTAL_ALIGNMENT_CENTER) -> Label:
	var l = Label.new()
	l.text = text
	l.horizontal_alignment = align
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l
