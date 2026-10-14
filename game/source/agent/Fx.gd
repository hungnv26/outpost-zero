extends RefCounted

# Shared helpers for the agent world's visuals: materials, labels and model fitting.

const LABEL_GROUP = "outpost_zero_labels"


static func metal(color: Color, metallic := 0.7, roughness := 0.35) -> StandardMaterial3D:
	var m = StandardMaterial3D.new()
	m.albedo_color = color
	m.metallic = metallic
	m.roughness = roughness
	return m


# Billboard label that keeps a constant on-screen size, scaled with the HUD (ui_scale).
static func label(parent: Node, text: String, font_size: int, color: Color, ui_scale := 1.0, base_px := 0.0008) -> Label3D:
	var l = Label3D.new()
	l.text = text
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.no_depth_test = true
	l.fixed_size = true
	l.font_size = font_size
	l.outline_size = max(6, font_size / 3)
	l.modulate = color
	l.outline_modulate = Color(0.03, 0.04, 0.08, 0.92)
	l.set_meta("base_px", base_px)
	l.pixel_size = base_px * ui_scale
	l.add_to_group(LABEL_GROUP)
	parent.add_child(l)
	return l


# Instance a model, centre it on its footprint, scale its largest horizontal extent to
# `size` (or its height to `height` when given; never taller than `max_height` when that
# is set) and return a pivot that can be rotated.
static func fitted(path: String, size: float, height := 0.0, max_height := 0.0) -> Node3D:
	var model: Node3D
	if path.begins_with("composite:"):
		model = load("res://source/agent/Composites.gd").build(path.substr(10))
	else:
		model = load(path).instantiate()
	var pivot = Node3D.new()
	pivot.add_child(model)
	var box = aabb_of(model)
	if box == null:
		return pivot
	var s = 1.0
	if height > 0.0 and box.size.y > 0.001:
		s = height / box.size.y
	else:
		var extent = max(box.size.x, box.size.z)
		s = size / extent if extent > 0.001 else 1.0
	if max_height > 0.0 and box.size.y * s > max_height:
		s = max_height / box.size.y
	model.scale = Vector3.ONE * s
	var c = box.get_center()
	model.position = Vector3(-c.x * s, -box.position.y * s, -c.z * s)
	pivot.set_meta("height", box.size.y * s)
	return pivot


static func aabb_of(root: Node3D):
	var box = null
	for mi in root.find_children("*", "MeshInstance3D", true, false):
		var rel = Transform3D.IDENTITY
		var n = mi
		while n != root:
			rel = n.transform * rel
			n = n.get_parent()
		var b = rel * mi.mesh.get_aabb()
		box = b if box == null else box.merge(b)
	return box


static func torus(inner: float, outer: float, material: Material, flat := 0.06) -> MeshInstance3D:
	var t = TorusMesh.new()
	t.inner_radius = inner
	t.outer_radius = outer
	t.rings = 48
	var mi = MeshInstance3D.new()
	mi.mesh = t
	mi.material_override = material
	mi.scale = Vector3(1, flat, 1)
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi


static func disc(radius: float, height: float, material: Material, sides := 48) -> MeshInstance3D:
	var c = CylinderMesh.new()
	c.top_radius = radius
	c.bottom_radius = radius
	c.height = height
	c.radial_segments = sides
	var mi = MeshInstance3D.new()
	mi.mesh = c
	mi.material_override = material
	return mi
