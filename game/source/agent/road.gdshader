shader_type spatial;
render_mode cull_disabled, shadows_disabled;

// A packed-dirt track on the Martian sand: darker centre, soft edges, tyre ruts.
// `in_use` (0..1) darkens it a little while an agent travels or works at its end.

uniform vec3 dirt : source_color = vec3(0.62, 0.42, 0.36);
uniform float in_use = 0.0;
uniform float paved = 0.0;  // 1: base street with kerbs and a dashed centre line
uniform float length = 40.0;  // world length, for the dash spacing

void fragment() {
	float across = abs(UV.x - 0.5) * 2.0;
	float body = 1.0 - smoothstep(0.55, 1.0, across);
	float ruts = (1.0 - smoothstep(0.0, 0.12, abs(across - 0.45))) * 0.35;
	float ends = smoothstep(0.0, 0.08, UV.y) * (1.0 - smoothstep(0.92, 1.0, UV.y));
	vec3 col = dirt * (1.0 - ruts * 0.25 - in_use * 0.12);
	float alpha = body * ends * (0.55 + 0.25 * in_use);
	if (paved > 0.5) {
		col = mix(dirt * 0.45, vec3(0.13, 0.13, 0.14), 0.6);
		float kerb = step(0.84, across) * step(across, 0.94);
		float dash = step(across, 0.05) * step(0.55, fract(UV.y * length / 1.6));
		col = mix(col, vec3(0.62, 0.6, 0.55), kerb * 0.6 + dash * 0.7);
		alpha = (1.0 - smoothstep(0.95, 1.0, across)) * 0.92;
	}
	ALBEDO = col;
	ROUGHNESS = 1.0;
	ALPHA = alpha;
}
