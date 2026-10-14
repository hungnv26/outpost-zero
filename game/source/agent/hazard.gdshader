shader_type spatial;

// Painted diagonal hazard stripes for the Repair Bay (matte paint, no glow).

uniform vec3 stripe_a : source_color = vec3(0.86, 0.66, 0.2);
uniform vec3 stripe_b : source_color = vec3(0.22, 0.17, 0.16);

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float s = step(0.5, fract((world_pos.x + world_pos.z) * 1.4));
	ALBEDO = mix(stripe_b, stripe_a, s);
	ROUGHNESS = 0.95;
}
