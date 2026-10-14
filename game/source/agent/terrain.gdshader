shader_type spatial;

// Textured ground for every terrain (sets baked by tools/bake_terrains.py).
// - detail textures tile every `tile_size` world units; a second, rotated sample blended by
//   low-frequency noise hides the repetition
// - a macro layer (every `macro_size` units) adds large dunes/craters/brightness variation
// Static: no animation, no emission.

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D rough_tex : filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D macro_tex : filter_linear_mipmap, repeat_enable;
uniform float tile_size = 5.0;
uniform float macro_size = 32.0;
uniform float normal_strength = 1.0;
uniform float macro_strength = 1.0;
uniform vec3 tint : source_color = vec3(1.0);
uniform float metallic_value = 0.0;

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 p = world_pos.xz;
	vec2 uv1 = p / tile_size;
	// Second sample: rotated ~37 degrees, slightly rescaled and offset.
	mat2 rot = mat2(vec2(0.8, 0.6), vec2(-0.6, 0.8));
	vec2 uv2 = rot * (uv1 * 0.83) + vec2(0.37, 0.71);

	vec4 macro = texture(macro_tex, p / macro_size);
	float blend = smoothstep(0.3, 0.7, macro.a);

	vec3 a1 = texture(albedo_tex, uv1).rgb;
	vec3 a2 = texture(albedo_tex, uv2).rgb;
	vec3 albedo = mix(a1, a2, blend);
	albedo *= mix(1.0, macro.b * 2.0, macro_strength * 0.8);

	vec3 n1 = texture(normal_tex, uv1).rgb * 2.0 - 1.0;
	vec3 n2 = texture(normal_tex, uv2).rgb * 2.0 - 1.0;
	n2.xy = transpose(rot) * n2.xy;  // undo the sample rotation
	vec3 n = normalize(mix(n1, n2, blend));
	vec2 mn = (macro.rg * 2.0 - 1.0) * macro_strength;
	n = normalize(vec3(n.xy + mn, n.z));

	float r = mix(texture(rough_tex, uv1).r, texture(rough_tex, uv2).r, blend);

	ALBEDO = albedo * tint;
	NORMAL_MAP = n * 0.5 + 0.5;
	NORMAL_MAP_DEPTH = normal_strength;
	ROUGHNESS = r;
	METALLIC = metallic_value;
}
