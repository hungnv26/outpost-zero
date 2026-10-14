extends Node3D

# Static ground markings: the district grid (streets between the departments' districts,
# a light tint in each department's colour and its name painted on the ground), a painted
# Rally Point (agents waiting on others) and a striped Repair Bay (agents whose step failed).
# No lights, no animation. No collision, no navigation.

const Fx = preload("res://source/agent/Fx.gd")
const HAZARD_SHADER = preload("res://source/agent/hazard.gdshader")
const ROAD_SHADER = preload("res://source/agent/road.gdshader")
const Departments = preload("res://source/agent/Departments.gd")

var buildings = {}  # id -> {"pos": Vector3, "accent": Color, "size": float}
var spots = {}  # id -> {"pos": Vector3, "color": Color, "label": String}
var center = Vector3(22, 0, 22)
var view_up = Vector3(0, 0, -1)  # screen-up on the ground (set by AgentMatch from the camera)
var ui_scale = 1.0

var road_color = Color(0.62, 0.42, 0.36)
var _streets = []  # ShaderMaterial per street


func set_road_color(c: Color):
	road_color = c
	for mat in _streets:
		mat.set_shader_parameter("dirt", c)


func clear():
	for child in get_children():
		child.queue_free()
	_streets.clear()


func build():
	_build_districts()
	_build_rally_point()
	_build_repair_bay()


func _build_districts():
	var size = Departments.MAP_SIZE
	for v in Departments.STREETS:
		_street(Vector3(v, 0, size * 0.5), size - 2.0, false)
		_street(Vector3(size * 0.5, 0, v), size - 2.0, true)
		# Dirt approach roads from the gates out into the country.
		for out in [-22.0, size + 22.0]:
			_street(Vector3(v, 0, out), 44.0, false, false)
			_street(Vector3(out, 0, v), 44.0, true, false)
	for r in 3:
		for c in 3:
			var dept = Departments.DISTRICTS[r][c]
			var col = Departments.COLORS[dept]
			var at = Departments.cell_centre(c, r)
			var tint = StandardMaterial3D.new()
			tint.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
			tint.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			tint.albedo_color = Color(col, 0.07)
			var plane = PlaneMesh.new()
			plane.size = Vector2(Departments.CELL - 1.5, Departments.CELL - 1.5)
			var mi = MeshInstance3D.new()
			mi.mesh = plane
			mi.material_override = tint
			mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			mi.position = at + Vector3(0, 0.012, 0)
			add_child(mi)
			# The name lies on the ground between the two rows of buildings (in the
			# Command district, below the Command Centre and Human Approval).
			var name_pos = at + (Vector3(0, 0, 4.2) if dept == "command" else Vector3(0, 0, 0.3))
			_ground_text(Departments.NAMES[dept].to_upper(), name_pos, col)


func _street(pos: Vector3, length: float, east_west: bool, paved := true):
	var plane = PlaneMesh.new()
	plane.size = Vector2(1.6, length)  # the road shader runs along the plane's length
	var mat = ShaderMaterial.new()
	mat.shader = ROAD_SHADER
	mat.set_shader_parameter("dirt", road_color)
	mat.set_shader_parameter("paved", 1.0 if paved else 0.0)
	mat.set_shader_parameter("length", length)
	var mi = MeshInstance3D.new()
	mi.mesh = plane
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	mi.position = pos + Vector3(0, 0.015 if east_west else 0.018, 0)
	if east_west:
		mi.rotation.y = PI / 2.0
	add_child(mi)
	_streets.append(mat)


func _ground_text(text: String, pos: Vector3, color: Color):
	var l = Label3D.new()
	l.text = text
	l.font_size = 96
	l.pixel_size = 0.009
	l.outline_size = 18
	l.modulate = Color(color.lightened(0.15), 0.72)
	l.outline_modulate = Color(0.04, 0.05, 0.08, 0.7)
	l.billboard = BaseMaterial3D.BILLBOARD_DISABLED
	l.rotation = Vector3(-PI / 2, atan2(-view_up.x, -view_up.z), 0)  # flat, reading screen-up
	l.position = pos + Vector3(0, 0.03, 0)
	l.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	l.no_depth_test = true  # tall buildings would hide it; it reads as a map overlay
	l.render_priority = -1  # below building and agent name labels
	add_child(l)


func _build_rally_point():
	var s = spots["rally_point"]
	var paint = StandardMaterial3D.new()
	paint.albedo_color = Color(0.93, 0.78, 0.32, 0.75)
	paint.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	paint.roughness = 1.0
	var ring = Fx.torus(1.85, 2.05, paint, 0.01)
	ring.position = s.pos + Vector3(0, 0.02, 0)
	add_child(ring)
	var l = Fx.label(self, s.label, 22, Color(1.0, 0.9, 0.6), ui_scale)
	l.position = s.pos + Vector3(0, 0.8, 0) + view_up * 2.3


func _build_repair_bay():
	var s = spots["repair_bay"]
	var hazard = ShaderMaterial.new()
	hazard.shader = HAZARD_SHADER
	var pad = Fx.disc(2.1, 0.04, hazard, 8)
	pad.position = s.pos + Vector3(0, 0.02, 0)
	pad.rotation.y = PI / 8.0
	add_child(pad)
	var inner = StandardMaterial3D.new()
	inner.albedo_color = Color(0.55, 0.42, 0.38)
	inner.roughness = 1.0
	var core = Fx.disc(1.7, 0.05, inner, 8)
	core.position = s.pos + Vector3(0, 0.025, 0)
	core.rotation.y = PI / 8.0
	add_child(core)
	var l = Fx.label(self, s.label, 22, Color(1.0, 0.7, 0.6), ui_scale)
	l.position = s.pos + Vector3(0, 0.8, 0) + view_up * 2.4
