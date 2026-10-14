extends MeshInstance3D

# The unexplored-area shroud (shroud.gdshader) as a full-screen quad on the camera, plus
# the land agents have explored outside the base: a small greyscale image over the world
# that is painted where they walk and saved, so discoveries persist between sessions.

const SAVE_PATH = "user://outpost_zero_explored.png"
const PX = 192  # image size; covers RECT_SIZE world units
const RECT_MIN = -30.0
const RECT_SIZE = 104.0
const REVEAL_RADIUS = 7.0  # world units around an exploring agent

var save_path = SAVE_PATH  # --explored-file=PATH overrides it (tests)
var _img: Image
var _tex: ImageTexture
var _dirty_since = -1.0


func _init():
	var quad = QuadMesh.new()
	quad.size = Vector2(2, 2)
	mesh = quad
	var noise = FastNoiseLite.new()
	noise.seed = 7
	noise.frequency = 0.012
	noise.fractal_octaves = 4
	var tex = NoiseTexture2D.new()
	tex.width = 512
	tex.height = 512
	tex.seamless = true
	tex.noise = noise
	var mat = ShaderMaterial.new()
	mat.shader = load("res://source/agent/shroud.gdshader")
	mat.set_shader_parameter("noise_tex", tex)
	mat.render_priority = -10  # under the name plates and labels, over the world
	material_override = mat
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--explored-file="):
			save_path = arg.substr(16)
	_img = Image.load_from_file(ProjectSettings.globalize_path(save_path)) if FileAccess.file_exists(save_path) else null
	if _img == null or _img.get_width() != PX:
		_img = Image.create(PX, PX, false, Image.FORMAT_L8)
	_img.convert(Image.FORMAT_L8)
	_tex = ImageTexture.create_from_image(_img)
	mat.set_shader_parameter("reveal_tex", _tex)
	mat.set_shader_parameter("reveal_rect", Vector3(RECT_MIN, RECT_MIN, RECT_SIZE))
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	extra_cull_margin = 16384.0  # the quad is placed in the vertex shader; never cull it
	position = Vector3(0, 0, -1)


# Uncovers the land around a world position (soft-edged, never covers it again).
func reveal(at: Vector3):
	var c = (Vector2(at.x, at.z) - Vector2(RECT_MIN, RECT_MIN)) / RECT_SIZE * PX
	var r = REVEAL_RADIUS / RECT_SIZE * PX
	var changed = false
	for y in range(max(0, int(c.y - r - 1)), min(PX, int(c.y + r + 2))):
		for x in range(max(0, int(c.x - r - 1)), min(PX, int(c.x + r + 2))):
			var d = Vector2(x + 0.5, y + 0.5).distance_to(c) / r
			if d >= 1.0:
				continue
			var v = clampf((1.0 - d) * 1.6, 0.0, 1.0)
			var old = _img.get_pixel(x, y).r
			if v > old + 0.01:
				_img.set_pixel(x, y, Color(v, v, v))
				changed = true
	if changed:
		_tex.update(_img)
		if _dirty_since < 0.0:
			_dirty_since = Time.get_ticks_msec() / 1000.0


func _process(_delta):
	# Save a few seconds after the last change (not on every step), and on exit.
	if _dirty_since >= 0.0 and Time.get_ticks_msec() / 1000.0 - _dirty_since > 4.0:
		_save()


func _exit_tree():
	if _dirty_since >= 0.0:
		_save()


func _save():
	_dirty_since = -1.0
	_img.save_png(ProjectSettings.globalize_path(save_path))


func set_area(centre: Vector2, half_size: Vector2):
	material_override.set_shader_parameter("centre", centre)
	material_override.set_shader_parameter("half_size", half_size)
