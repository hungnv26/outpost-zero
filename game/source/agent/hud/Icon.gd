extends Control

# Small vector icons drawn in code (no image assets): department marks and HUD glyphs.
# kind: research, code, knowledge, meeting, command, approval, rally, repair, bolt, coin,
# logo, plus, minus, fit, mission, check, focus, home, edit, close, clock, agent.

var kind = "logo":
	set(v):
		kind = v
		queue_redraw()
var color = Color.WHITE:
	set(v):
		color = v
		queue_redraw()
var backdrop = Color(0, 0, 0, 0):  # optional rounded square behind the glyph
	set(v):
		backdrop = v
		queue_redraw()


static func make(icon_kind: String, icon_color := Color.WHITE, px := 18.0, back := Color(0, 0, 0, 0)) -> Control:
	var i = load("res://source/agent/hud/Icon.gd").new()
	i.kind = icon_kind
	i.color = icon_color
	i.backdrop = back
	i.custom_minimum_size = Vector2(px, px)
	i.mouse_filter = MOUSE_FILTER_IGNORE
	return i


func _draw():
	var s = min(size.x, size.y)
	var o = (size - Vector2(s, s)) * 0.5
	if backdrop.a > 0.0:
		var sb = StyleBoxFlat.new()
		sb.bg_color = backdrop
		sb.set_corner_radius_all(int(s * 0.25))
		draw_style_box(sb, Rect2(o, Vector2(s, s)))
		o += Vector2(s, s) * 0.18
		s *= 0.64
	var w = max(1.5, s * 0.11)
	var P = func(x, y): return o + Vector2(x, y) * s
	match kind:
		"research":
			draw_arc(P.call(0.42, 0.42), s * 0.27, 0, TAU, 32, color, w, true)
			draw_line(P.call(0.62, 0.62), P.call(0.88, 0.88), color, w * 1.3, true)
		"code":
			draw_polyline([P.call(0.32, 0.24), P.call(0.08, 0.5), P.call(0.32, 0.76)], color, w, true)
			draw_polyline([P.call(0.68, 0.24), P.call(0.92, 0.5), P.call(0.68, 0.76)], color, w, true)
			draw_line(P.call(0.58, 0.16), P.call(0.42, 0.84), color, w, true)
		"knowledge":
			draw_polyline([P.call(0.5, 0.26), P.call(0.3, 0.18), P.call(0.08, 0.2), P.call(0.08, 0.8), P.call(0.3, 0.78), P.call(0.5, 0.86), P.call(0.7, 0.78), P.call(0.92, 0.8), P.call(0.92, 0.2), P.call(0.7, 0.18), P.call(0.5, 0.26), P.call(0.5, 0.86)], color, w, true)
		"meeting", "agent":
			draw_circle(P.call(0.34, 0.32), s * 0.14, color)
			draw_circle(P.call(0.68, 0.32), s * 0.14, color)
			_round_rect(Rect2(P.call(0.12, 0.54), Vector2(s * 0.44, s * 0.34)), color)
			_round_rect(Rect2(P.call(0.46, 0.54), Vector2(s * 0.44, s * 0.34)), color)
		"command":
			var pts = PackedVector2Array()
			for i in 10:
				var r = (0.46 if i % 2 == 0 else 0.2) * s
				var a = -PI / 2 + i * TAU / 10
				pts.append(P.call(0.5, 0.54) + Vector2(cos(a), sin(a)) * r)
			draw_colored_polygon(pts, color)
		"approval", "check":
			if kind == "approval":
				draw_arc(P.call(0.5, 0.5), s * 0.42, 0, TAU, 32, color, w, true)
			draw_polyline([P.call(0.28, 0.52), P.call(0.44, 0.68), P.call(0.74, 0.34)], color, w * 1.2, true)
		"rally":
			draw_line(P.call(0.26, 0.12), P.call(0.26, 0.9), color, w, true)
			draw_colored_polygon(PackedVector2Array([P.call(0.26, 0.14), P.call(0.84, 0.3), P.call(0.26, 0.48)]), color)
		"repair":
			draw_arc(P.call(0.32, 0.32), s * 0.18, 0, TAU, 24, color, w, true)
			draw_line(P.call(0.44, 0.44), P.call(0.86, 0.86), color, w * 1.5, true)
		"bolt":
			draw_colored_polygon(PackedVector2Array([P.call(0.58, 0.04), P.call(0.18, 0.56), P.call(0.46, 0.56), P.call(0.38, 0.96), P.call(0.82, 0.42), P.call(0.54, 0.42), P.call(0.64, 0.04)]), color)
		"coin":
			draw_circle(P.call(0.5, 0.5), s * 0.42, color)
			draw_arc(P.call(0.5, 0.5), s * 0.27, 0, TAU, 24, color.darkened(0.35), w, true)
		"logo":
			var hexagon = PackedVector2Array()
			for i in 7:
				var a = PI / 6 + i * TAU / 6
				hexagon.append(P.call(0.5, 0.5) + Vector2(cos(a), sin(a)) * s * 0.46)
			draw_polyline(hexagon, color, w, true)
			draw_circle(P.call(0.5, 0.5), s * 0.16, color)
		"plus":
			draw_line(P.call(0.5, 0.18), P.call(0.5, 0.82), color, w * 1.2, true)
			draw_line(P.call(0.18, 0.5), P.call(0.82, 0.5), color, w * 1.2, true)
		"minus":
			draw_line(P.call(0.18, 0.5), P.call(0.82, 0.5), color, w * 1.2, true)
		"fit":
			for c in [[0.15, 0.15, 1, 1], [0.85, 0.15, -1, 1], [0.15, 0.85, 1, -1], [0.85, 0.85, -1, -1]]:
				draw_polyline([P.call(c[0], c[1] + 0.25 * c[3]), P.call(c[0], c[1]), P.call(c[0] + 0.25 * c[2], c[1])], color, w, true)
		"mission":
			draw_arc(P.call(0.5, 0.5), s * 0.42, 0, TAU, 32, color, w, true)
			draw_arc(P.call(0.5, 0.5), s * 0.22, 0, TAU, 24, color, w, true)
			draw_circle(P.call(0.5, 0.5), s * 0.07, color)
		"focus":
			draw_arc(P.call(0.5, 0.5), s * 0.3, 0, TAU, 32, color, w, true)
			for d in [Vector2(0, -1), Vector2(0, 1), Vector2(-1, 0), Vector2(1, 0)]:
				draw_line(P.call(0.5, 0.5) + d * s * 0.3, P.call(0.5, 0.5) + d * s * 0.48, color, w, true)
		"home":
			draw_polyline([P.call(0.1, 0.5), P.call(0.5, 0.14), P.call(0.9, 0.5)], color, w, true)
			draw_polyline([P.call(0.22, 0.42), P.call(0.22, 0.86), P.call(0.78, 0.86), P.call(0.78, 0.42)], color, w, true)
		"edit":
			draw_line(P.call(0.2, 0.8), P.call(0.78, 0.22), color, w * 1.6, true)
			draw_line(P.call(0.14, 0.88), P.call(0.24, 0.86), color, w, true)
		"close":
			draw_line(P.call(0.22, 0.22), P.call(0.78, 0.78), color, w * 1.2, true)
			draw_line(P.call(0.78, 0.22), P.call(0.22, 0.78), color, w * 1.2, true)
		"clock":
			draw_arc(P.call(0.5, 0.5), s * 0.42, 0, TAU, 32, color, w, true)
			draw_polyline([P.call(0.5, 0.24), P.call(0.5, 0.5), P.call(0.68, 0.6)], color, w, true)


func _round_rect(r: Rect2, c: Color):
	var sb = StyleBoxFlat.new()
	sb.bg_color = c
	sb.set_corner_radius_all(int(r.size.y * 0.45))
	draw_style_box(sb, r)
