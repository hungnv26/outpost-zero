extends RefCounted

# Shared look of the HUD: one font family (the system UI font), navy translucent panels
# with a thin light border, and the palette. Built in code like the rest of the HUD.

const BG = Color(0.055, 0.075, 0.125, 0.9)
const BG_ROW = Color(0.1, 0.13, 0.2, 0.85)
const BG_SELECTED = Color(0.13, 0.25, 0.45, 0.95)
const BORDER = Color(0.45, 0.6, 0.85, 0.28)
const TEXT = Color(0.92, 0.94, 0.98)
const MUTED = Color(0.6, 0.66, 0.76)
const ACCENT = Color(0.36, 0.68, 1.0)
const GOOD = Color(0.4, 0.9, 0.55)
const WARN = Color(1.0, 0.7, 0.3)
const BAD = Color(1.0, 0.42, 0.42)

static var _theme: Theme
static var _bold: Font


static func font(weight := 500) -> Font:
	var f = SystemFont.new()
	f.font_names = PackedStringArray(["Avenir Next", "Segoe UI", "Helvetica Neue", "Arial"])
	f.font_weight = weight
	f.antialiasing = TextServer.FONT_ANTIALIASING_GRAY
	return f


static func bold() -> Font:
	if _bold == null:
		_bold = font(700)
	return _bold


static func theme() -> Theme:
	if _theme == null:
		_theme = Theme.new()
		_theme.default_font = font(500)
		_theme.default_font_size = 15
		_theme.set_color("font_color", "Label", TEXT)
		_theme.set_stylebox("panel", "TooltipPanel", panel_style(Color(0.06, 0.08, 0.13, 0.97), 6, 8))
	return _theme


static func panel_style(bg := BG, radius := 10, margin := 12, border := BORDER) -> StyleBoxFlat:
	var sb = StyleBoxFlat.new()
	sb.bg_color = bg
	sb.border_color = border
	sb.set_border_width_all(1)
	sb.set_corner_radius_all(radius)
	sb.content_margin_left = margin
	sb.content_margin_right = margin
	sb.content_margin_top = margin - 2
	sb.content_margin_bottom = margin - 2
	sb.shadow_color = Color(0, 0, 0, 0.35)
	sb.shadow_size = 6
	sb.anti_aliasing = true
	return sb


static func row_style(bg := BG_ROW, radius := 8) -> StyleBoxFlat:
	var sb = StyleBoxFlat.new()
	sb.bg_color = bg
	sb.set_corner_radius_all(radius)
	sb.content_margin_left = 8
	sb.content_margin_right = 10
	sb.content_margin_top = 6
	sb.content_margin_bottom = 6
	sb.anti_aliasing = true
	return sb


static func bar_style(color: Color, radius := 3) -> StyleBoxFlat:
	var sb = StyleBoxFlat.new()
	sb.bg_color = color
	sb.set_corner_radius_all(radius)
	return sb


# A thin rounded progress bar (value 0..1) in `color`.
static func progress_bar(color: Color, height := 5.0) -> ProgressBar:
	var b = ProgressBar.new()
	b.show_percentage = false
	b.min_value = 0.0
	b.max_value = 1.0
	b.custom_minimum_size = Vector2(0, height)
	b.add_theme_stylebox_override("background", bar_style(Color(1, 1, 1, 0.09)))
	b.add_theme_stylebox_override("fill", bar_style(color))
	b.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return b
