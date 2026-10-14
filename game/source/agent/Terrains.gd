extends RefCounted

# Terrain themes: a baked texture set (game/assets/terrains/<id>/, made by
# tools/bake_terrains.py) plus tiling, light and road colour. Ids match the adapter's
# TERRAINS list (adapter/src/layout.ts).

const ORDER = ["grassland", "sahara", "arctic", "beach", "canyon", "mars", "moon", "venus", "europa", "titan"]
const DIR = "res://assets/terrains/"

const PRESETS = {
	# ---- Earth ----
	"grassland": {
		"name": "Grassland", "group": "Earth", "swatch": [Color(0.24, 0.36, 0.12), Color(0.45, 0.50, 0.25)],
		"tile": 8.0, "normal": 1.0, "macro": 0.9, "road": Color(0.38, 0.30, 0.20),
		"sun": Color(1.0, 0.97, 0.9), "sun_energy": 1.0, "ambient": Color(0.82, 0.9, 1.0), "ambient_energy": 0.45,
	},
	"sahara": {
		"name": "Sahara Desert", "group": "Earth", "swatch": [Color(0.82, 0.62, 0.38), Color(0.66, 0.46, 0.25)],
		"tile": 8.0, "normal": 1.0, "macro": 1.0, "road": Color(0.55, 0.40, 0.24),
		"sun": Color(1.0, 0.95, 0.85), "sun_energy": 1.05, "ambient": Color(1.0, 0.92, 0.8), "ambient_energy": 0.4,
	},
	"arctic": {
		"name": "Arctic Ice", "group": "Earth", "swatch": [Color(0.92, 0.94, 0.97), Color(0.62, 0.74, 0.86)],
		"tile": 14.0, "normal": 0.9, "macro": 0.8, "road": Color(0.55, 0.60, 0.68),
		"sun": Color(1.0, 0.98, 0.95), "sun_energy": 0.9, "ambient": Color(0.75, 0.85, 1.0), "ambient_energy": 0.45,
	},
	"beach": {
		"name": "Tropical Beach", "group": "Earth", "swatch": [Color(0.90, 0.82, 0.64), Color(0.55, 0.48, 0.36)],
		"tile": 10.0, "normal": 0.9, "macro": 0.7, "road": Color(0.58, 0.49, 0.36),
		"sun": Color(1.0, 0.97, 0.88), "sun_energy": 1.0, "ambient": Color(0.85, 0.93, 1.0), "ambient_energy": 0.45,
	},
	"canyon": {
		"name": "Grand Canyon", "group": "Earth", "swatch": [Color(0.66, 0.33, 0.18), Color(0.82, 0.60, 0.42)],
		"tile": 5.0, "normal": 1.0, "macro": 1.0, "road": Color(0.45, 0.26, 0.17),
		"sun": Color(1.0, 0.92, 0.8), "sun_energy": 1.0, "ambient": Color(1.0, 0.88, 0.78), "ambient_energy": 0.45,
	},
	# ---- Other worlds ----
	"mars": {
		"name": "Mars", "group": "Planets", "swatch": [Color(0.66, 0.36, 0.20), Color(0.35, 0.21, 0.14)],
		"tile": 3.5, "normal": 1.0, "macro": 0.9, "road": Color(0.42, 0.24, 0.15),
		"sun": Color(1.0, 0.93, 0.85), "sun_energy": 0.95, "ambient": Color(1.0, 0.82, 0.7), "ambient_energy": 0.45,
	},
	"moon": {
		"name": "The Moon", "group": "Planets", "swatch": [Color(0.50, 0.50, 0.49), Color(0.32, 0.32, 0.32)],
		"tile": 4.5, "normal": 1.1, "macro": 1.0, "road": Color(0.30, 0.30, 0.30),
		"sun": Color(1.0, 1.0, 1.0), "sun_energy": 1.2, "ambient": Color(0.7, 0.75, 0.85), "ambient_energy": 0.25,
	},
	"venus": {
		"name": "Venus", "group": "Planets", "swatch": [Color(0.45, 0.35, 0.22), Color(0.28, 0.21, 0.13)],
		"tile": 3.5, "normal": 1.0, "macro": 0.9, "road": Color(0.30, 0.23, 0.15),
		"sun": Color(1.0, 0.82, 0.55), "sun_energy": 0.9, "ambient": Color(1.0, 0.8, 0.55), "ambient_energy": 0.5,
	},
	"europa": {
		"name": "Europa", "group": "Planets", "swatch": [Color(0.86, 0.87, 0.88), Color(0.55, 0.36, 0.24)],
		"tile": 6.0, "normal": 0.9, "macro": 0.7, "road": Color(0.55, 0.57, 0.62),
		"sun": Color(0.92, 0.95, 1.0), "sun_energy": 0.95, "ambient": Color(0.75, 0.82, 1.0), "ambient_energy": 0.4,
	},
	"titan": {
		"name": "Titan", "group": "Planets", "swatch": [Color(0.36, 0.25, 0.13), Color(0.22, 0.14, 0.08)],
		"tile": 8.0, "normal": 1.0, "macro": 1.0, "road": Color(0.20, 0.14, 0.08),
		"sun": Color(1.0, 0.72, 0.42), "sun_energy": 0.85, "ambient": Color(1.0, 0.75, 0.5), "ambient_energy": 0.55,
	},
}

static var _cache = {}


static func get_preset(id: String) -> Dictionary:
	return PRESETS.get(id, PRESETS["mars"])


# Loads a baked texture with mipmaps (cached; loading all four maps takes a few ms).
static func _texture(id: String, map_name: String, ext: String) -> Texture2D:
	var key = id + "/" + map_name
	if _cache.has(key):
		return _cache[key]
	var img = Image.load_from_file(DIR + id + "/" + map_name + "." + ext)
	if img == null:
		return null
	img.generate_mipmaps()
	var tex = ImageTexture.create_from_image(img)
	_cache[key] = tex
	return tex


static func apply_to_material(mat: ShaderMaterial, id: String):
	if not PRESETS.has(id):
		id = "mars"
	var t = PRESETS[id]
	mat.set_shader_parameter("albedo_tex", _texture(id, "albedo", "jpg"))
	mat.set_shader_parameter("normal_tex", _texture(id, "normal", "jpg"))
	mat.set_shader_parameter("rough_tex", _texture(id, "rough", "jpg"))
	mat.set_shader_parameter("macro_tex", _texture(id, "macro", "png"))
	mat.set_shader_parameter("tile_size", t.get("tile", 6.0))
	mat.set_shader_parameter("normal_strength", t.get("normal", 1.0))
	mat.set_shader_parameter("macro_strength", t.get("macro", 1.0))
	mat.set_shader_parameter("metallic_value", 0.0)
