extends Node

# Renders small textures once and caches them: 3D portraits of characters and buildings
# (their real model, lit, on a transparent background) and 2D badges (a Control drawn into
# an image, used as the buildings' name plates on the map). One render per frame.

const Fx = preload("res://source/agent/Fx.gd")
const Ui = preload("res://source/agent/hud/Ui.gd")

var _cache = {}  # key -> Texture2D
var _waiting = {}  # key -> [Callable]
var _queue = []  # [{key, build: Callable, size: Vector2i, is3d: bool}]
var _busy = false


# Calls `done(texture)` now if cached, otherwise once it has been rendered.
func request(key: String, build: Callable, px: Vector2i, is3d: bool, done: Callable):
	if _cache.has(key):
		done.call(_cache[key])
		return
	if _waiting.has(key):
		_waiting[key].append(done)
		return
	_waiting[key] = [done]
	_queue.append({"key": key, "build": build, "size": px, "is3d": is3d})
	if not _busy:
		_pump()


# A character or building model, seen from the front three-quarters, trim in `tint`.
func model_portrait(model_path: String, tint: Color, done: Callable, px := 128):
	var key = "model:%s:%s:%d" % [model_path, tint.to_html(), px]
	request(key, _build_portrait.bind(model_path, tint), Vector2i(px, px), true, done)


func _pump():
	_busy = true
	while not _queue.is_empty():
		var job = _queue.pop_front()
		var vp = SubViewport.new()
		vp.transparent_bg = true
		vp.size = job["size"]
		vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
		if job["is3d"]:
			vp.own_world_3d = true
			vp.msaa_3d = Viewport.MSAA_4X
		else:
			vp.disable_3d = true
		add_child(vp)
		var content = job["build"].call()
		vp.add_child(content)
		await get_tree().process_frame
		if not job["is3d"] and content is Control:
			# Size the image to the control (drawn at 2x for crisp text).
			var want = content.get_combined_minimum_size()
			content.size = want
			content.scale = Vector2(2, 2)
			vp.size = Vector2i(ceili(want.x * 2), ceili(want.y * 2))
		vp.render_target_update_mode = SubViewport.UPDATE_ONCE
		await RenderingServer.frame_post_draw
		var img = vp.get_texture().get_image()
		vp.queue_free()
		if img == null:
			_waiting.erase(job["key"])  # let a later request try again
			continue
		img.generate_mipmaps()
		var tex = ImageTexture.create_from_image(img)
		_cache[job["key"]] = tex
		for cb in _waiting.get(job["key"], []):
			if cb.is_valid():
				cb.call(tex)
		_waiting.erase(job["key"])
	_busy = false


func _build_portrait(model_path: String, tint: Color) -> Node3D:
	var root = Node3D.new()
	var character = model_path.get_file().get_basename() in preload("res://source/agent/Models.gd").CHARACTERS
	var model = Fx.fitted(model_path, 1.6, 1.6 if character else 0.0)
	root.add_child(model)
	# Characters are posed (their idle animation) rather than shown in their bind pose.
	for ap in model.find_children("*", "AnimationPlayer", true, false):
		for full in ap.get_animation_list():
			if full.ends_with("Idle"):
				ap.play(full)
				ap.advance(0.4)
				break
	_paint_trim(model, tint)
	var h = model.get_meta("height", 1.0)
	var cam = Camera3D.new()
	cam.fov = 30.0
	var target = Vector3(0, h * 0.45, 0)
	cam.position = target + Vector3(1.9, 1.5, 2.6).normalized() * (2.6 + h * 1.2)
	root.add_child(cam)
	cam.look_at_from_position(cam.position, target)
	cam.current = true
	var sun = DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 35, 0)
	sun.light_energy = 1.2
	root.add_child(sun)
	var env = WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_CLEAR_COLOR
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.85, 0.9, 1.0)
	env.environment.ambient_light_energy = 0.7
	root.add_child(env)
	return root


static func _paint_trim(model: Node3D, tint: Color):
	if tint.a <= 0.0:
		return
	var mat = StandardMaterial3D.new()
	mat.albedo_color = tint
	mat.roughness = 0.6
	for mi in model.find_children("*", "MeshInstance3D", true, false):
		for i in mi.get_surface_override_material_count():
			var m = mi.get_active_material(i)
			if m is BaseMaterial3D and m.albedo_color.r > 0.75 and m.albedo_color.g > 0.45 and m.albedo_color.b < 0.6 and m.albedo_color.r - m.albedo_color.b > 0.3:
				mi.set_surface_override_material(i, mat)


# Building name plate: department icon tile + name, on a dark rounded pill.
func building_badge(label: String, dept_kind: String, color: Color, done: Callable):
	var key = "badge:%s:%s:%s" % [label, dept_kind, color.to_html()]
	request(key, _build_badge.bind(label, dept_kind, color), Vector2i(8, 8), false, done)


func _build_badge(label: String, dept_kind: String, color: Color) -> Control:
	var p = PanelContainer.new()
	p.theme = Ui.theme()
	var sb = Ui.panel_style(Color(0.05, 0.07, 0.12, 0.92), 9, 6, Color(color, 0.75))
	sb.shadow_size = 0
	sb.content_margin_right = 12
	p.add_theme_stylebox_override("panel", sb)
	var row = HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	p.add_child(row)
	row.add_child(load("res://source/agent/hud/Icon.gd").make(dept_kind, Color.WHITE, 24, color.darkened(0.15)))
	var l = Label.new()
	l.text = label
	l.add_theme_font_override("font", Ui.bold())
	l.add_theme_font_size_override("font_size", 17)
	l.add_theme_color_override("font_color", Color(0.96, 0.97, 1.0))
	row.add_child(l)
	return p
