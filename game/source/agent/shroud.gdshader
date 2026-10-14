shader_type spatial;
render_mode unshaded, depth_draw_never, depth_test_disabled, cull_disabled, shadows_disabled, fog_disabled;

// "Unexplored" shroud over the world outside the base, like the fog of a strategy game.
// Drawn as a full-screen quad: each pixel's world position comes from the depth buffer, so
// trees, rocks and props darken with the ground. The explored area is a rounded square
// around the base (so the corners go dark first) with a noisy, organic edge. Static.

uniform sampler2D depth_tex : hint_depth_texture, filter_nearest;
uniform sampler2D noise_tex : repeat_enable, filter_linear;
uniform sampler2D reveal_tex : filter_linear, repeat_disable;  // land explored by agents (white = explored)
uniform vec3 reveal_rect = vec3(-30.0, -30.0, 104.0);  // world min x, min z, size
uniform vec2 centre = vec2(22.0, 22.0);
uniform vec2 half_size = vec2(26.0, 26.0);  // explored area (base plus a margin), before rounding
uniform float corner = 20.0;  // rounding of the explored square: the base's corners fade out
uniform float edge = 9.0;  // width of the soft edge
uniform float strength = 0.93;  // darkness of fully unexplored ground
uniform vec3 shade : source_color = vec3(0.02, 0.03, 0.05);
uniform vec3 mist : source_color = vec3(0.13, 0.15, 0.2);

float rounded_box(vec2 p, vec2 b, float r) {
	vec2 q = abs(p) - b + vec2(r);
	return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void vertex() {
	POSITION = vec4(VERTEX.xy, 1.0, 1.0);
}

void fragment() {
	float depth = texture(depth_tex, SCREEN_UV).x;
	vec4 view = INV_PROJECTION_MATRIX * vec4(SCREEN_UV * 2.0 - 1.0, depth, 1.0);
	view.xyz /= view.w;
	vec3 world = (INV_VIEW_MATRIX * vec4(view.xyz, 1.0)).xyz;
	float n = texture(noise_tex, world.xz * 0.025).r;
	float n2 = texture(noise_tex, world.xz * 0.09 + vec2(0.37, 0.71)).r;
	float d = rounded_box(world.xz - centre, half_size, corner);
	d += (n - 0.5) * 10.0 + (n2 - 0.5) * 3.0;
	float fog = smoothstep(0.0, edge, d) * strength;
	vec2 ruv = (world.xz - reveal_rect.xy) / reveal_rect.z;
	bool inside = all(greaterThanEqual(ruv, vec2(0.0))) && all(lessThanEqual(ruv, vec2(1.0)));
	float explored = inside ? texture(reveal_tex, ruv).r : 0.0;
	fog *= 1.0 - smoothstep(0.2, 0.85, explored + (n2 - 0.5) * 0.35);
	ALBEDO = mix(shade, mist, n * 0.6);
	ALPHA = fog;
}
