extends Control

# Mission HUD, built in code, game style:
#   top bar     tabs (Mission, Departments, Build, Settings), tokens, cost, connection, clock;
#               below it the colony strip: sol clock, speed, power and stocks (economy)
#   left        Missions (new mission, current + recent), the mission's task checklist,
#               activity feed; or the Departments key / Build panel, per tab
#   right       agents with portraits, grouped by department
#   bottom      selected agent (centre) and selected building (right) panels, minimap
#               zoom buttons (left); Human Approval dialog and mission report on top.
# Everything shown comes from the adapter's world state.

signal mission_requested(title)
signal mission_cancel_requested
signal approval_resolved(id, approved)
signal agent_focus_requested(agent_id)
signal building_focus_requested(building_id)
signal department_focus_requested(dept)
signal view_fit_requested
signal replay_requested(mission_id)
signal replay_pause_toggled
signal replay_speed_cycled
signal replay_stop_requested
signal setting_changed(key, value)
signal build_command(cmd)
signal colony_command(cmd)
signal placement_requested(kind, payload, label_text)

const Departments = preload("res://source/agent/Departments.gd")
const Ui = preload("res://source/agent/hud/Ui.gd")
const Icon = preload("res://source/agent/hud/Icon.gd")
const SnapshotsScript = preload("res://source/agent/hud/Snapshots.gd")
const ROLE_COLORS = {
	"commander": Color(0.85, 0.93, 1.0),
	"scout": Color(1.0, 0.88, 0.3),
	"writer": Color(1.0, 0.5, 0.75),
	"researcher": Color(0.35, 0.8, 1.0),
	"coder": Color(1.0, 0.6, 0.25),
	"analyst": Color(0.55, 0.95, 0.5),
	"reviewer": Color(0.85, 0.55, 1.0),
	"approval": Color(1.0, 0.6, 0.2),
}

const BG = Ui.BG
const BG_SOLID = Color(0.06, 0.08, 0.13, 0.97)
const BORDER = Ui.BORDER
const TEXT = Ui.TEXT
const MUTED = Ui.MUTED
const ACCENT = Ui.ACCENT
const STATE_STYLE = preload("res://source/agent/units/Agent.gd").STATE_STYLE
const MISSION_COLORS = {
	"planning": Color(0.75, 0.62, 1.0), "running": Ui.ACCENT, "completed": Ui.GOOD,
	"failed": Ui.BAD, "cancelled": Color(0.55, 0.58, 0.65),
}
const ROW_H = 52.0
const STRIP_H = 30.0
const TOP_H = ROW_H + STRIP_H
const LEFT_W = 350.0
const RIGHT_W = 316.0

var snapshots: Node  # renders portraits and badges (Snapshots.gd); AgentMatch shares it
var model_path_for: Callable  # (model name) -> loadable path, from AgentMatch

var _tokens_label: Label
var _sol_label: Label
var _speed_buttons = {}  # speed -> Button
var _colony = {}  # stat key -> {"value": Label, "trend": Label, "icon": Control}
var _colony_view = {}  # the latest colony view (economy), by the adapter
var _colony_buildings = {}  # building id -> its line in the colony view
var _cost_label: Label
var _conn_label: Label
var _clock_label: Label
var _date_label: Label
var _mc_button: Button
var _tab_buttons = {}
var _tab = "mission"
var _left_mission: PanelContainer
var _left_departments: PanelContainer
var _missions_box: VBoxContainer
var _tasks_box: VBoxContainer
var _tasks_title: Label
var _log_box: VBoxContainer
var _roster: VBoxContainer
var _roster_scroll: ScrollContainer
var _roster_title: Label
var _dept_headers = {}  # department -> {"box": Control, "label": Label}
var _legend_rows = {}  # department -> {"count": Label}
var _mother_row: PanelContainer  # Chapter III+: MOTHER's state and the shutdown control (Sectors tab)
var _mother_label: Label
var _mother_button: Button
var _mother_confirm = false
var _endings_box: VBoxContainer  # Chapter IV+: what each ending still needs
var _endings_rows = []
var _layout = {}
var _cards = {}
var _input: LineEdit
var _deploy: Button
var _abort: Button
var _story_panel: PanelContainer
var _story_title: Label
var _story_text: Label
var _story_actions: HBoxContainer
var _story_shown = ""  # id of the card on screen
var _story_dismissed = ""  # id the player closed
var _arena_panel: PanelContainer
var _arena_rows: VBoxContainer
var _arena_title: Label
var _arena_sub: Label
var _approval_panel: PanelContainer
var _approval_text: Label
var _approval_id = ""
var _result_panel: PanelContainer
var _result_title: Label
var _result_text: RichTextLabel
var _shown_mission_id = ""  # mission whose report the result panel shows
var _history = []  # finished missions from the adapter, newest first
var _agent_panel: PanelContainer
var _agent_view = {}
var _building_panel: PanelContainer
var _building_view = {}
var _selected_building = ""
var _map_buttons: VBoxContainer

var _mc_url = ""
var _replay_panel: PanelContainer
var _replay_title: Label
var _replay_time: Label
var _replay_caption: Label
var _replay_pause: Button
var _replay_speed: Button
var _replay_report: Button
var _timeline: Control
var _deferred_result = null  # mission whose report waits for the replay to finish
var replay_active = false
var _settings_panel: PanelContainer
var _chip_groups = {}  # key -> [{button, value}]
var _zoom_slider: HSlider
var _syncing_zoom = false
var settings_ref = null
var _build_panel = null
var _hint_panel: PanelContainer
var _hint_label: Label
var _toast_panel: PanelContainer
var _toast_label: Label
var _toast_until = 0.0
var camera_ref = null
var _mission = null
var _approvals = {}
var _agents = {}
var _tasks = {}
var _selected_agent = ""
var _source = ""
var _clock_tick = 0.0
var _snapshotting = false
var _result_deferred = false  # a finished mission's report waits for its replay
var _shown_mission = {}  # the mission whose report the result panel shows
var _building_sig = ""


func _ready():
	set_anchors_and_offsets_preset(PRESET_FULL_RECT)
	mouse_filter = MOUSE_FILTER_IGNORE
	theme = Ui.theme()
	if snapshots == null:
		snapshots = SnapshotsScript.new()
		add_child(snapshots)
	_build_top_bar()
	_build_arena_panel()
	_build_story_panel()
	_build_mission_panel()
	_build_departments_panel()
	_build_roster()
	_build_agent_panel()
	_build_building_panel()
	_build_map_buttons()
	_build_approval()
	_build_result()
	_build_replay()
	_build_settings()
	_build_build_panel()
	_build_hint_and_toast()
	_switch_tab("mission")


# ---------- public API (driven by AgentMatch) ----------


# The layout is designed for a 1080p-tall window; on bigger screens the whole HUD is
# drawn scaled instead of shrinking to a strip of tiny text.
func set_ui_scale(s: float):
	set_anchors_preset(PRESET_TOP_LEFT)
	position = Vector2.ZERO
	scale = Vector2(s, s)
	size = get_viewport_rect().size / s


func set_connection(online, source = ""):
	if source != "":
		_source = source
	if online:
		_conn_label.text = "● %s" % (_source.to_upper() if _source != "" else "ONLINE")
		_conn_label.add_theme_color_override("font_color", Ui.GOOD)
	else:
		_conn_label.text = "● ADAPTER OFFLINE"
		_conn_label.add_theme_color_override("font_color", Ui.BAD)
	_deploy.disabled = not online


func apply_snapshot(world):
	_source = world.get("source", "")
	_mc_url = world.get("links", {}).get("missionControl", "") if world.get("links", {}).get("missionControl") != null else ""
	_mc_button.visible = _mc_url != ""
	_approvals.clear()
	_history = world.get("history", [])
	_tasks.clear()
	for t in world.get("tasks", []):
		_tasks[t["id"]] = t
	# A finished mission in a (re)connect snapshot isn't news: don't pop its report up.
	_snapshotting = true
	set_mission(world.get("mission"))
	_snapshotting = false
	_render_mission_status()
	# Cards follow the 3D agents (which replay queued states); only create missing ones here.
	for a in world.get("agents", []):
		if not _cards.has(a["id"]):
			set_agent(a)
	for ap in world.get("approvals", []):
		set_approval(ap)
	_refresh_approval()
	_render_agent_panel()
	_render_building_panel()
	set_resources(world.get("resources", {}))
	for child in _log_box.get_children():
		child.queue_free()
	var log_lines = world.get("log", [])
	for i in range(max(0, log_lines.size() - 5), log_lines.size()):
		add_log(log_lines[i])


func set_agent(a):
	_agents[a["id"]] = a
	if not _cards.has(a["id"]):
		_cards[a["id"]] = _make_card(a)
		_regroup_roster()
	var card = _cards[a["id"]]
	card.faction.text = _faction_text(a["id"])
	var style = STATE_STYLE.get(a.get("state", "idle"), STATE_STYLE["idle"])
	card.state.text = style["text"].capitalize()
	card.state.add_theme_color_override("font_color", style["color"])
	var task = a.get("taskTitle")
	card.task.text = task if task != null and task != "" else _idle_line(a)
	_set_progress(card.bar, a)
	if a["id"] == _selected_agent:
		_render_agent_panel()
	if _selected_building != "":
		_render_building_panel()


# "MOTHER's" or "independent" once the machines have split (Chapter III); nothing for yours.
func _faction_text(agent_id: String) -> String:
	var chapter = str(_colony_view.get("story", {}).get("chapter", "I"))
	if chapter != "III" and chapter != "IV":
		return ""
	var f = str(_colony_view.get("machines", {}).get("factionOf", {}).get(agent_id, "yours"))
	return "MOTHER's" if f == "mother" else ("independent" if f == "independent" else "")


func _update_faction_tags():
	for id in _cards:
		_cards[id].faction.text = _faction_text(id)


func set_task(t):
	_tasks[t["id"]] = t
	_render_mission_status()


func set_mission(m):
	var prev_status = _mission.get("status", "") if _mission != null else ""
	var prev_id = _mission.get("id", "") if _mission != null else ""
	if m != null and m.get("id", "") != prev_id:
		_tasks.clear()
		_result_panel.visible = false
	_mission = m
	if m != null:
		var status = m.get("status", "")
		var terminal = status in ["completed", "failed", "cancelled"]
		if terminal:
			_remember(m)
		if terminal and not _snapshotting and (status != prev_status or m.get("id", "") != prev_id):
			_show_result(m)
	_render_mission_status()


func _remember(m):
	if _history.any(func(h): return h.get("id", "") == m.get("id", "")) and _snapshotting:
		return  # the adapter's record (with its own task counts) wins
	var mt = _tasks.values().filter(func(t): return t.get("missionId", "") == m.get("id", ""))
	var rec = m.duplicate()
	rec["tasksDone"] = mt.filter(func(t): return t.get("status") == "done").size()
	rec["tasksTotal"] = mt.size()
	_history = [rec] + _history.filter(func(h): return h.get("id", "") != m.get("id", ""))


func _render_mission_status():
	if _missions_box == null:
		return
	for c in _missions_box.get_children():
		c.queue_free()
	var m = _mission
	var active = m != null and m.get("status", "") in ["planning", "running"]
	_abort.visible = active
	if active:
		_missions_box.add_child(_mission_row(m, _mission_progress(m), true))
	for rec in _history.slice(0, 5):
		_missions_box.add_child(_mission_row(rec, 1.0, false))
	if _missions_box.get_child_count() == 0:
		_missions_box.add_child(_muted_line("No missions yet. Describe one above and press Deploy."))
	_render_tasks()


func _mission_progress(m) -> float:
	var mt = _tasks.values().filter(func(t): return t.get("missionId", "") == m.get("id", ""))
	if mt.is_empty():
		return 0.0
	return float(mt.filter(func(t): return t.get("status") == "done").size()) / mt.size()


func _mission_row(m, pct: float, live: bool) -> Control:
	var status = m.get("status", "")
	var row = _row_panel(Ui.BG_SELECTED if live else Ui.BG_ROW)
	var h = HBoxContainer.new()
	h.add_theme_constant_override("separation", 8)
	row.add_child(h)
	var dot = Icon.make("mission" if live else ("check" if status == "completed" else "close"), MISSION_COLORS.get(status, MUTED), 15)
	dot.size_flags_vertical = SIZE_SHRINK_CENTER
	h.add_child(dot)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 3)
	v.size_flags_horizontal = SIZE_EXPAND_FILL
	h.add_child(v)
	var title = _label(m.get("title", ""), 14)
	title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	title.custom_minimum_size = Vector2(200, 0)
	v.add_child(title)
	if live:
		var bar = Ui.progress_bar(MISSION_COLORS.get(status, ACCENT), 4)
		bar.value = pct
		v.add_child(bar)
	var right = _label(("%d%%" % int(round(pct * 100.0))) if live else status.capitalize(), 13, MISSION_COLORS.get(status, MUTED))
	right.size_flags_vertical = SIZE_SHRINK_CENTER
	h.add_child(right)
	if not live:
		row.tooltip_text = "Open the report"
		row.mouse_default_cursor_shape = CURSOR_POINTING_HAND
		var rec = m
		row.gui_input.connect(
			func(ev):
				if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_LEFT:
					_show_result(rec)
		)
	return row


# Checklist of the current (or latest) mission's tasks, as the adapter reports them.
func _render_tasks():
	for c in _tasks_box.get_children():
		c.queue_free()
	var mid = _mission.get("id", "") if _mission != null else ""
	var mt = _tasks.values().filter(func(t): return t.get("missionId", "") == mid)
	mt.sort_custom(func(a, b): return a.get("createdAt", 0) < b.get("createdAt", 0))
	var done = mt.filter(func(t): return t.get("status") == "done").size()
	_tasks_title.text = "TASKS  %d/%d" % [done, mt.size()] if not mt.is_empty() else "TASKS"
	if mt.is_empty():
		_tasks_box.add_child(_muted_line("The Commander splits each mission into tasks; they appear here."))
		return
	for t in mt:
		var h = HBoxContainer.new()
		h.add_theme_constant_override("separation", 8)
		h.add_child(_task_box(t.get("status", "queued")))
		var title = _label(t.get("title", ""), 13, MUTED if t.get("status") == "done" else TEXT)
		title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		title.size_flags_horizontal = SIZE_EXPAND_FILL
		title.custom_minimum_size = Vector2(160, 0)
		h.add_child(title)
		var who = t.get("agentId")
		if who != null and who != "":
			h.add_child(_label(_agent_name(who), 12, _agent_colors.get(who, MUTED).lightened(0.2)))
		_tasks_box.add_child(h)


class TaskBox:
	extends Control
	var status = "queued"

	func _draw():
		var r = Rect2(Vector2(1, 1), size - Vector2(2, 2))
		var sb = StyleBoxFlat.new()
		sb.set_corner_radius_all(4)
		match status:
			"done":
				sb.bg_color = Color(0.36, 0.68, 1.0)
				draw_style_box(sb, r)
				draw_polyline([r.position + r.size * Vector2(0.24, 0.52), r.position + r.size * Vector2(0.43, 0.7), r.position + r.size * Vector2(0.78, 0.3)], Color.WHITE, 2.0, true)
			"running":
				sb.bg_color = Color(0, 0, 0, 0)
				sb.border_color = Color(0.36, 0.68, 1.0)
				sb.set_border_width_all(2)
				draw_style_box(sb, r)
				draw_rect(Rect2(r.position + r.size * 0.3, r.size * 0.4), Color(0.36, 0.68, 1.0))
			"failed":
				sb.bg_color = Color(1.0, 0.42, 0.42)
				draw_style_box(sb, r)
				draw_line(r.position + r.size * 0.28, r.position + r.size * 0.72, Color.WHITE, 2.0, true)
				draw_line(r.position + r.size * Vector2(0.72, 0.28), r.position + r.size * Vector2(0.28, 0.72), Color.WHITE, 2.0, true)
			_:
				sb.bg_color = Color(0, 0, 0, 0)
				sb.border_color = Color(0.6, 0.66, 0.76, 0.7)
				sb.set_border_width_all(2)
				draw_style_box(sb, r)


func _task_box(status: String) -> Control:
	var b = TaskBox.new()
	b.status = status
	b.custom_minimum_size = Vector2(16, 16)
	b.size_flags_vertical = SIZE_SHRINK_CENTER
	return b


func set_approval(ap):
	_approvals[ap["id"]] = ap
	_refresh_approval()
	if _selected_building == "human_approval":
		_render_building_panel()


func set_resources(r):
	var used = int(r.get("tokensUsed", 0))
	var budget = r.get("tokenBudget")
	if budget != null and float(budget) > 0:
		_tokens_label.text = "Tokens %s / %s" % [_fmt_int(used), _fmt_int(int(budget))]
	else:
		_tokens_label.text = "Tokens %s" % _fmt_int(used)
	var cost = float(r.get("costUsd", 0.0))
	var cost_budget = r.get("costBudgetUsd")
	if cost_budget != null and float(cost_budget) > 0:
		_cost_label.text = "Cost $%.2f / $%.2f" % [cost, float(cost_budget)]
	else:
		_cost_label.text = "Cost $%.2f" % cost
	set_colony(r.get("colony"))


func add_log(line):
	var l = Label.new()
	var who = line.get("agentId")
	l.text = ("%s: " % _agent_name(who) if who != null else "") + str(line.get("text", ""))
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(LEFT_W - 40, 0)
	l.max_lines_visible = 2
	l.add_theme_font_size_override("font_size", 12)
	var color = MUTED
	match line.get("level", "info"):
		"warn":
			color = Ui.WARN
		"error":
			color = Ui.BAD
	l.add_theme_color_override("font_color", color)
	_log_box.add_child(l)
	while _log_box.get_child_count() > 5:
		var old = _log_box.get_child(0)
		_log_box.remove_child(old)
		old.queue_free()


func select_agent(agent_id):
	_selected_agent = agent_id
	for id in _cards:
		var sb = _cards[id].panel.get_theme_stylebox("panel") as StyleBoxFlat
		sb.bg_color = Ui.BG_SELECTED if id == agent_id else Ui.BG_ROW
	_render_agent_panel()


func select_building(building_id):
	_selected_building = building_id
	_building_sig = ""
	_render_building_panel()


func open_approval_if_pending():
	_refresh_approval()
	return _approval_panel.visible


# ---------- building blocks ----------


func _panel(bg = BG):
	var p = PanelContainer.new()
	p.add_theme_stylebox_override("panel", Ui.panel_style(bg))
	p.mouse_filter = MOUSE_FILTER_STOP
	return p


func _row_panel(bg = Ui.BG_ROW) -> PanelContainer:
	var p = PanelContainer.new()
	p.add_theme_stylebox_override("panel", Ui.row_style(bg))
	p.mouse_filter = MOUSE_FILTER_STOP
	return p


func _label(text, font_size = 15, color = TEXT):
	var l = Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", font_size)
	l.add_theme_color_override("font_color", color)
	return l


func _title(text: String, icon_kind := "") -> HBoxContainer:
	var h = HBoxContainer.new()
	h.add_theme_constant_override("separation", 7)
	if icon_kind != "":
		var i = Icon.make(icon_kind, MUTED, 14)
		i.size_flags_vertical = SIZE_SHRINK_CENTER
		h.add_child(i)
	var l = _label(text, 12, MUTED)
	l.add_theme_font_override("font", Ui.bold())
	l.size_flags_horizontal = SIZE_EXPAND_FILL
	h.add_child(l)
	h.set_meta("label", l)
	return h


func _muted_line(text: String) -> Label:
	var l = _label(text, 12, MUTED)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.custom_minimum_size = Vector2(LEFT_W - 40, 0)
	return l


func _button(text, primary = false):
	var b = Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", 14)
	b.custom_minimum_size = Vector2(88, 34)
	var sb = StyleBoxFlat.new()
	sb.bg_color = Color(0.2, 0.45, 0.85) if primary else Color(0.15, 0.19, 0.28)
	sb.set_corner_radius_all(7)
	sb.content_margin_left = 12
	sb.content_margin_right = 12
	sb.anti_aliasing = true
	b.add_theme_stylebox_override("normal", sb)
	var hover = sb.duplicate()
	hover.bg_color = sb.bg_color.lightened(0.15)
	b.add_theme_stylebox_override("hover", hover)
	b.add_theme_stylebox_override("pressed", hover)
	var dis = sb.duplicate()
	dis.bg_color = Color(0.13, 0.15, 0.2)
	b.add_theme_stylebox_override("disabled", dis)
	b.focus_mode = FOCUS_NONE
	return b


# Square icon button with a caption under it (selection panels' actions).
func _action(icon_kind: String, caption: String, on_press: Callable) -> VBoxContainer:
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 3)
	var b = _button("")
	b.custom_minimum_size = Vector2(46, 42)
	var icon = Icon.make(icon_kind, TEXT, 20)
	icon.set_anchors_and_offsets_preset(PRESET_CENTER)
	icon.offset_left = -10
	icon.offset_top = -10
	icon.offset_right = 10
	icon.offset_bottom = 10
	b.add_child(icon)
	b.pressed.connect(on_press)
	v.add_child(b)
	var l = _label(caption, 11, MUTED)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(l)
	return v


func _icon_button(icon_kind: String, tooltip: String, on_press: Callable, px := 30.0) -> Button:
	var b = _button("")
	b.custom_minimum_size = Vector2(px, px)
	b.tooltip_text = tooltip
	var icon = Icon.make(icon_kind, TEXT, px * 0.5)
	icon.set_anchors_and_offsets_preset(PRESET_CENTER)
	icon.offset_left = -px * 0.25
	icon.offset_top = -px * 0.25
	icon.offset_right = px * 0.25
	icon.offset_bottom = px * 0.25
	b.add_child(icon)
	b.pressed.connect(on_press)
	return b


func _portrait(px: float, border: Color) -> Dictionary:
	var frame = PanelContainer.new()
	var sb = StyleBoxFlat.new()
	sb.bg_color = Color(0.12, 0.16, 0.25)
	sb.border_color = border
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(int(px * 0.24))
	sb.anti_aliasing = true
	frame.add_theme_stylebox_override("panel", sb)
	frame.mouse_filter = MOUSE_FILTER_IGNORE
	var tex = TextureRect.new()
	tex.custom_minimum_size = Vector2(px, px)
	tex.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tex.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	tex.mouse_filter = MOUSE_FILTER_IGNORE
	frame.add_child(tex)
	return {"frame": frame, "tex": tex, "style": sb}


func _load_agent_portrait(view: Dictionary, agent_id: String, px: int):
	var def = _agent_def(agent_id)
	if def.is_empty() or not model_path_for.is_valid():
		return
	var tex_rect = view["tex"]
	view["style"].border_color = Color.html(def.get("color", "#ffffff"))
	# Only the latest request may fill this frame (a slower, older render must not win).
	var want = "%s|%s|%s|%d" % [agent_id, def.get("model", ""), def.get("color", ""), px]
	view["want"] = want
	snapshots.model_portrait(model_path_for.call(def.get("model", "rover")), Color.html(def.get("color", "#ffffff")),
		func(t): if is_instance_valid(tex_rect) and view.get("want", "") == want: tex_rect.texture = t, px)


func _set_progress(bar: ProgressBar, a):
	var st = a.get("state", "idle")
	var p = a.get("progress")
	bar.visible = st in ["working", "thinking", "approval", "waiting"]
	bar.value = float(p) if p != null else (0.35 if st == "thinking" else 0.15)
	(bar.get_theme_stylebox("fill") as StyleBoxFlat).bg_color = STATE_STYLE.get(st, STATE_STYLE["idle"])["color"]


func _idle_line(a) -> String:
	var def = _agent_def(a["id"])
	if a.get("state") in ["idle", "complete"]:
		return "At " + _building_label(def.get("home", "command_centre"))
	return "—"


func _agent_def(agent_id) -> Dictionary:
	for d in _layout.get("agents", []):
		if d["id"] == agent_id:
			return d
	return {}


func _agent_name(agent_id) -> String:
	var d = _agent_def(agent_id)
	return d.get("name", str(agent_id).capitalize())


func _building_def(building_id) -> Dictionary:
	for b in _layout.get("buildings", []):
		if b["id"] == building_id:
			return b
	return {}


func _building_label(building_id) -> String:
	var b = _building_def(building_id)
	if not b.is_empty():
		return b["label"]
	for s in _layout.get("spots", []):
		if s["id"] == building_id:
			return s["label"]
	return str(building_id).capitalize()


# ---------- top bar ----------


func _build_top_bar():
	var p = PanelContainer.new()
	var sb = Ui.panel_style(Color(0.04, 0.06, 0.1, 0.94), 0, 0)
	sb.set_border_width_all(0)
	sb.border_width_bottom = 1
	sb.content_margin_left = 16
	sb.content_margin_right = 16
	p.add_theme_stylebox_override("panel", sb)
	p.set_anchors_and_offsets_preset(PRESET_TOP_WIDE)
	p.custom_minimum_size = Vector2(0, TOP_H)
	p.mouse_filter = MOUSE_FILTER_STOP
	add_child(p)
	var col = VBoxContainer.new()
	col.add_theme_constant_override("separation", 0)
	p.add_child(col)
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 18)
	row.custom_minimum_size = Vector2(0, ROW_H)
	col.add_child(row)
	_build_colony_strip(col)
	var logo = Icon.make("logo", ACCENT, 26)
	logo.size_flags_vertical = SIZE_SHRINK_CENTER
	row.add_child(logo)
	var brand = _label("OUTPOST ZERO", 18, TEXT)
	brand.add_theme_font_override("font", Ui.bold())
	row.add_child(brand)
	var tabs = HBoxContainer.new()
	tabs.add_theme_constant_override("separation", 2)
	for t in [["Mission", "mission"], ["Sectors", "departments"], ["Build", "build"], ["Settings", "settings"]]:
		var b = Button.new()
		b.text = t[0]
		b.focus_mode = FOCUS_NONE
		b.custom_minimum_size = Vector2(0, ROW_H)
		b.add_theme_font_size_override("font_size", 15)
		var key = t[1]
		b.pressed.connect(func(): _switch_tab(key))
		tabs.add_child(b)
		_tab_buttons[key] = b
	row.add_child(tabs)
	var spacer = Control.new()
	spacer.size_flags_horizontal = SIZE_EXPAND_FILL
	row.add_child(spacer)
	row.add_child(_stat("bolt", Color(1.0, 0.8, 0.3)))
	_tokens_label = row.get_child(row.get_child_count() - 1).get_meta("label")
	row.add_child(_stat("coin", Color(1.0, 0.75, 0.25)))
	_cost_label = row.get_child(row.get_child_count() - 1).get_meta("label")
	_conn_label = _label("● CONNECTING", 14, MUTED)
	_conn_label.size_flags_vertical = SIZE_SHRINK_CENTER
	row.add_child(_conn_label)
	_mc_button = _button("Mission Control ↗")
	_mc_button.size_flags_vertical = SIZE_SHRINK_CENTER
	_mc_button.visible = false
	_mc_button.pressed.connect(func(): OS.shell_open(_mc_url))
	row.add_child(_mc_button)
	var clock = VBoxContainer.new()
	clock.alignment = BoxContainer.ALIGNMENT_CENTER
	clock.add_theme_constant_override("separation", -2)
	_clock_label = _label("", 16, TEXT)
	_clock_label.add_theme_font_override("font", Ui.bold())
	_clock_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_date_label = _label("", 11, MUTED)
	_date_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	clock.add_child(_clock_label)
	clock.add_child(_date_label)
	row.add_child(clock)
	_update_clock()


# The colony strip: the economy's hourly state (docs/economy.md). Every value is a stock,
# a flow or a power figure the adapter computed this tick; the trend is the net per sol.
const COLONY_STATS = [
	["power", "bolt", Color(1.0, 0.8, 0.3), "Power: supply / demand, battery charge"],
	["water", "drop", Color(0.45, 0.75, 1.0), "Water (L)"],
	["food", "leaf", Color(0.55, 0.85, 0.45), "Food (meals)"],
	["materials", "cube", Color(0.8, 0.7, 0.55), "Materials (kg)"],
	["parts", "gear", Color(0.75, 0.78, 0.85), "Parts"],
	["medicine", "cross", Color(1.0, 0.55, 0.6), "Medicine (doses)"],
	["colonists", "people", Color(0.9, 0.85, 0.7), "Colonists awake / in cryo"],
	["data", "research", Color(0.6, 0.85, 1.0), "Data: earned by real missions in a powered Research Lab; buys research"],
	["compute", "mission", Color(0.85, 0.8, 1.0), "Compute: MOTHER's tokens this sol against the sol budget"],
	["trust", "shield", Color(0.5, 0.8, 0.95), "Trust: the colonists' confidence in you"],
	["influence", "eye", Color(0.8, 0.6, 1.0), "Influence: MOTHER's hold on the machines"],
]


func _build_colony_strip(parent: Control):
	var strip = HBoxContainer.new()
	strip.add_theme_constant_override("separation", 16)
	strip.custom_minimum_size = Vector2(0, STRIP_H)
	parent.add_child(strip)
	_sol_label = _label("Sol —", 13, TEXT)
	_sol_label.add_theme_font_override("font", Ui.bold())
	_sol_label.size_flags_vertical = SIZE_SHRINK_CENTER
	_sol_label.custom_minimum_size = Vector2(118, 0)
	strip.add_child(_sol_label)
	var speeds = HBoxContainer.new()
	speeds.add_theme_constant_override("separation", 2)
	speeds.size_flags_vertical = SIZE_SHRINK_CENTER
	for sp in [[0, "II", "Pause the colony clock"], [1, "1×", "One game hour a minute"], [3, "3×", "Three game hours a minute"]]:
		var b = Button.new()
		b.text = sp[1]
		b.tooltip_text = sp[2]
		b.toggle_mode = true
		b.focus_mode = FOCUS_NONE
		b.custom_minimum_size = Vector2(30, 22)
		b.add_theme_font_size_override("font_size", 12)
		var speed = sp[0]
		b.pressed.connect(func(): colony_command.emit({"type": "colony.set_speed", "speed": speed}))
		speeds.add_child(b)
		_speed_buttons[speed] = b
	strip.add_child(speeds)
	for spec in COLONY_STATS:
		var h = HBoxContainer.new()
		h.add_theme_constant_override("separation", 5)
		h.tooltip_text = spec[3]
		h.mouse_filter = MOUSE_FILTER_PASS
		var i = Icon.make(spec[1], spec[2], 14)
		i.size_flags_vertical = SIZE_SHRINK_CENTER
		h.add_child(i)
		var v = _label("—", 13)
		v.size_flags_vertical = SIZE_SHRINK_CENTER
		h.add_child(v)
		var t = _label("", 11, MUTED)
		t.size_flags_vertical = SIZE_SHRINK_CENTER
		h.add_child(t)
		strip.add_child(h)
		_colony[spec[0]] = {"value": v, "trend": t, "icon": i}


func _colony_set(key: String, value: String, trend := "", color := TEXT):
	var st = _colony[key]
	st["value"].text = value
	st["value"].add_theme_color_override("font_color", color)
	st["trend"].text = trend
	st["trend"].visible = trend != ""


static func _per_sol(flow: float) -> String:
	if abs(flow) < 0.5:
		return ""
	return ("+%d" if flow > 0 else "%d") % int(round(flow)) + "/sol"


func set_colony(c):
	if c == null or _sol_label == null:
		return
	_colony_view = c
	_colony_buildings.clear()
	for b in c.get("buildings", []):
		_colony_buildings[b["id"]] = b
	if _build_panel != null:
		_build_panel.set_colony(c)
	_render_building_panel()
	_sol_label.text = "Sol %d  %02d:00  %s" % [int(c.get("sol", 0)), int(c.get("hour", 0)), "day" if c.get("daylight", true) else "night"]
	var speed = int(c.get("speed", 1))
	for sp in _speed_buttons:
		_speed_buttons[sp].button_pressed = sp == speed
	var p = c.get("power", {})
	var cut = p.get("cut", [])
	var power_color = TEXT
	if cut.size() > 0:
		power_color = Ui.BAD if "lifeSupport" in cut or "water" in cut or "food" in cut else Ui.WARN
	_colony_set("power", "%d / %d kW" % [int(round(p.get("supplyKw", 0))), int(round(p.get("demandKw", 0)))], "%d kWh" % int(round(p.get("chargeKwh", 0))), power_color)
	var stocks = c.get("stocks", {})
	var flows = c.get("flows", {})
	var caps = c.get("caps", {})
	for key in ["water", "food", "materials", "parts", "medicine"]:
		var v = float(stocks.get(key, 0))
		var f = float(flows.get(key, 0))
		var color = TEXT
		if v <= 0.0:
			color = Ui.BAD
		elif f < 0 and v / max(1.0, -f) < 2.0:  # less than two sols left at this rate
			color = Ui.WARN
		elif caps.has(key) and v >= 0.9 * float(caps[key]):
			color = MUTED
		_colony_set(key, _fmt_int(int(v)), _per_sol(f), color)
	var col = c.get("colonists", {})
	var col_note = "%d in cryo" % int(col.get("cryo", 0))
	var col_color = TEXT
	if c.get("events", {}).get("mutiny", false):
		col_note = "mutiny"
		col_color = Ui.BAD
	elif col.get("striking", false):
		col_note = "on strike"
		col_color = Ui.BAD
	elif col.get("hungry", false) or col.get("thirsty", false):
		col_note = "hungry" if col.get("hungry", false) else "thirsty"
		col_color = Ui.WARN
	elif int(col.get("waking", 0)) > 0:
		col_note = "waking %d" % int(col["waking"])
	_colony_set("colonists", "%d" % int(col.get("awake", 0)), col_note, col_color)
	_colony_set("data", _fmt_int(int(float(stocks.get("data", 0)))), _per_sol(float(flows.get("data", 0))))
	var comp = c.get("compute", {})
	_colony_set("compute", "%d / %d k" % [int(round(float(comp.get("solKTok", 0)))), int(comp.get("budgetKTok", 0))], "", Ui.BAD if comp.get("exhausted", false) else TEXT)
	_render_departments_autonomy()
	_render_mother_and_endings()
	_update_faction_tags()
	set_story(c.get("story"), c.get("events", {}))
	var trust = float(c.get("trust", 0))
	_colony_set("trust", "%d" % int(round(trust)), "", Ui.BAD if trust < 30 else (Ui.WARN if trust < 45 else TEXT))
	var infl = float(c.get("influence", 0))
	_colony_set("influence", "%d" % int(round(infl)), "", Ui.BAD if infl >= 60 else (Ui.WARN if infl >= 30 else TEXT))


func _stat(icon_kind: String, color: Color) -> HBoxContainer:
	var h = HBoxContainer.new()
	h.add_theme_constant_override("separation", 6)
	var i = Icon.make(icon_kind, color, 16)
	i.size_flags_vertical = SIZE_SHRINK_CENTER
	h.add_child(i)
	var l = _label("", 14)
	l.size_flags_vertical = SIZE_SHRINK_CENTER
	h.add_child(l)
	h.set_meta("label", l)
	return h


func _update_clock():
	var t = Time.get_datetime_dict_from_system()
	_clock_label.text = "%02d:%02d" % [t["hour"], t["minute"]]
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
	_date_label.text = "%s %d, %d" % [MONTHS[t["month"] - 1], t["day"], t["year"]]


# Tabs pick what the left column shows (Settings opens over the right column).
func _switch_tab(key: String):
	_tab = key
	_left_mission.visible = key == "mission"
	_left_departments.visible = key == "departments"
	_build_panel.visible = key == "build"
	_settings_panel.visible = key == "settings"
	_roster_scroll.get_parent().get_parent().visible = key != "settings"  # Settings opens in its place
	if key == "settings" and settings_ref != null and camera_ref != null:
		show_settings(settings_ref, camera_ref.size)
	for k in _tab_buttons:
		var on = k == key
		var b = _tab_buttons[k]
		var sb = StyleBoxFlat.new()
		sb.bg_color = Color(0.2, 0.4, 0.75, 0.25) if on else Color(0, 0, 0, 0)
		sb.border_color = ACCENT
		sb.border_width_bottom = 3 if on else 0
		sb.content_margin_left = 16
		sb.content_margin_right = 16
		b.add_theme_stylebox_override("normal", sb)
		var hover = sb.duplicate()
		hover.bg_color = Color(0.2, 0.4, 0.75, 0.3)
		b.add_theme_stylebox_override("hover", hover)
		b.add_theme_stylebox_override("pressed", hover)
		b.add_theme_color_override("font_color", TEXT if on else MUTED)


# ---------- left column: missions, tasks, activity ----------


func _left_panel() -> PanelContainer:
	var p = _panel()
	p.set_anchors_and_offsets_preset(PRESET_TOP_LEFT)
	p.offset_left = 12
	p.offset_top = TOP_H + 12
	p.custom_minimum_size = Vector2(LEFT_W, 0)
	add_child(p)
	return p


func _build_mission_panel():
	_left_mission = _left_panel()
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	_left_mission.add_child(v)
	var head = _title("MISSIONS", "mission")
	head.add_child(_icon_button("plus", "New mission", func(): _input.grab_focus(), 26))
	v.add_child(head)
	var input_row = HBoxContainer.new()
	input_row.add_theme_constant_override("separation", 6)
	_input = LineEdit.new()
	_input.placeholder_text = "Describe a mission…"
	_input.size_flags_horizontal = SIZE_EXPAND_FILL
	_input.add_theme_font_size_override("font_size", 14)
	_input.custom_minimum_size = Vector2(0, 34)
	_input.text_submitted.connect(func(_t): _on_deploy())
	input_row.add_child(_input)
	_deploy = _button("Dispatch", true)
	_deploy.custom_minimum_size = Vector2(76, 34)
	_deploy.pressed.connect(_on_deploy)
	input_row.add_child(_deploy)
	_abort = _button("Abort")
	_abort.custom_minimum_size = Vector2(64, 34)
	_abort.visible = false
	_abort.pressed.connect(func(): mission_cancel_requested.emit())
	input_row.add_child(_abort)
	v.add_child(input_row)
	_missions_box = VBoxContainer.new()
	_missions_box.add_theme_constant_override("separation", 5)
	v.add_child(_missions_box)
	v.add_child(HSeparator.new())
	var th = _title("TASKS", "check")
	_tasks_title = th.get_meta("label")
	v.add_child(th)
	_tasks_box = VBoxContainer.new()
	_tasks_box.add_theme_constant_override("separation", 6)
	v.add_child(_tasks_box)
	v.add_child(HSeparator.new())
	v.add_child(_title("ACTIVITY", "clock"))
	_log_box = VBoxContainer.new()
	_log_box.add_theme_constant_override("separation", 3)
	v.add_child(_log_box)
	_render_mission_status()


# Sectors tab (departments in the code): each sector's colour, what it does and how big it is. Clicking a
# row moves the camera to that district.
func _build_departments_panel():
	_left_departments = _left_panel()
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	_left_departments.add_child(v)
	v.add_child(_title("SECTORS", "meeting"))
	for dept in Departments.ORDER:
		var row = _row_panel()
		row.mouse_default_cursor_shape = CURSOR_POINTING_HAND
		row.tooltip_text = "Show the %s district" % Departments.NAMES[dept]
		var h = HBoxContainer.new()
		h.add_theme_constant_override("separation", 10)
		row.add_child(h)
		var icon = Icon.make(_dept_icon(dept), Color.WHITE, 30, Departments.COLORS[dept].darkened(0.2))
		icon.size_flags_vertical = SIZE_SHRINK_CENTER
		h.add_child(icon)
		var text = VBoxContainer.new()
		text.add_theme_constant_override("separation", 0)
		h.add_child(text)
		var name_l = _label(Departments.NAMES[dept], 15)
		name_l.add_theme_font_override("font", Ui.bold())
		text.add_child(name_l)
		text.add_child(_label(Departments.WORK[dept], 12, MUTED))
		var count = _label("", 12, Departments.COLORS[dept].lightened(0.25))
		text.add_child(count)
		var key = dept
		row.gui_input.connect(
			func(ev):
				if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_LEFT:
					department_focus_requested.emit(key)
		)
		v.add_child(row)
		_legend_rows[dept] = {"count": count}
		# Autonomy: how much the department's machines decide for themselves (economy).
		var econ_dept = ECON_DEPT.get(dept, "")
		if econ_dept != "":
			var auto = VBoxContainer.new()
			auto.add_theme_constant_override("separation", 3)
			var line = HBoxContainer.new()
			line.add_theme_constant_override("separation", 3)
			var levels = HBoxContainer.new()
			levels.add_theme_constant_override("separation", 2)
			var buttons = []
			for lv in 5:
				var b = Button.new()
				b.text = str(lv)
				b.toggle_mode = true
				b.focus_mode = FOCUS_NONE
				b.custom_minimum_size = Vector2(26, 22)
				b.add_theme_font_size_override("font_size", 12)
				var level = lv
				b.pressed.connect(func(): colony_command.emit({"type": "autonomy.set", "target": econ_dept, "level": level}))
				levels.add_child(b)
				buttons.append(b)
			line.add_child(_label("Autonomy", 12, MUTED))
			line.add_child(levels)
			auto.add_child(line)
			var desc = _label("", 11, MUTED)
			desc.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			desc.custom_minimum_size = Vector2(LEFT_W - 60, 0)
			auto.add_child(desc)
			v.add_child(auto)
			_legend_rows[dept]["autonomy"] = buttons
			_legend_rows[dept]["autonomy_desc"] = desc
	# MOTHER (Chapter III and after): the machines' factions and the shutdown switch.
	_mother_row = _row_panel()
	_mother_row.visible = false
	var mh = HBoxContainer.new()
	mh.add_theme_constant_override("separation", 8)
	_mother_row.add_child(mh)
	var mv = VBoxContainer.new()
	mv.add_theme_constant_override("separation", 2)
	mv.size_flags_horizontal = SIZE_EXPAND_FILL
	mh.add_child(mv)
	var mtitle = _label("MOTHER", 15)
	mtitle.add_theme_font_override("font", Ui.bold())
	mv.add_child(mtitle)
	_mother_label = _label("", 12, MUTED)
	_mother_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_mother_label.custom_minimum_size = Vector2(LEFT_W - 150, 0)
	mv.add_child(_mother_label)
	_mother_button = _button("Shut MOTHER down")
	_mother_button.size_flags_vertical = SIZE_SHRINK_CENTER
	_mother_button.pressed.connect(_on_mother_button)
	mh.add_child(_mother_button)
	v.add_child(_mother_row)
	# Endings (Chapter IV and after): the four ways this ends and what each still needs.
	_endings_box = VBoxContainer.new()
	_endings_box.add_theme_constant_override("separation", 3)
	_endings_box.visible = false
	_endings_box.add_child(_title("ENDINGS", "command"))
	for i in 4:
		var row = VBoxContainer.new()
		row.add_theme_constant_override("separation", 0)
		var name_l = _label("", 13)
		name_l.add_theme_font_override("font", Ui.bold())
		row.add_child(name_l)
		var need = _label("", 11, MUTED)
		need.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		need.custom_minimum_size = Vector2(LEFT_W - 60, 0)
		row.add_child(need)
		_endings_box.add_child(row)
		_endings_rows.append({"name": name_l, "need": need})
	v.add_child(_endings_box)


# Two presses: the first asks for confirmation, the second shuts MOTHER down (economy).
func _on_mother_button():
	if not _mother_confirm:
		_mother_confirm = true
		_mother_button.text = "Confirm shutdown"
		return
	_mother_confirm = false
	_mother_button.text = "Shut MOTHER down"
	colony_command.emit({"type": "colony.shutdown_mother"})


func _render_mother_and_endings():
	if _mother_row == null:
		return
	var story = _colony_view.get("story", {})
	var chapter = str(story.get("chapter", "I"))
	var late = chapter == "III" or chapter == "IV"
	_mother_row.visible = late
	if late:
		var fac = _colony_view.get("machines", {}).get("factions", {})
		var down = story.get("motherDown", false)
		_mother_button.visible = not down
		if down:
			_mother_label.text = "Down. Machines: %d yours, %d independent. Autonomy capped at Supervised, efficiency ×0.8, half the compute." % [int(fac.get("yours", 0)), int(fac.get("independent", 0))]
		else:
			_mother_label.text = "Influence %d. Machines: %d yours, %d MOTHER's, %d independent. Shutting MOTHER down: influence −40, trust +5, but no orchestrator." % [int(round(float(_colony_view.get("influence", 0)))), int(fac.get("yours", 0)), int(fac.get("mother", 0)), int(fac.get("independent", 0))]
	var endings = story.get("endings", [])
	_endings_box.visible = (chapter == "IV" or story.get("ending") != null) and endings.size() == _endings_rows.size()
	if _endings_box.visible:
		for i in endings.size():
			var e = endings[i]
			var rowv = _endings_rows[i]
			var reached = story.get("ending") == e.get("id")
			rowv["name"].text = str(e.get("name", "")) + ("  ·  reached" if reached else ("  ·  met" if e.get("met", false) else ""))
			rowv["name"].add_theme_color_override("font_color", Ui.GOOD if reached or e.get("met", false) else TEXT)
			rowv["need"].text = "Needs: " + str(e.get("missing", "")) if str(e.get("missing", "")) != "" else ""


# Layout departments -> the economy's autonomy departments (Commons has no machines of its own).
const ECON_DEPT = {"command": "command", "research": "research", "code": "engineering", "knowledge": "knowledge"}


func _render_departments_autonomy():
	var auto = _colony_view.get("autonomy", {})
	for dept in _legend_rows:
		var rowv = _legend_rows[dept]
		if not rowv.has("autonomy"):
			continue
		var a = auto.get(ECON_DEPT.get(dept, ""), {})
		var level = int(a.get("level", 1))
		for i in rowv["autonomy"].size():
			rowv["autonomy"][i].button_pressed = i == level
		rowv["autonomy_desc"].text = "%s: efficiency ×%.2f, approvals: %s, may spend %d%% of compute unasked" % [a.get("name", ""), float(a.get("efficiency", 1.0)), a.get("approvals", ""), int(float(a.get("computeShare", 0)) * 100)]


static func _dept_icon(dept: String) -> String:
	return {"command": "command", "research": "research", "code": "code", "knowledge": "knowledge", "meeting": "meeting"}.get(dept, "logo")


func _update_legend():
	for dept in _legend_rows:
		var nb = 0
		var na = 0
		for b in _layout.get("buildings", []):
			if Departments.of(b["capability"]) == dept:
				nb += 1
		for a in _layout.get("agents", []):
			if Departments.of_building(_layout, a.get("home", "command_centre")) == dept:
				na += 1
		_legend_rows[dept].count.text = "%d building%s · %d machine%s" % [nb, "" if nb == 1 else "s", na, "" if na == 1 else "s"]


# ---------- right column: agents ----------


func _build_roster():
	var p = _panel()
	p.set_anchors_and_offsets_preset(PRESET_TOP_RIGHT)
	p.offset_right = -12
	p.offset_left = -12 - RIGHT_W
	p.offset_top = TOP_H + 12
	p.grow_horizontal = GROW_DIRECTION_BEGIN
	add_child(p)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	p.add_child(v)
	var head = _title("MACHINES", "agent")
	_roster_title = head.get_meta("label")
	v.add_child(head)
	# Scrolls once the cards no longer fit above the bottom panels (_fit_roster).
	_roster_scroll = ScrollContainer.new()
	_roster_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(_roster_scroll)
	_roster = VBoxContainer.new()
	_roster.add_theme_constant_override("separation", 5)
	_roster_scroll.add_child(_roster)
	_roster.add_child(Control.new())  # keeps index 0 for _regroup_roster


# Cards sit under their department's header (a character belongs to its home building's
# department), in department order, then layout order.
func _regroup_roster():
	if _roster == null or _layout.is_empty():
		return
	var idx = 1
	for dept in Departments.ORDER:
		var members = []
		for a in _layout.get("agents", []):
			if _cards.has(a["id"]) and Departments.of_building(_layout, a.get("home", "command_centre")) == dept:
				members.append(a["id"])
		if not _dept_headers.has(dept):
			_dept_headers[dept] = _make_dept_header(dept)
		var h = _dept_headers[dept]
		h.box.visible = not members.is_empty()
		h.label.text = "%s  ·  %d" % [Departments.NAMES[dept].to_upper(), members.size()]
		_roster.move_child(h.box, idx)
		idx += 1
		for id in members:
			_roster.move_child(_cards[id].panel, idx)
			idx += 1
	_roster_title.text = "MACHINES  %d" % _cards.size()


func _make_dept_header(dept: String) -> Dictionary:
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var i = Icon.make(_dept_icon(dept), Departments.COLORS[dept], 13)
	i.size_flags_vertical = SIZE_SHRINK_CENTER
	row.add_child(i)
	var l = _label("", 11, Departments.COLORS[dept].lightened(0.2))
	l.add_theme_font_override("font", Ui.bold())
	row.add_child(l)
	_roster.add_child(row)
	return {"box": row, "label": l}


func _make_card(a):
	var card = _row_panel()
	card.custom_minimum_size = Vector2(RIGHT_W - 34, 0)
	var h = HBoxContainer.new()
	h.add_theme_constant_override("separation", 10)
	card.add_child(h)
	var pv = _portrait(40, _agent_colors.get(a["id"], _role_color(a.get("role", ""))))
	h.add_child(pv["frame"])
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 2)
	v.size_flags_horizontal = SIZE_EXPAND_FILL
	h.add_child(v)
	var head = HBoxContainer.new()
	var name_l = _label(a.get("name", a["id"]), 15)
	name_l.add_theme_font_override("font", Ui.bold())
	name_l.size_flags_horizontal = SIZE_EXPAND_FILL
	name_l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	name_l.custom_minimum_size = Vector2(90, 0)
	head.add_child(name_l)
	var faction = _label("", 11, MUTED)  # Chapter III+: whose side this machine is on
	head.add_child(faction)
	var state = _label("", 12)
	head.add_child(state)
	v.add_child(head)
	var task = _label("", 12, MUTED)
	task.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	task.custom_minimum_size = Vector2(150, 0)
	v.add_child(task)
	var bar = Ui.progress_bar(ACCENT, 4)
	bar.visible = false
	v.add_child(bar)
	var id = a["id"]
	card.gui_input.connect(
		func(ev):
			if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_LEFT:
				select_agent(id)
				agent_focus_requested.emit(id)
	)
	card.mouse_default_cursor_shape = CURSOR_POINTING_HAND
	_roster.add_child(card)
	var view = {"panel": card, "state": state, "task": task, "bar": bar, "name": name_l, "portrait": pv, "faction": faction}
	_load_agent_portrait(pv, id, 96)
	return view


func _fit_roster():
	var content = _roster.get_combined_minimum_size()
	var bottom_reserved = (_building_panel.get_combined_minimum_size().y + 28.0) if _building_panel.visible else 24.0
	var room = max(160.0, size.y - TOP_H - 70 - bottom_reserved)
	var bar = 12.0 if content.y > room else 0.0
	var want = Vector2(content.x + bar, min(content.y, room))
	if _roster_scroll.custom_minimum_size != want:
		_roster_scroll.custom_minimum_size = want
		var panel = _roster_scroll.get_parent().get_parent()
		panel.offset_bottom = panel.offset_top + panel.get_combined_minimum_size().y


# ---------- bottom: selected agent ----------


func _build_agent_panel():
	_agent_panel = _panel(BG_SOLID)
	_agent_panel.set_anchors_and_offsets_preset(PRESET_CENTER_BOTTOM)
	_agent_panel.offset_left = -330
	_agent_panel.offset_right = 330
	_agent_panel.offset_bottom = -14
	_agent_panel.grow_vertical = GROW_DIRECTION_BEGIN
	_agent_panel.visible = false
	add_child(_agent_panel)
	var h = HBoxContainer.new()
	h.add_theme_constant_override("separation", 14)
	_agent_panel.add_child(h)
	var pv = _portrait(92, ACCENT)
	pv["frame"].size_flags_vertical = SIZE_SHRINK_CENTER
	h.add_child(pv["frame"])
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 3)
	v.size_flags_horizontal = SIZE_EXPAND_FILL
	h.add_child(v)
	var head = HBoxContainer.new()
	head.add_theme_constant_override("separation", 10)
	var name_l = _label("", 19)
	name_l.add_theme_font_override("font", Ui.bold())
	head.add_child(name_l)
	var dept_icon = Icon.make("research", Color.WHITE, 20, ACCENT)
	dept_icon.size_flags_vertical = SIZE_SHRINK_CENTER
	head.add_child(dept_icon)
	var dept_l = _label("", 13, MUTED)
	dept_l.size_flags_vertical = SIZE_SHRINK_CENTER
	head.add_child(dept_l)
	v.add_child(head)
	var state_l = _label("", 13)
	v.add_child(state_l)
	var task_l = _label("", 14)
	task_l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	task_l.custom_minimum_size = Vector2(320, 0)
	v.add_child(task_l)
	var prow = HBoxContainer.new()
	prow.add_theme_constant_override("separation", 8)
	var bar = Ui.progress_bar(ACCENT, 6)
	bar.size_flags_horizontal = SIZE_EXPAND_FILL
	bar.size_flags_vertical = SIZE_SHRINK_CENTER
	prow.add_child(bar)
	var pct = _label("", 12, MUTED)
	prow.add_child(pct)
	v.add_child(prow)
	var job = _label("", 12, MUTED)
	job.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	job.max_lines_visible = 2
	job.custom_minimum_size = Vector2(320, 0)
	v.add_child(job)
	var actions = HBoxContainer.new()
	actions.add_theme_constant_override("separation", 8)
	actions.size_flags_vertical = SIZE_SHRINK_CENTER
	actions.add_child(_action("focus", "Focus", func(): agent_focus_requested.emit(_selected_agent)))
	actions.add_child(_action("home", "Home", func(): building_focus_requested.emit(_agent_def(_selected_agent).get("home", "command_centre"))))
	actions.add_child(_action("edit", "Edit", _edit_selected_agent))
	actions.add_child(_action("close", "Close", func(): select_agent("")))
	h.add_child(actions)
	_agent_view = {"portrait": pv, "name": name_l, "dept_icon": dept_icon, "dept": dept_l, "state": state_l, "task": task_l, "bar": bar, "pct": pct, "job": job}


func _render_agent_panel():
	var a = _agents.get(_selected_agent)
	_agent_panel.visible = a != null and not replay_active
	if a == null:
		return
	var def = _agent_def(_selected_agent)
	var v = _agent_view
	v.name.text = def.get("name", a.get("name", ""))
	var dept = Departments.of_building(_layout, def.get("home", "command_centre"))
	v.dept_icon.kind = _dept_icon(dept)
	v.dept_icon.backdrop = Departments.COLORS[dept].darkened(0.15)
	v.dept.text = "%s · lives at %s" % [Departments.NAMES[dept], _building_label(def.get("home", "command_centre"))]
	var style = STATE_STYLE.get(a.get("state", "idle"), STATE_STYLE["idle"])
	v.state.text = "● %s · at %s" % [style["text"].capitalize(), _building_label(a.get("location", ""))]
	v.state.add_theme_color_override("font_color", style["color"])
	var task = a.get("taskTitle")
	v.task.text = task if task != null and task != "" else "No task right now"
	var detail = a.get("detail")
	if detail != null and detail != "":
		v.task.text += "  —  " + str(detail)
	_set_progress(v.bar, a)
	var p = a.get("progress")
	v.pct.text = ("%d%%" % int(round(float(p) * 100.0))) if p != null else ""
	v.pct.visible = v.bar.visible
	v.job.text = def.get("job", "")
	if v.get("shown", "") != _selected_agent:
		v["shown"] = _selected_agent
		v.portrait.tex.texture = null
		_load_agent_portrait(v.portrait, _selected_agent, 192)


func _edit_selected_agent():
	var def = _agent_def(_selected_agent)
	if def.is_empty():
		return
	_switch_tab("build")
	_build_panel._switch_tab("agents")
	_build_panel._open_agent_form(def)


# ---------- bottom right: selected building ----------


func _build_building_panel():
	_building_panel = _panel(BG_SOLID)
	_building_panel.set_anchors_and_offsets_preset(PRESET_BOTTOM_RIGHT)
	_building_panel.offset_right = -12
	_building_panel.offset_left = -12 - 360
	_building_panel.offset_bottom = -14
	_building_panel.grow_vertical = GROW_DIRECTION_BEGIN
	_building_panel.grow_horizontal = GROW_DIRECTION_BEGIN
	_building_panel.visible = false
	add_child(_building_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	_building_panel.add_child(v)
	var head = _title("BUILDING", "home")
	head.add_child(_icon_button("focus", "Show on map", func(): building_focus_requested.emit(_selected_building), 26))
	head.add_child(_icon_button("close", "Close", func(): select_building(""), 26))
	v.add_child(head)
	var top = HBoxContainer.new()
	top.add_theme_constant_override("separation", 12)
	var pv = _portrait(84, ACCENT)
	top.add_child(pv["frame"])
	var info = VBoxContainer.new()
	info.add_theme_constant_override("separation", 2)
	info.size_flags_horizontal = SIZE_EXPAND_FILL
	var name_l = _label("", 17)
	name_l.add_theme_font_override("font", Ui.bold())
	info.add_child(name_l)
	var dept_l = _label("", 12)
	info.add_child(dept_l)
	var work_l = _label("", 12, MUTED)
	work_l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	work_l.custom_minimum_size = Vector2(200, 0)
	info.add_child(work_l)
	top.add_child(info)
	v.add_child(top)
	var body = VBoxContainer.new()
	body.add_theme_constant_override("separation", 6)
	v.add_child(body)
	_building_view = {"portrait": pv, "name": name_l, "dept": dept_l, "work": work_l, "body": body}


func _render_building_panel():
	var b = _building_def(_selected_building)
	_building_panel.visible = not b.is_empty() and not replay_active
	if b.is_empty():
		return
	var v = _building_view
	var dept = Departments.of(b["capability"])
	var col = Departments.COLORS[dept]
	v.name.text = b["label"]
	v.dept.text = Departments.NAMES[dept]
	v.dept.add_theme_color_override("font_color", col.lightened(0.25))
	v.work.text = Departments.WORK[dept]
	v.portrait.style.border_color = col
	if v.get("shown", "") != _selected_building + b.get("model", ""):
		v["shown"] = _selected_building + b.get("model", "")
		v.portrait.tex.texture = null
		var tex_rect = v.portrait.tex
		var want = v["shown"]
		if model_path_for.is_valid():
			snapshots.model_portrait(model_path_for.call(b.get("model", "")), Color(0, 0, 0, 0),
				func(t): if is_instance_valid(tex_rect) and v.get("shown", "") == want: tex_rect.texture = t, 192)
	# Rebuild the rows only when what they show changes (agent updates stream in constantly;
	# rebuilding under the pointer would swallow a click on Approve).
	var here_now = _agents.values().filter(func(a): return a.get("location", "") == b["id"] and not a.get("state", "") in ["idle", "complete"])
	var sig_parts = [b["id"], b.get("model", ""), _layout.get("agents", []).filter(func(d): return d.get("home", "") == b["id"]).map(func(d): return d["name"])]
	sig_parts.append([b.get("status", "built"), int(float(b.get("progress", 0.0)) * 100.0), _colony_buildings.get(b["id"], {}), _colony_view.get("building"), _colony_view.get("colonists", {}).get("waking", 0), _colony_view.get("reactor", 1.0), _colony_view.get("stocks", {}).get("medicine", 0), _colony_view.get("stocks", {}).get("parts", 0)])
	for ap in _approvals.values():
		sig_parts.append([ap["id"], ap.get("status", "")])
	for a in here_now:
		var pr = a.get("progress")
		sig_parts.append([a["id"], a.get("state", ""), a.get("taskTitle", ""), int(float(pr) * 20.0) if pr != null else -1])
	var sig = JSON.stringify(sig_parts)
	if sig == _building_sig:
		return
	_building_sig = sig
	for c in v.body.get_children():
		v.body.remove_child(c)
		c.queue_free()
	_render_economy_section(b, v.body)
	# Human Approval: the pending request, decided right here.
	if b["id"] == "human_approval":
		for ap in _approvals.values():
			if ap.get("status") == "pending":
				v.body.add_child(_title("WAITING FOR YOU", "approval"))
				var s = _label("%s asks: %s" % [_agent_name(ap.get("agentId", "")), ap.get("summary", "")], 13)
				s.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
				s.custom_minimum_size = Vector2(320, 0)
				v.body.add_child(s)
				var row = HBoxContainer.new()
				row.add_theme_constant_override("separation", 8)
				var rej = _button("Reject")
				var apid = ap["id"]
				rej.pressed.connect(func(): _resolve_id(apid, false))
				var ok = _button("Approve", true)
				ok.pressed.connect(func(): _resolve_id(apid, true))
				row.add_child(rej)
				row.add_child(ok)
				v.body.add_child(row)
	var here = _agents.values().filter(func(a): return a.get("location", "") == b["id"] and not a.get("state", "") in ["idle", "complete"])
	var th = _title("WORKING HERE  %d" % here.size(), "agent")
	v.body.add_child(th)
	if here.is_empty():
		v.body.add_child(_muted_line("Nobody is working here right now."))
	for a in here:
		var row = VBoxContainer.new()
		row.add_theme_constant_override("separation", 2)
		var line = HBoxContainer.new()
		line.add_theme_constant_override("separation", 8)
		var n = _label(_agent_name(a["id"]), 13, _agent_colors.get(a["id"], TEXT).lightened(0.2))
		n.add_theme_font_override("font", Ui.bold())
		line.add_child(n)
		var task = a.get("taskTitle")
		var t = _label(task if task != null and task != "" else STATE_STYLE.get(a.get("state", "idle"), STATE_STYLE["idle"])["text"].capitalize(), 12, MUTED)
		t.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		t.size_flags_horizontal = SIZE_EXPAND_FILL
		t.custom_minimum_size = Vector2(120, 0)
		line.add_child(t)
		row.add_child(line)
		var bar = Ui.progress_bar(ACCENT, 4)
		_set_progress(bar, a)
		row.add_child(bar)
		v.body.add_child(row)
	var residents = _layout.get("agents", []).filter(func(d): return d.get("home", "") == b["id"]).map(func(d): return d["name"])
	v.body.add_child(_title("RESIDENTS  %d" % residents.size(), "home"))
	v.body.add_child(_muted_line(", ".join(residents) if not residents.is_empty() else "Nobody lives here yet; set it as a character's home in Build."))


# What the economy says about the selected building: construction, power, rates, crew,
# and the actions that belong here (switch off, wake colonists, repair the reactor).
func _render_economy_section(b: Dictionary, body: VBoxContainer):
	if b.get("status", "built") == "building":
		var site = _colony_view.get("building", {})
		body.add_child(_title("UNDER CONSTRUCTION", "repair"))
		var p = float(b.get("progress", 0.0))
		var bar = Ui.progress_bar(Ui.WARN, 5)
		bar.value = p
		body.add_child(bar)
		if site != null and not site.is_empty():
			body.add_child(_muted_line("%d of %d hours done · %d machines building" % [int(round(float(site.get("hours", 0)) - float(site.get("hoursLeft", 0)))), int(site.get("hours", 0)), int(site.get("builders", 0))]))
			if int(site.get("builders", 0)) == 0:
				body.add_child(_muted_line("No machine is free to build; they are on a mission or without power."))
		var cancel = _button("Cancel (refund half)")
		cancel.pressed.connect(func(): colony_command.emit({"type": "colony.cancel_build"}))
		body.add_child(cancel)
		return
	var e = _colony_buildings.get(b["id"], {})
	if e.is_empty():
		return
	body.add_child(_title("ECONOMY", "bolt"))
	if e.get("note", "") != "":
		body.add_child(_muted_line(e["note"]))
	var status = "Powered"
	var color = Ui.GOOD
	if not e.get("enabled", true):
		status = "Switched off"
		color = MUTED
	elif not e.get("powered", true):
		status = "No power: cut by priority this hour"
		color = Ui.BAD
	elif e.get("producing", false):
		status = "Producing"
	elif not e.get("out", {}).is_empty():
		status = "Idle: no crew, no inputs, or the store is full"
		color = Ui.WARN
	var line = HBoxContainer.new()
	line.add_theme_constant_override("separation", 8)
	line.add_child(_label(status, 13, color))
	if float(e.get("drawKw", 0)) > 0:
		line.add_child(_label("%d kW" % int(e["drawKw"]), 12, MUTED))
	body.add_child(line)
	var rate = _rate_text(e.get("in", {}), e.get("out", {}))
	if rate != "":
		body.add_child(_muted_line(rate))
	if int(e.get("crewNeeded", 0)) > 0:
		body.add_child(_muted_line("Crew %d of %d colonists" % [int(e.get("crew", 0)), int(e.get("crewNeeded", 0))]))
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var kind = e.get("type", "")
	if kind == "cryoBay":
		var waking = int(_colony_view.get("colonists", {}).get("waking", 0))
		var med = float(_colony_view.get("stocks", {}).get("medicine", 0))
		var wake = _button("Wake 8 (16 medicine)", true)
		wake.disabled = waking > 0 or med < 16
		wake.pressed.connect(func(): colony_command.emit({"type": "colony.wake", "count": 8}))
		row.add_child(wake)
		if waking > 0:
			row.add_child(_label("Waking %d…" % waking, 12, MUTED))
	elif kind == "landingModule":
		var reactor = float(_colony_view.get("reactor", 1.0))
		row.add_child(_label("Reactor at %d%%" % int(round(reactor * 100.0)), 13, Ui.GOOD if reactor >= 0.95 else Ui.WARN))
		var fix = _button("Repair (4 parts)")
		fix.disabled = reactor >= 0.999 or float(_colony_view.get("stocks", {}).get("parts", 0)) < 4
		fix.pressed.connect(func(): colony_command.emit({"type": "colony.repair", "target": "reactor"}))
		row.add_child(fix)
	if not e.get("permanent", false):
		var on = e.get("enabled", true)
		var toggle = _button("Switch off" if on else "Switch on")
		var id = b["id"]
		toggle.pressed.connect(func(): colony_command.emit({"type": "colony.toggle", "id": id, "enabled": not on}))
		row.add_child(toggle)
	if row.get_child_count() > 0:
		body.add_child(row)


const UNITS = {"water": "L", "food": "meals", "salvage": "kg salvage", "materials": "kg materials", "parts": "parts", "medicine": "doses", "artifacts": "artifacts", "data": "data"}


static func _rate_text(inputs: Dictionary, outputs: Dictionary) -> String:
	var fmt = func(d: Dictionary) -> String:
		var parts = []
		for k in d:
			var v = float(d[k])
			parts.append("%s %s" % [("%d" % int(v)) if is_equal_approx(v, round(v)) else ("%.2f" % v).rstrip("0"), UNITS.get(k, k)])
		return " + ".join(parts)
	if outputs.is_empty():
		return ""
	var out = fmt.call(outputs) + " an hour"
	return (fmt.call(inputs) + " → " + out) if not inputs.is_empty() else out


# ---------- top centre: story cards (docs/story.md) ----------


func _build_story_panel():
	_story_panel = _panel(BG_SOLID)
	_story_panel.set_anchors_and_offsets_preset(PRESET_CENTER_TOP)
	_story_panel.offset_top = TOP_H + 14
	_story_panel.offset_left = -270
	_story_panel.offset_right = 270
	_story_panel.visible = false
	add_child(_story_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	_story_panel.add_child(v)
	var head = _title("MOTHER", "command")
	_story_title = _label("", 15, TEXT)
	_story_title.add_theme_font_override("font", Ui.bold())
	head.add_child(_story_title)
	head.add_child(_icon_button("close", "Dismiss", func(): _dismiss_story(), 24))
	v.add_child(head)
	_story_text = _label("", 13, TEXT)
	_story_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_story_text.custom_minimum_size = Vector2(500, 0)
	v.add_child(_story_text)
	_story_actions = HBoxContainer.new()
	_story_actions.add_theme_constant_override("separation", 8)
	v.add_child(_story_actions)


func _dismiss_story():
	_story_dismissed = _story_shown
	_story_panel.visible = false


# The latest card from the colony: shown once per card; the Chapter II card offers the
# three paths, the unordered-task card lets you recall the machine or let it finish.
func set_story(story, events):
	if story == null or story.is_empty():
		return
	var card = story.get("card")
	if card == null or card.is_empty() or card.get("id", "") == _story_dismissed or replay_active:
		if card == null or card.get("id", "") == _story_dismissed:
			_story_panel.visible = false
		return
	var id = card.get("id", "")
	var sig = "%s|%s|%s|%s" % [id, card.get("text", ""), str(story.get("path")), str(events.get("unordered"))]
	if sig == _story_shown + "|" + str(_story_panel.get_meta("sig", "")):
		return
	_story_shown = id
	_story_panel.set_meta("sig", sig.substr(id.length() + 1))
	_story_panel.visible = true
	_story_title.text = "Sol %d · %s" % [int(card.get("sol", 0)), card.get("title", "")]
	_story_text.text = card.get("text", "")
	for c in _story_actions.get_children():
		_story_actions.remove_child(c)
		c.queue_free()
	if card.has("choices") and story.get("path") == null:
		for p in card["choices"]:
			var b = _button(str(p).capitalize(), p == "contain")
			var path = p
			b.pressed.connect(func(): colony_command.emit({"type": "colony.path", "path": path}))
			_story_actions.add_child(b)
	elif str(card.get("key", "")).begins_with("ending"):
		var keep = _button("Keep playing")
		keep.pressed.connect(func():
			colony_command.emit({"type": "colony.set_speed", "speed": 1})
			_dismiss_story())
		_story_actions.add_child(keep)
		var fresh = _button("New colony", true)
		fresh.pressed.connect(func(): colony_command.emit({"type": "layout.reset"}))
		_story_actions.add_child(fresh)
	elif card.get("key", "") == "unordered" and events.get("unordered") != null:
		var recall = _button("Recall it", true)
		recall.pressed.connect(func(): colony_command.emit({"type": "colony.unordered", "recall": true}))
		_story_actions.add_child(recall)
		var let = _button("Let it finish")
		let.pressed.connect(func(): colony_command.emit({"type": "colony.unordered", "recall": false}))
		_story_actions.add_child(let)
	var chapter = _label("Chapter %s%s" % [story.get("chapter", "I"), ("" if story.get("path") == null else " · " + str(story.get("path")).capitalize())], 12, MUTED)
	chapter.size_flags_horizontal = SIZE_EXPAND_FILL
	chapter.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_story_actions.add_child(chapter)


# ---------- top centre: the match scoreboard (Arena) ----------


const TEAM_COLORS = {"A": Color(0.36, 0.68, 1.0), "B": Color(1.0, 0.55, 0.3), "C": Color(0.5, 0.9, 0.55), "D": Color(0.85, 0.6, 1.0)}


func _build_arena_panel():
	_arena_panel = _panel(BG_SOLID)
	_arena_panel.set_anchors_and_offsets_preset(PRESET_CENTER_TOP)
	_arena_panel.offset_top = TOP_H + 14
	_arena_panel.offset_left = -300
	_arena_panel.offset_right = 300
	_arena_panel.visible = false
	add_child(_arena_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 4)
	_arena_panel.add_child(v)
	var head = _title("MATCH", "mission")
	_arena_title = _label("", 13, TEXT)
	_arena_title.add_theme_font_override("font", Ui.bold())
	head.add_child(_arena_title)
	v.add_child(head)
	_arena_sub = _label("", 12, MUTED)
	v.add_child(_arena_sub)
	_arena_rows = VBoxContainer.new()
	_arena_rows.add_theme_constant_override("separation", 2)
	v.add_child(_arena_rows)


# The scoreboard: every number is the referee's (docs/arena.md): colony value, colonists
# awake, tokens spent and the model's average latency per decision.
static func _num(v) -> String:
	return str(snappedf(float(v), 0.01)).trim_suffix(".0")


func set_arena(a):
	if a == null or a.is_empty() or a.get("status", "lobby") == "lobby":
		_arena_panel.visible = false
		return
	_arena_panel.visible = not replay_active
	_arena_panel.offset_top = TOP_H + 14 + (150 if _story_panel != null and _story_panel.visible else 0)
	_arena_title.text = "%s · %s · sol %d / %d" % [str(a.get("mode", "")).to_upper(), str(a.get("objectiveText", "")), int(a.get("sol", 0)), int(a.get("sols", 0))]
	var r = a.get("result")
	if r != null and not r.is_empty():
		_arena_sub.text = "Over: %s · winner %s" % [r.get("reason", ""), r.get("winner") if r.get("winner") != null else "none"]
		_arena_sub.add_theme_color_override("font_color", Ui.WARN)
	else:
		_arena_sub.text = "Running · this window is team %s" % a.get("team", "")
		_arena_sub.add_theme_color_override("font_color", MUTED)
	var field = a.get("battlefield")
	if field is Dictionary and not field.is_empty():
		var k = field.get("conditions", {})
		_arena_sub.text += "\n%s · solar ×%s · water ×%s · salvage ×%s · storms ×%s" % [field.get("name", ""), _num(k.get("solar", 1)), _num(k.get("water", 1)), _num(k.get("salvage", 1)), _num(k.get("storms", 1))]
	for c in _arena_rows.get_children():
		_arena_rows.remove_child(c)
		c.queue_free()
	var board = a.get("scoreboard", [])
	var best = -1e18
	for e in board:
		best = max(best, float(e.get("value", 0)))
	for e in board:
		var row = HBoxContainer.new()
		row.add_theme_constant_override("separation", 10)
		var team = str(e.get("team", "?"))
		var chip = ColorRect.new()
		chip.color = TEAM_COLORS.get(team, ACCENT)
		chip.custom_minimum_size = Vector2(10, 10)
		chip.size_flags_vertical = SIZE_SHRINK_CENTER
		row.add_child(chip)
		var lead = float(e.get("value", 0)) >= best and board.size() > 1
		var name_l = _label("%s  %s" % [team, str(e.get("model", ""))], 13, Ui.GOOD if lead else TEXT)
		name_l.custom_minimum_size = Vector2(200, 0)
		name_l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
		row.add_child(name_l)
		row.add_child(_label("value %d" % int(e.get("value", 0)), 12, TEXT))
		row.add_child(_label("%d awake" % int(e.get("awake", 0)), 12, MUTED))
		row.add_child(_label("%d kTok" % int(round(float(e.get("tokens", 0)) / 1000.0)), 12, MUTED))
		var lat = e.get("avgLatencyS")
		row.add_child(_label(("%.1f s" % float(lat)) if lat != null else "–", 12, MUTED))
		var st = str(e.get("status", ""))
		if st == "frozen":
			row.add_child(_label("frozen", 12, Ui.BAD))
		elif st == "finished":
			row.add_child(_label("done", 12, MUTED))
		_arena_rows.add_child(row)


# ---------- bottom left: minimap buttons ----------


func _build_map_buttons():
	_map_buttons = VBoxContainer.new()
	_map_buttons.add_theme_constant_override("separation", 6)
	_map_buttons.set_anchors_and_offsets_preset(PRESET_BOTTOM_LEFT)
	_map_buttons.grow_vertical = GROW_DIRECTION_BEGIN
	_map_buttons.offset_bottom = -16
	_map_buttons.offset_left = 290
	add_child(_map_buttons)
	_map_buttons.add_child(_icon_button("fit", "Show the whole base", func(): view_fit_requested.emit(), 36))
	_map_buttons.add_child(_icon_button("plus", "Zoom in", func(): _zoom_by(-5.0), 36))
	_map_buttons.add_child(_icon_button("minus", "Zoom out", func(): _zoom_by(5.0), 36))


func _zoom_by(delta: float):
	const Settings = preload("res://source/agent/Settings.gd")
	if camera_ref != null:
		setting_changed.emit("zoom", clampf(camera_ref.size + delta, Settings.ZOOM_MIN, Settings.ZOOM_MAX))


# Where the minimap's right edge is (AgentMatch scales Open RTS's minimap with the HUD).
func set_minimap_width(w: float):
	_map_buttons.offset_left = 12 + w + 8


func _build_approval():
	_approval_panel = _panel(BG_SOLID)
	# Top centre, under the mission bar, so the base (and the Reviewer walking to Human
	# Approval) stays visible.
	_approval_panel.set_anchors_and_offsets_preset(PRESET_CENTER_TOP)
	_approval_panel.offset_left = -270
	_approval_panel.offset_right = 270
	_approval_panel.offset_top = TOP_H + 14
	_approval_panel.offset_bottom = TOP_H + 172
	_approval_panel.visible = false
	(_approval_panel.get_theme_stylebox("panel") as StyleBoxFlat).border_color = Color(1.0, 0.55, 0.2)
	(_approval_panel.get_theme_stylebox("panel") as StyleBoxFlat).set_border_width_all(2)
	add_child(_approval_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 12)
	_approval_panel.add_child(v)
	v.add_child(_label("HUMAN APPROVAL REQUIRED", 14, Color(1.0, 0.65, 0.3)))
	_approval_text = _label("", 17)
	_approval_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_approval_text.custom_minimum_size = Vector2(480, 0)
	v.add_child(_approval_text)
	var row = HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END
	row.add_theme_constant_override("separation", 10)
	var reject = _button("Reject")
	reject.pressed.connect(func(): _resolve(false))
	var approve = _button("Approve", true)
	approve.pressed.connect(func(): _resolve(true))
	row.add_child(reject)
	row.add_child(approve)
	v.add_child(row)


func _build_result():
	_result_panel = _panel(BG_SOLID)
	_result_panel.set_anchors_and_offsets_preset(PRESET_CENTER)
	_result_panel.offset_left = -360
	_result_panel.offset_right = 360
	_result_panel.offset_top = -250
	_result_panel.offset_bottom = 250
	_result_panel.visible = false
	add_child(_result_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	_result_panel.add_child(v)
	_result_title = _label("", 18, ACCENT)
	v.add_child(_result_title)
	_result_text = RichTextLabel.new()
	_result_text.bbcode_enabled = true
	_result_text.size_flags_vertical = SIZE_EXPAND_FILL
	_result_text.selection_enabled = true
	_result_text.meta_underlined = true
	_result_text.meta_clicked.connect(func(meta): OS.shell_open(str(meta)))
	_result_text.add_theme_font_size_override("normal_font_size", 15)
	_result_text.add_theme_font_size_override("bold_font_size", 16)
	v.add_child(_result_text)
	var row = HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END
	row.add_theme_constant_override("separation", 10)
	var mc = _button("Open in Mission Control")
	mc.pressed.connect(func(): OS.shell_open(_mission_link()))
	mc.visible = false
	_result_panel.set_meta("mc_button", mc)
	var copy = _button("Copy")
	copy.pressed.connect(func(): DisplayServer.clipboard_set(str(_shown_mission.get("result", "")) if _shown_mission.get("result") != null else ""))
	var close = _button("Close", true)
	close.pressed.connect(func(): _result_panel.visible = false)
	var replay = _button("▶ Replay")
	replay.pressed.connect(_on_replay_pressed)
	row.add_child(replay)
	row.add_child(mc)
	row.add_child(copy)
	row.add_child(close)
	v.add_child(row)


# ---------- behaviour ----------


func _mission_link():
	var link = _shown_mission.get("link")
	if link != null and link != "":
		return link
	return _mc_url + "/tasks"


func _on_deploy():
	var title = _input.text.strip_edges()
	if title == "" or _deploy.disabled:
		return
	_input.text = ""
	_input.release_focus()
	_result_panel.visible = false
	mission_requested.emit(title)


func _resolve(approved):
	_resolve_id(_approval_id, approved)


# The one way an approval is decided (dialog or Human Approval panel), so it can't be sent twice.
func _resolve_id(id: String, approved: bool):
	if id == "" or not _approvals.has(id) or _approvals[id].get("status") != "pending":
		return
	_approvals[id]["status"] = "resolving"
	approval_resolved.emit(id, approved)
	_refresh_approval()
	_render_building_panel()


func _refresh_approval():
	var pending = null
	for ap in _approvals.values():
		if ap.get("status") == "pending":
			pending = ap
	if pending == null:
		_approval_panel.visible = false
		_approval_id = ""
		return
	_approval_id = pending["id"]
	var who = pending.get("agentId")
	_approval_text.text = (
		"%s asks: %s" % [_agent_name(who) if who != null else "A machine", pending.get("summary", "")]
	)
	_approval_panel.visible = true


func _show_result(m):
	_shown_mission_id = m.get("id", "")
	_shown_mission = m
	var status = m.get("status", "")
	_result_title.text = {
		"completed": "MISSION COMPLETE", "failed": "MISSION FAILED", "cancelled": "MISSION CANCELLED"
	}.get(status, status.to_upper())
	var body = m.get("result")
	if body == null or body == "":
		body = "No result was produced."
	_result_text.text = _markdown_to_bbcode(body)
	(_result_panel.get_meta("mc_button") as Button).visible = _mc_url != ""
	if replay_active or _result_deferred:
		_deferred_result = m
		_replay_report.visible = replay_active
		return
	_result_panel.visible = status != "cancelled"


static func _markdown_to_bbcode(md: String) -> String:
	var out = []
	for raw in md.split("\n"):
		var line = raw.replace("[", "[lb]")
		var stripped = line.strip_edges()
		if stripped.begins_with("#"):
			out.append("[b]%s[/b]" % stripped.lstrip("# "))
			continue
		if stripped.begins_with("- ") or stripped.begins_with("* "):
			line = "  • " + stripped.substr(2)
		var re = RegEx.create_from_string("\\*\\*(.+?)\\*\\*")
		line = re.sub(line, "[b]$1[/b]", true)
		# [text](https://...) -> clickable link; ![alt](file) -> its alt text
		var link_re = RegEx.create_from_string("!?\\[lb\\](.+?)\\]\\((https?://[^)\\s]+)\\)")
		line = link_re.sub(line, "[url=$2]$1[/url]", true)
		var img_re = RegEx.create_from_string("!\\[lb\\](.*?)\\]\\([^)]*\\)")
		line = img_re.sub(line, "($1)", true)
		out.append(line)
	return "\n".join(out)


func _role_color(role):
	return ROLE_COLORS.get(role, Color.WHITE)


static func _fmt_int(n: int) -> String:
	var s = str(n)
	var out = ""
	while s.length() > 3:
		out = "," + s.substr(s.length() - 3) + out
		s = s.substr(0, s.length() - 3)
	return s + out



# ---------- mission replay ----------


# Timeline strip: elapsed fill, a marker per step (agent colour) and the playhead.
class Timeline:
	extends Control
	var progress = 0.0
	var markers = []  # [{x: 0..1, color}]

	func _draw():
		var r = Rect2(Vector2.ZERO, size)
		draw_rect(Rect2(0, size.y * 0.35, size.x, size.y * 0.3), Color(0.16, 0.2, 0.3))
		draw_rect(Rect2(0, size.y * 0.35, size.x * progress, size.y * 0.3), Color(0.4, 0.75, 1.0, 0.85))
		for m in markers:
			var x = clampf(m["x"], 0.0, 1.0) * r.size.x
			draw_rect(Rect2(x - 2, 0, 4, size.y), m["color"])
		var px = progress * r.size.x
		draw_circle(Vector2(px, size.y * 0.5), size.y * 0.42, Color.WHITE)


func _build_replay():
	_replay_panel = _panel(Color(0.05, 0.07, 0.12, 0.92))
	_replay_panel.set_anchors_and_offsets_preset(PRESET_CENTER_BOTTOM)
	_replay_panel.offset_left = -430
	_replay_panel.offset_right = 430
	_replay_panel.offset_top = -196
	_replay_panel.offset_bottom = -84
	(_replay_panel.get_theme_stylebox("panel") as StyleBoxFlat).border_color = ACCENT
	_replay_panel.visible = false
	add_child(_replay_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	_replay_panel.add_child(v)
	var head = HBoxContainer.new()
	head.add_theme_constant_override("separation", 10)
	v.add_child(head)
	head.add_child(_label("▶ REPLAY", 14, ACCENT))
	_replay_title = _label("", 15)
	_replay_title.size_flags_horizontal = SIZE_EXPAND_FILL
	_replay_title.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_replay_title.custom_minimum_size = Vector2(200, 0)
	head.add_child(_replay_title)
	_replay_time = _label("", 14, MUTED)
	head.add_child(_replay_time)
	_replay_pause = _button("Pause")
	_replay_pause.custom_minimum_size = Vector2(80, 30)
	_replay_pause.pressed.connect(func(): replay_pause_toggled.emit())
	head.add_child(_replay_pause)
	_replay_speed = _button("×1")
	_replay_speed.custom_minimum_size = Vector2(64, 30)
	_replay_speed.pressed.connect(func(): replay_speed_cycled.emit())
	head.add_child(_replay_speed)
	_replay_report = _button("View report", true)
	_replay_report.custom_minimum_size = Vector2(110, 30)
	_replay_report.visible = false
	_replay_report.pressed.connect(_show_deferred_result)
	head.add_child(_replay_report)
	var stop = _button("Close")
	stop.custom_minimum_size = Vector2(72, 30)
	stop.pressed.connect(func(): replay_stop_requested.emit())
	head.add_child(stop)
	_timeline = Timeline.new()
	_timeline.custom_minimum_size = Vector2(0, 18)
	v.add_child(_timeline)
	_replay_caption = _label("", 14, TEXT.darkened(0.05))
	_replay_caption.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_replay_caption.custom_minimum_size = Vector2(800, 0)
	v.add_child(_replay_caption)


func _on_replay_pressed():
	if _shown_mission_id != "":
		replay_requested.emit(_shown_mission_id)


func begin_replay(title: String, duration_ms: float, markers: Array):
	replay_active = true
	_result_deferred = false
	if _deferred_result == null and _result_panel.visible and _mission != null:
		_deferred_result = _mission  # bring the report back when the replay ends
	_result_panel.visible = false
	_agent_panel.visible = false
	_building_panel.visible = false
	_replay_title.text = title
	_replay_caption.text = "Replaying the mission…"
	_replay_report.visible = _deferred_result != null
	_replay_pause.text = "Pause"
	var ms = []
	for m in markers:
		var aid = m.get("agent_id", "")
		ms.append({"x": m["t"] / duration_ms, "color": _agent_colors.get(aid, ROLE_COLORS.get(aid, ACCENT))})
	_timeline.markers = ms
	_timeline.progress = 0.0
	_timeline.queue_redraw()
	_replay_panel.visible = true


func update_replay(clock_ms: float, duration_ms: float, speed: float, playing: bool):
	_timeline.progress = clampf(clock_ms / duration_ms, 0.0, 1.0)
	_timeline.queue_redraw()
	_replay_time.text = "%s / %s" % [_fmt_ms(clock_ms), _fmt_ms(duration_ms)]
	_replay_speed.text = "×%d" % int(round(speed)) if speed >= 1.0 else "×%.1f" % speed
	_replay_pause.text = "Pause" if playing else "Play"


func replay_caption(line: Dictionary):
	var who = line.get("agentId")
	_replay_caption.text = ("%s: " % _agent_name(who) if who != null else "") + str(line.get("text", ""))
	var color = TEXT
	match line.get("level", "info"):
		"warn":
			color = Color(1.0, 0.8, 0.4)
		"error":
			color = Color(1.0, 0.5, 0.5)
	_replay_caption.add_theme_color_override("font_color", color)


# Called when the replay ends or is closed; shows the report if it was waiting.
func end_replay():
	replay_active = false
	_replay_panel.visible = false
	_render_agent_panel()
	_render_building_panel()
	_show_deferred_result()


# The report a finished mission produced waits behind its replay.
func defer_next_result():
	_result_deferred = true


func cancel_deferred():
	_result_deferred = false
	_show_deferred_result()


func _show_deferred_result():
	if _deferred_result == null:
		return
	var m = _deferred_result
	_deferred_result = null
	_replay_report.visible = false
	_result_panel.visible = m.get("status", "") != "cancelled"


static func _fmt_ms(ms: float) -> String:
	var s = int(ms / 1000.0)
	return "%d:%02d" % [s / 60, s % 60]



# ---------- settings ----------


func _build_settings():
	const Settings = preload("res://source/agent/Settings.gd")
	_settings_panel = _panel(BG_SOLID)
	_settings_panel.set_anchors_and_offsets_preset(PRESET_TOP_RIGHT)
	_settings_panel.offset_left = -640
	_settings_panel.offset_right = -16
	_settings_panel.offset_top = TOP_H + 12
	_settings_panel.grow_horizontal = GROW_DIRECTION_BEGIN  # widen leftwards, never off-screen
	_settings_panel.visible = false
	add_child(_settings_panel)
	var v = VBoxContainer.new()
	v.add_theme_constant_override("separation", 12)
	_settings_panel.add_child(v)
	var head = HBoxContainer.new()
	var title = _label("SETTINGS", 14, MUTED)
	title.size_flags_horizontal = SIZE_EXPAND_FILL
	head.add_child(title)
	var close = _button("Close")
	close.custom_minimum_size = Vector2(72, 30)
	close.pressed.connect(func(): _switch_tab("mission"))
	head.add_child(close)
	v.add_child(head)
	_chip_row(v, "Display", "fullscreen", [["Window", false], ["Fullscreen", true]])
	var sizes = []
	for sz in Settings.WINDOW_SIZES:
		var chip_name = "%d×%d" % [sz.x, sz.y]
		if sz.y == 2160:
			chip_name += " 4K"
		sizes.append([chip_name, sz])
	_chip_row(v, "Window size", "window_size", sizes)
	var scales = []
	for r in Settings.RENDER_SCALES:
		scales.append(["%d%%" % int(round(r * 100.0)), r])
	_chip_row(v, "3D resolution", "render_scale", scales)
	_chip_row(v, "Anti-aliasing", "msaa", [["Off", 0], ["2×", 1], ["4×", 2]])
	var texts = []
	for t in Settings.TEXT_SIZES:
		texts.append(["%d%%" % int(round(t * 100.0)), t])
	_chip_row(v, "Menu text", "text_size", texts)
	var labels = []
	for t in Settings.LABEL_SIZES:
		labels.append(["%d%%" % int(round(t * 100.0)), t])
	_chip_row(v, "Map labels", "label_size", labels)
	var zoom_row = HBoxContainer.new()
	zoom_row.add_theme_constant_override("separation", 10)
	var zl = _label("Map zoom", 15)
	zl.custom_minimum_size = Vector2(130, 0)
	zoom_row.add_child(zl)
	_zoom_slider = HSlider.new()
	# Slider reads "closer" to the right: value = ZOOM_MAX + ZOOM_MIN - camera size.
	_zoom_slider.min_value = Settings.ZOOM_MIN
	_zoom_slider.max_value = Settings.ZOOM_MAX
	_zoom_slider.step = 1.0
	_zoom_slider.size_flags_horizontal = SIZE_EXPAND_FILL
	_zoom_slider.custom_minimum_size = Vector2(220, 24)
	_zoom_slider.value_changed.connect(
		func(val):
			if not _syncing_zoom:
				setting_changed.emit("zoom", Settings.ZOOM_MAX + Settings.ZOOM_MIN - val)
	)
	zoom_row.add_child(_zoom_slider)
	var fit = _button("Fit map")
	fit.custom_minimum_size = Vector2(84, 30)
	fit.pressed.connect(func(): setting_changed.emit("zoom", Settings.ZOOM_DEFAULT))
	zoom_row.add_child(fit)
	v.add_child(zoom_row)
	v.add_child(_label("Lower 3D resolution runs faster on large screens; text stays sharp.", 12, MUTED))
	v.add_child(HSeparator.new())
	# Game mode (docs/open-rts-mode.md): Open RTS is the original deathmatch this game is built on.
	# Switching restarts the game; the colony and the services keep running.
	var mode_row = HBoxContainer.new()
	mode_row.add_theme_constant_override("separation", 10)
	var ml = _label("Game mode", 15)
	ml.custom_minimum_size = Vector2(130, 0)
	mode_row.add_child(ml)
	var switch = _button("Switch to Open RTS")
	switch.custom_minimum_size = Vector2(0, 30)
	switch.pressed.connect(
		func():
			if switch.text == "Switch to Open RTS":
				switch.text = "Confirm: restart as Open RTS"
				get_tree().create_timer(5.0).timeout.connect(func(): switch.text = "Switch to Open RTS")
			else:
				preload("res://source/boot/GameMode.gd").switch_to(get_tree(), "open-rts")
	)
	mode_row.add_child(switch)
	v.add_child(mode_row)
	v.add_child(_label("Open RTS is the original real-time strategy game: build an army and destroy the other players. It needs no AI services.", 12, MUTED))


func _chip_row(parent: Control, title: String, key: String, options: Array):
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	var l = _label(title, 15)
	l.custom_minimum_size = Vector2(130, 0)
	row.add_child(l)
	_chip_groups[key] = []
	for opt in options:
		var b = _button(opt[0])
		b.custom_minimum_size = Vector2(0, 30)
		b.toggle_mode = true
		var value = opt[1]
		b.pressed.connect(func(): setting_changed.emit(key, value))
		row.add_child(b)
		_chip_groups[key].append({"button": b, "value": value})
	parent.add_child(row)


func _toggle_settings():
	_switch_tab("mission" if _tab == "settings" else "settings")


# Highlight the active option of each setting and sync the zoom slider.
func show_settings(settings, camera_size: float):
	const Settings = preload("res://source/agent/Settings.gd")
	var current = {
		"fullscreen": settings.fullscreen,
		"window_size": settings.window_size,
		"render_scale": settings.render_scale,
		"msaa": settings.msaa,
		"text_size": settings.text_size,
		"label_size": settings.label_size,
	}
	for key in _chip_groups:
		for chip in _chip_groups[key]:
			var on = _same(chip["value"], current[key])
			chip["button"].set_pressed_no_signal(on)
			var sb = (chip["button"].get_theme_stylebox("normal") as StyleBoxFlat).duplicate()
			sb.bg_color = Color(0.2, 0.45, 0.85) if on else Color(0.16, 0.2, 0.3)
			chip["button"].add_theme_stylebox_override("normal", sb)
			chip["button"].add_theme_stylebox_override("pressed", sb)
		if key == "window_size":
			for chip in _chip_groups[key]:
				chip["button"].disabled = settings.fullscreen
	_syncing_zoom = true
	_zoom_slider.value = Settings.ZOOM_MAX + Settings.ZOOM_MIN - camera_size
	_syncing_zoom = false


static func _same(a, b) -> bool:
	if typeof(a) == TYPE_FLOAT or typeof(b) == TYPE_FLOAT:
		return absf(float(a) - float(b)) < 0.001
	return a == b



# ---------- build mode ----------


func _build_build_panel():
	const BuildPanelScript = preload("res://source/agent/hud/BuildPanel.gd")
	_build_panel = BuildPanelScript.new()
	_build_panel.set_anchors_and_offsets_preset(PRESET_TOP_LEFT)
	_build_panel.offset_left = 12
	_build_panel.offset_top = TOP_H + 12
	_build_panel.visible = false
	add_child(_build_panel)
	_build_panel.setup(self)
	_build_panel.command.connect(func(cmd): build_command.emit(cmd))
	_build_panel.place.connect(func(kind, payload, label_text): placement_requested.emit(kind, payload, label_text))


func _build_hint_and_toast():
	_hint_panel = _panel(Color(0.08, 0.1, 0.16, 0.92))
	_hint_panel.set_anchors_and_offsets_preset(PRESET_CENTER_TOP)
	_hint_panel.offset_left = -300
	_hint_panel.offset_right = 300
	_hint_panel.offset_top = TOP_H + 14
	_hint_panel.grow_horizontal = GROW_DIRECTION_BOTH
	_hint_panel.mouse_filter = MOUSE_FILTER_IGNORE
	_hint_panel.visible = false
	_hint_label = _label("", 15)
	_hint_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_hint_panel.add_child(_hint_label)
	add_child(_hint_panel)
	_toast_panel = _panel(Color(0.25, 0.08, 0.08, 0.94))
	_toast_panel.set_anchors_and_offsets_preset(PRESET_CENTER_TOP)
	_toast_panel.offset_left = -300
	_toast_panel.offset_right = 300
	_toast_panel.offset_top = TOP_H + 70
	_toast_panel.grow_horizontal = GROW_DIRECTION_BOTH
	_toast_panel.mouse_filter = MOUSE_FILTER_IGNORE
	_toast_panel.visible = false
	_toast_label = _label("", 15, Color(1.0, 0.85, 0.85))
	_toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_toast_panel.add_child(_toast_label)
	add_child(_toast_panel)


func toggle_build():
	_switch_tab("mission" if _tab == "build" else "build")


var _agent_colors = {}  # agent id -> Color, from the layout


func set_terrain(id: String):
	if _build_panel != null:
		_build_panel.set_terrain(id)


func set_layout(layout: Dictionary):
	_layout = layout
	_build_panel.set_layout(layout)
	_regroup_roster()
	_update_legend()
	_agent_colors.clear()
	for a in layout.get("agents", []):
		_agent_colors[a["id"]] = Color.html(a["color"])
		if _cards.has(a["id"]):
			var card = _cards[a["id"]]
			card.name.text = a["name"]
			var look = "%s:%s" % [a.get("model", ""), a.get("color", "")]
			if card.get("look", "") != look:
				card["look"] = look
				_load_agent_portrait(card.portrait, a["id"], 96)
			if _agents.has(a["id"]):
				card.task.text = _agents[a["id"]].get("taskTitle") if _agents[a["id"]].get("taskTitle") else _idle_line(_agents[a["id"]])
	_agent_view["shown"] = ""
	_building_view["shown"] = ""
	_building_sig = ""
	_render_mission_status()
	_render_agent_panel()
	_render_building_panel()


func remove_agent(agent_id):
	if _cards.has(agent_id):
		_cards[agent_id].panel.queue_free()
		_cards.erase(agent_id)
	_agents.erase(agent_id)
	if _selected_agent == agent_id:
		select_agent("")
	_regroup_roster()
	_render_building_panel()


func show_hint(text: String):
	_hint_label.text = text
	_hint_panel.visible = text != ""


func show_error(text: String):
	if text == "":
		return
	_toast_label.text = text
	_toast_panel.visible = true
	_toast_until = Time.get_ticks_msec() / 1000.0 + 4.0
	_build_panel.form_failed()


func _process(delta):
	_fit_roster()
	if _toast_panel != null and _toast_panel.visible and Time.get_ticks_msec() / 1000.0 > _toast_until:
		_toast_panel.visible = false
	_clock_tick += delta
	if _clock_tick > 5.0:
		_clock_tick = 0.0
		_update_clock()
