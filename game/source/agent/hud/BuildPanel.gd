extends PanelContainer

# Build mode: lay out the base and manage characters. Every edit is sent to the adapter
# (which validates, saves and creates the matching Hermes agents) and comes back as a
# layout update, so the map and this panel always show what's real.

signal command(cmd)  # layout.* command for the adapter
signal place(kind, payload, label_text)  # ask the map for a click position

const Departments = preload("res://source/agent/Departments.gd")
# Departments a player's building can join (Command is the Command Centre and Approval only).
const CAPABILITIES = [["Research", "research"], ["Engineering", "code"], ["Knowledge", "knowledge"], ["Commons", "meeting"]]
# Models that look the part for each department, offered first.
const SUGGESTED = {
	"research": ["lander_A", "lander_B", "GeodesicDome", "SolarPanelStructure", "solarpanel", "satelliteDish_large", "satelliteDish_detailed", "satelliteDish", "AircraftFactory", "Rocket"],
	"code": ["cargodepot_A", "cargodepot_B", "cargodepot_C", "drill_structure", "structure_tall", "basemodule_garage", "windturbine_tall", "BuildingL", "VehicleFactory", "machine_generatorLarge"],
	"knowledge": ["basemodule_A", "basemodule_B", "basemodule_C", "basemodule_D", "basemodule_E", "HouseCylinder", "HouseLong", "hangar_roundGlass", "hangar_roundA"],
	"meeting": ["landingpad_large", "structure_low", "containers_A", "BaseLarge", "HouseSingle", "structure_detailed", "gate_simple", "gate_complex", "AntiGroundTurret"],
}
const SKILLS = [["Web research", "web"], ["Thinking only", "reasoning"]]
const SKILL_TEXT = {"web": "Web research", "reasoning": "Thinking", "code": "Code sandbox", "orchestrator": "Orchestrator"}
const BUILDING_MODELS = [
	"satelliteDish_large", "satelliteDish_detailed", "hangar_largeA", "hangar_largeB", "hangar_roundA",
	"hangar_roundB", "hangar_roundGlass", "hangar_smallA", "hangar_smallB", "gate_complex", "gate_simple",
	"structure", "structure_detailed", "structure_closed", "machine_generatorLarge", "machine_barrelLarge",
	"rocket_baseA", "turret_double",
	"VehicleFactory", "AircraftFactory", "AntiGroundTurret", "AntiAirTurret", "turret_single", "satelliteDish",
	"structure_diagonal", "machine_generator", "machine_wireless", "machine_wirelessCable", "machine_barrel", "Rocket",
	"basemodule_A", "basemodule_B", "basemodule_C", "basemodule_D", "basemodule_E", "basemodule_garage",
	"cargodepot_A", "cargodepot_B", "cargodepot_C", "drill_structure", "lander_A", "lander_B",
	"landingpad_large", "structure_low", "structure_tall", "windturbine_tall", "containers_A", "solarpanel",
	"GeodesicDome", "BaseLarge", "BuildingL", "HouseCylinder", "HouseLong", "HouseSingle", "SolarPanelStructure",
]
const VEHICLE_MODELS = [
	"rover", "craft_speederA", "craft_speederB", "craft_speederC", "craft_speederD", "craft_racer",
	"craft_miner", "craft_cargoA", "craft_cargoB", "astronautA", "astronautB", "alien",
	"Tank", "MonorailTrain",
	"Astronaut_A", "Astronaut_B", "Astronaut_C", "Mech_A", "Mech_B", "Mech_C", "Mech_D",
	"EnemyLarge", "EnemySmall", "EnemyFlying", "Rover_A", "RoundRover",
]
const PALETTE = ["#59ccff", "#ffe04d", "#8cf280", "#ff9940", "#ff80bf", "#d98cff", "#ff5c5c", "#e6e6e6"]

var hud  # AgentHUD (styling helpers)
var _layout = {}
var _tab = "buildings"
var _form = null  # {kind: "building"|"agent", data: {...}, editing: bool}
var _body: VBoxContainer
var _tab_buttons = {}
var _reset_armed = false
var _terrain = "mars"


func setup(owner_hud):
	hud = owner_hud
	var sb = StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.09, 0.15, 0.96)
	sb.border_color = Color(0.35, 0.55, 0.85, 0.35)
	sb.set_border_width_all(1)
	sb.set_corner_radius_all(8)
	sb.content_margin_left = 14
	sb.content_margin_right = 14
	sb.content_margin_top = 10
	sb.content_margin_bottom = 12
	add_theme_stylebox_override("panel", sb)
	mouse_filter = MOUSE_FILTER_STOP
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	add_child(v)
	var head = HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	var title = hud._label("BUILD", 14, hud.ACCENT)
	title.size_flags_horizontal = SIZE_EXPAND_FILL
	head.add_child(title)
	var reset = _small("Reset base")
	reset.pressed.connect(func(): _on_reset(reset))
	head.add_child(reset)
	var close = _small("Close")
	close.pressed.connect(func(): hud._switch_tab("mission"))
	head.add_child(close)
	v.add_child(head)
	var tabs = HBoxContainer.new()
	tabs.add_theme_constant_override("separation", 6)
	for t in [["Buildings", "buildings"], ["Characters", "agents"], ["Terrain", "terrain"]]:
		var b = _small(t[0])
		var key = t[1]
		b.pressed.connect(_switch_tab.bind(key))
		tabs.add_child(b)
		_tab_buttons[key] = b
	v.add_child(tabs)
	var scroll = ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(430, 700)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(scroll)
	_body = VBoxContainer.new()
	_body.add_theme_constant_override("separation", 8)
	_body.size_flags_horizontal = SIZE_EXPAND_FILL
	scroll.add_child(_body)
	_render()


func set_layout(layout: Dictionary):
	_layout = layout
	# An edit that succeeded closes its form; a failed one keeps it open with the error.
	if _form != null and _form.get("sent", false):
		_form = null
	_render()


func form_failed():
	if _form != null:
		_form["sent"] = false


# ------------------------------------------------------------------ rendering


func _render():
	if _body == null:
		return
	for c in _body.get_children():
		c.queue_free()
	for key in _tab_buttons:
		_paint(_tab_buttons[key], key == _tab)
	if _form != null:
		if _form["kind"] == "building":
			_render_building_form()
		else:
			_render_agent_form()
		return
	if _tab == "buildings":
		_render_buildings()
	elif _tab == "agents":
		_render_agents()
	else:
		_render_terrain()


func _render_buildings():
	var organise = hud._button("Organise base", true)
	organise.tooltip_text = "Move every building into its department's district"
	organise.pressed.connect(func(): command.emit({"type": "layout.organise"}))
	_body.add_child(organise)
	_body.add_child(_hint("Each department has its own district on the map. New buildings go into theirs; Organise tidies everything back into place."))
	for dept in Departments.ORDER:
		var items = _layout.get("buildings", []).filter(func(b): return Departments.of(b["capability"]) == dept)
		var spots = _layout.get("spots", []) if dept == "meeting" else []
		if items.is_empty() and spots.is_empty():
			continue
		_dept_header(dept, "%d building%s" % [items.size(), "" if items.size() == 1 else "s"])
		for b in items:
			var row = _row(Departments.COLORS[dept], b["label"], _residents(b["id"]))
			var move = _small("Move")
			var def = b
			move.pressed.connect(func(): place.emit("move", {"id": def["id"]}, def["label"]))
			row.add_child(move)
			var edit = _small("Edit")
			edit.pressed.connect(func(): _open_building_form(def))
			row.add_child(edit)
			if not (b["id"] in ["command_centre", "human_approval"]):
				var del = _small("Remove")
				del.pressed.connect(func(): command.emit({"type": "layout.building.remove", "id": def["id"]}))
				row.add_child(del)
		for sp in spots:
			var col = Color(1.0, 0.82, 0.35) if sp["id"] == "rally_point" else Color(1.0, 0.4, 0.4)
			var row = _row(col, sp["label"], "Agents waiting" if sp["id"] == "rally_point" else "Agents after an error")
			var move = _small("Move")
			var spot = sp
			move.pressed.connect(func(): place.emit("spot", {"id": spot["id"]}, spot["label"]))
			row.add_child(move)
	var add = hud._button("+ New building", true)
	add.pressed.connect(func(): _open_building_form(null))
	_body.add_child(add)
	_body.add_child(_hint("Agents drive to a building of the department whose work matches the tool they use, preferring their own home."))


# Who lives in a building (characters whose home it is).
func _residents(building_id: String) -> String:
	var names = []
	for a in _layout.get("agents", []):
		if a.get("home", "") == building_id:
			names.append(a["name"])
	return ("Home of " + ", ".join(names)) if not names.is_empty() else "No residents"


func _dept_header(dept: String, extra: String):
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var bar = ColorRect.new()
	bar.color = Departments.COLORS[dept]
	bar.custom_minimum_size = Vector2(4, 30)
	row.add_child(bar)
	var text = VBoxContainer.new()
	text.add_theme_constant_override("separation", 0)
	text.add_child(hud._label("%s  ·  %s" % [Departments.NAMES[dept].to_upper(), extra], 13, Departments.COLORS[dept].lightened(0.2)))
	text.add_child(hud._label(Departments.WORK[dept], 12, hud.MUTED))
	row.add_child(text)
	var spacer = Control.new()
	spacer.custom_minimum_size = Vector2(0, 4)
	_body.add_child(spacer)
	_body.add_child(row)


func _render_agents():
	for dept in Departments.ORDER:
		var members = _layout.get("agents", []).filter(func(a): return Departments.of_building(_layout, a.get("home", "command_centre")) == dept)
		if members.is_empty():
			continue
		_dept_header(dept, "%d agent%s" % [members.size(), "" if members.size() == 1 else "s"])
		for a in members:
			var sub = SKILL_TEXT.get(a["skill"], "") + " · lives at " + _building_label(a["home"])
			var row = _row(Color.html(a["color"]), a["name"], sub)
			var def = a
			var edit = _small("Edit")
			edit.pressed.connect(func(): _open_agent_form(def))
			row.add_child(edit)
			if not a.get("builtin", false):
				var del = _small("Remove")
				del.pressed.connect(func(): command.emit({"type": "layout.agent.remove", "id": def["id"]}))
				row.add_child(del)
	var add = hud._button("+ New character", true)
	add.pressed.connect(func(): _open_agent_form(null))
	_body.add_child(add)
	_body.add_child(_hint("New characters are real Hermes agents: the Commander can give them work in the next mission."))


func set_terrain(id: String):
	_terrain = id
	if _tab == "terrain":
		_render()


func _render_terrain():
	const Terrains = preload("res://source/agent/Terrains.gd")
	for group in ["Earth", "Planets"]:
		_body.add_child(_field_label("On Earth" if group == "Earth" else "Other worlds"))
		var flow = HFlowContainer.new()
		flow.add_theme_constant_override("h_separation", 6)
		flow.add_theme_constant_override("v_separation", 6)
		for id in Terrains.ORDER:
			var t = Terrains.PRESETS[id]
			if t["group"] != group:
				continue
			flow.add_child(_terrain_button(id, t))
		_body.add_child(flow)
	_body.add_child(_hint("Terrain only changes the ground and light; it can change at any time, even mid-mission."))


func _terrain_button(id: String, t: Dictionary) -> Button:
	var b = _small(t["name"])
	b.custom_minimum_size = Vector2(130, 34)
	b.icon = _swatch_icon(t["swatch"][0], t["swatch"][1])
	_paint(b, id == _terrain)
	b.pressed.connect(func(): command.emit({"type": "layout.terrain", "terrain": id}))
	return b


static func _swatch_icon(a: Color, c: Color) -> ImageTexture:
	var img = Image.create(16, 16, false, Image.FORMAT_RGBA8)
	img.fill(a)
	img.fill_rect(Rect2i(10, 0, 6, 16), c)
	return ImageTexture.create_from_image(img)


func _open_building_form(def):
	if def == null:
		_form = {"kind": "building", "editing": false, "data": {"label": "", "capability": "research", "model": "satelliteDish_large"}}
	else:
		_form = {"kind": "building", "editing": true, "data": def.duplicate()}
	_render()


func _open_agent_form(def):
	if def == null:
		var home = "command_centre"
		for b in _layout.get("buildings", []):
			if b["capability"] == "research":
				home = b["id"]
				break
		_form = {"kind": "agent", "editing": false, "data": {"name": "", "job": "", "skill": "web", "model": "craft_speederC", "color": PALETTE[2], "home": home}}
	else:
		_form = {"kind": "agent", "editing": true, "data": def.duplicate()}
	_render()


func _render_building_form():
	var d = _form["data"]
	var builtin = d.get("builtin", false)
	_body.add_child(hud._label(("Edit " + d["label"]) if _form["editing"] else "New building", 16))
	_body.add_child(_field_label("Name"))
	var name_edit = _line(d.get("label", ""), "e.g. Market Intel Centre")
	name_edit.text_changed.connect(func(t): d["label"] = t)
	_body.add_child(name_edit)
	var dept = Departments.of(d["capability"])
	if not builtin:
		_body.add_child(_field_label("Department"))
		_body.add_child(_chips(CAPABILITIES, d["capability"], _set_and_render.bind(d, "capability")))
	_body.add_child(_hint(Departments.NAMES[dept] + ": " + Departments.WORK[dept] + ("" if not builtin else " (built-in)") + ". Buildings take their department's colour."))
	var suggested = SUGGESTED.get(dept, [])
	var picks = []
	var others = []
	for m in BUILDING_MODELS:
		(picks if m in suggested else others).append([m.replace("_", " "), m])
	if not picks.is_empty():
		_body.add_child(_field_label("Model: suggested for " + Departments.NAMES[dept]))
		_body.add_child(_chips(picks, d["model"], _set_and_render.bind(d, "model")))
	_body.add_child(_field_label("Other models" if not picks.is_empty() else "Model"))
	_body.add_child(_chips(others, d["model"], _set_and_render.bind(d, "model")))
	var actions = HBoxContainer.new()
	actions.add_theme_constant_override("separation", 8)
	if _form["editing"]:
		var save = hud._button("Save", true)
		# auto: a building that changes department moves to its new district.
		save.pressed.connect(func(): _send({"type": "layout.building.upsert", "building": _pick(d, ["id", "label", "capability", "model"]).merged({"auto": true})}))
		actions.add_child(save)
	else:
		var addb = hud._button("Add to district", true)
		addb.tooltip_text = "Put it in the next free slot of its department's district"
		addb.pressed.connect(
			func():
				if d["label"].strip_edges() == "":
					hud.show_error("Give the building a name first.")
					return
				_send({"type": "layout.building.upsert", "building": _pick(d, ["label", "capability", "model"])})
		)
		actions.add_child(addb)
		var placeb = hud._button("Choose spot")
		placeb.pressed.connect(
			func():
				if d["label"].strip_edges() == "":
					hud.show_error("Give the building a name first.")
					return
				_form["sent"] = true
				place.emit("building", _pick(d, ["label", "capability", "model"]), d["label"])
		)
		actions.add_child(placeb)
	var cancel = hud._button("Cancel")
	cancel.pressed.connect(_close_form)
	actions.add_child(cancel)
	_body.add_child(actions)


func _render_agent_form():
	var d = _form["data"]
	var builtin = d.get("builtin", false)
	_body.add_child(hud._label(("Edit " + d["name"]) if _form["editing"] else "New character", 16))
	_body.add_child(_field_label("Name"))
	var name_edit = _line(d.get("name", ""), "e.g. Market Watcher")
	name_edit.text_changed.connect(func(t): d["name"] = t)
	_body.add_child(name_edit)
	_body.add_child(_field_label("Job (what this agent does)"))
	if builtin:
		_body.add_child(_hint(d.get("job", "")))
	else:
		var job = TextEdit.new()
		job.text = d.get("job", "")
		job.placeholder_text = "e.g. Tracks competitor pricing and product launches, and reports changes with sources."
		job.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
		job.custom_minimum_size = Vector2(0, 84)
		job.add_theme_font_size_override("font_size", 14)
		job.text_changed.connect(func(): d["job"] = job.text)
		_body.add_child(job)
		_body.add_child(_field_label("Skill"))
		_body.add_child(_chips(SKILLS, d["skill"], _set_and_render.bind(d, "skill")))
	_body.add_child(_field_label("Vehicle"))
	var vehicles = []
	for m in VEHICLE_MODELS:
		vehicles.append([m.replace("craft_", "").replace("_", " "), m])
	_body.add_child(_chips(vehicles, d["model"], _set_and_render.bind(d, "model")))
	_body.add_child(_field_label("Colour"))
	_body.add_child(_swatches(d["color"], _set_and_render.bind(d, "color")))
	_body.add_child(_field_label("Home building (decides the department)"))
	for dept in Departments.ORDER:
		var homes = []
		for b in _layout.get("buildings", []):
			if Departments.of(b["capability"]) == dept:
				homes.append([b["label"], b["id"]])
		if homes.is_empty():
			continue
		_body.add_child(hud._label(Departments.NAMES[dept], 12, Departments.COLORS[dept].lightened(0.2)))
		_body.add_child(_chips(homes, d["home"], _set_and_render.bind(d, "home")))
	var actions = HBoxContainer.new()
	actions.add_theme_constant_override("separation", 8)
	var save = hud._button("Save" if _form["editing"] else "Create character", true)
	save.pressed.connect(func(): _send({"type": "layout.agent.upsert", "agent": _pick(d, ["id", "name", "job", "skill", "model", "color", "home"])}))
	actions.add_child(save)
	var cancel = hud._button("Cancel")
	cancel.pressed.connect(_close_form)
	actions.add_child(cancel)
	_body.add_child(actions)


# ------------------------------------------------------------------ helpers


func _switch_tab(key: String):
	_tab = key
	_form = null
	_render()


func _close_form():
	_form = null
	_render()


# Chip/swatch callbacks: Callable.bind appends (d, key) after the picked value.
func _set_and_render(value, d: Dictionary, key: String):
	d[key] = value
	_render()


func _disarm_reset(button: Button):
	_reset_armed = false
	if is_instance_valid(button):
		button.text = "Reset base"


func _send(cmd: Dictionary):
	_form["sent"] = true
	command.emit(cmd)


static func _pick(d: Dictionary, keys: Array) -> Dictionary:
	var out = {}
	for k in keys:
		if d.has(k):
			out[k] = d[k]
	return out


func _building_label(id):
	for b in _layout.get("buildings", []):
		if b["id"] == id:
			return b["label"]
	return id


func _on_reset(button: Button):
	if not _reset_armed:
		_reset_armed = true
		button.text = "Confirm reset"
		get_tree().create_timer(3.0).timeout.connect(_disarm_reset.bind(button))
		return
	_reset_armed = false
	button.text = "Reset base"
	command.emit({"type": "layout.reset"})


func _row(color: Color, title: String, subtitle: String) -> HBoxContainer:
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var swatch = ColorRect.new()
	swatch.color = color
	swatch.custom_minimum_size = Vector2(10, 10)
	swatch.size_flags_vertical = SIZE_SHRINK_CENTER
	row.add_child(swatch)
	var text = VBoxContainer.new()
	text.size_flags_horizontal = SIZE_EXPAND_FILL
	text.add_theme_constant_override("separation", 0)
	var t = hud._label(title, 15)
	t.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	text.add_child(t)
	var s = hud._label(subtitle, 12, hud.MUTED)
	s.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	text.add_child(s)
	row.add_child(text)
	_body.add_child(row)
	return row


func _small(text: String) -> Button:
	var b = hud._button(text)
	b.custom_minimum_size = Vector2(0, 28)
	b.add_theme_font_size_override("font_size", 13)
	return b


func _field_label(text: String) -> Label:
	return hud._label(text, 13, hud.MUTED)


func _hint(text: String) -> Label:
	var l = hud._label(text, 12, hud.MUTED)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(400, 0)
	return l


func _line(value: String, placeholder: String) -> LineEdit:
	var e = LineEdit.new()
	e.text = value
	e.placeholder_text = placeholder
	e.custom_minimum_size = Vector2(0, 32)
	e.add_theme_font_size_override("font_size", 15)
	return e


func _chips(options: Array, current, on_pick: Callable) -> HFlowContainer:
	var flow = HFlowContainer.new()
	flow.add_theme_constant_override("h_separation", 6)
	flow.add_theme_constant_override("v_separation", 6)
	for opt in options:
		var b = _small(opt[0])
		var value = opt[1]
		_paint(b, value == current)
		b.pressed.connect(func(): on_pick.call(value))
		flow.add_child(b)
	return flow


func _swatches(current: String, on_pick: Callable) -> HFlowContainer:
	var flow = HFlowContainer.new()
	flow.add_theme_constant_override("h_separation", 6)
	for hex in PALETTE:
		var b = Button.new()
		b.custom_minimum_size = Vector2(30, 30)
		b.focus_mode = FOCUS_NONE
		var sb = StyleBoxFlat.new()
		sb.bg_color = Color.html(hex)
		sb.set_corner_radius_all(6)
		sb.set_border_width_all(3 if hex.to_lower() == current.to_lower() else 0)
		sb.border_color = Color.WHITE
		b.add_theme_stylebox_override("normal", sb)
		b.add_theme_stylebox_override("hover", sb)
		b.add_theme_stylebox_override("pressed", sb)
		var value = hex
		b.pressed.connect(func(): on_pick.call(value))
		flow.add_child(b)
	return flow


func _paint(b: Button, on: bool):
	var sb = (b.get_theme_stylebox("normal") as StyleBoxFlat).duplicate()
	sb.bg_color = Color(0.2, 0.45, 0.85) if on else Color(0.16, 0.2, 0.3)
	b.add_theme_stylebox_override("normal", sb)
