extends Node3D

# Outpost War's sound (docs/outpost-war.md). Open RTS has no sound effects of its own, only voice
# lines for a human player, so a battle between AI models was silent. This node plays synthesised
# effects (game/assets/sfx/, made by tools/make_war_sounds.py): cannon and rocket shots, explosions,
# buildings placed and finished, units rolling out, and wind under it all.
# Each effect comes from where it happens (panned left or right of the camera), repeats are rate
# limited and only a few play at once, so a big fight stays listenable.

const SFX = "res://assets/sfx/"
const POOL_SIZE = 10
# name -> [volume dB, minimum seconds between two of them]
const EFFECTS = {
	"cannon": [-9.0, 0.09],
	"rocket": [-11.0, 0.09],
	"explosion_small": [-6.0, 0.12],
	"explosion_large": [-3.0, 0.3],
	"build_start": [-12.0, 0.3],
	"build_done": [-10.0, 0.5],
	"unit_ready": [-16.0, 0.4],
}
const AMBIENT_DB = -20.0

const Structure = preload("res://source/match/units/Structure.gd")

var _streams = {}
var _last_played = {}
var _pool = []
var _next = 0
var _ambient: AudioStreamPlayer = null


func _ready():
	process_mode = Node.PROCESS_MODE_PAUSABLE
	for name in EFFECTS.keys() + ["ambient_wind"]:
		var stream = AudioStreamWAV.load_from_file(SFX + name + ".wav")
		if stream != null:
			_streams[name] = stream
	for i in POOL_SIZE:
		var p = AudioStreamPlayer3D.new()
		p.attenuation_model = AudioStreamPlayer3D.ATTENUATION_DISABLED
		p.panning_strength = 0.7
		p.max_polyphony = 1
		add_child(p)
		_pool.append(p)
	if _streams.has("ambient_wind"):
		var wind: AudioStreamWAV = _streams["ambient_wind"]
		wind.loop_mode = AudioStreamWAV.LOOP_FORWARD
		wind.loop_end = int(wind.get_length() * wind.mix_rate)
		_ambient = AudioStreamPlayer.new()
		_ambient.stream = wind
		_ambient.volume_db = AMBIENT_DB
		add_child(_ambient)
		_ambient.play()
	get_tree().node_added.connect(_on_node_added)
	MatchSignals.unit_died.connect(_on_unit_died)
	MatchSignals.unit_spawned.connect(_on_unit_spawned)
	MatchSignals.unit_construction_finished.connect(func(unit): play("build_done", unit.global_position))
	MatchSignals.unit_production_finished.connect(func(unit, _producer): play("unit_ready", unit.global_position))


func play(name: String, at: Vector3):
	if not _streams.has(name) or not is_inside_tree():
		return
	var now = Time.get_ticks_msec() / 1000.0
	if now - float(_last_played.get(name, -10.0)) < EFFECTS[name][1]:
		return
	_last_played[name] = now
	if OS.has_feature("debug") and OS.get_environment("OUTPOST_SOUND_LOG") == "1":
		print("SOUND %s" % name)
	var p: AudioStreamPlayer3D = _pool[_next]
	_next = (_next + 1) % _pool.size()
	p.stop()
	p.stream = _streams[name]
	p.volume_db = EFFECTS[name][0]
	p.pitch_scale = randf_range(0.92, 1.08)
	p.global_position = at
	p.play()


# Every shot is a projectile node added under the unit that fires it.
func _on_node_added(node: Node):
	var script = node.get_script()
	if script == null:
		return
	var path: String = script.resource_path
	if path.ends_with("CannonShell.gd"):
		_from_shooter.call_deferred(node, "cannon")
	elif path.ends_with("Rocket.gd"):
		_from_shooter.call_deferred(node, "rocket")


func _from_shooter(projectile: Node, name: String):
	if not is_instance_valid(projectile) or not projectile.is_inside_tree():
		return
	var shooter = projectile.get_parent()
	if shooter is Node3D:
		play(name, shooter.global_position)


# Open RTS signals a death whenever a unit leaves the scene, including when a finished battle is
# cleared away: only units brought down to 0 health explode. The unit is already out of the tree,
# so its position is read from its own transform (its player node sits at the origin).
func _on_unit_died(unit):
	if not is_instance_valid(unit) or not ("hp" in unit) or unit.hp == null or unit.hp > 0:
		return
	play("explosion_large" if unit is Structure else "explosion_small", unit.transform.origin)


func _on_unit_spawned(unit):
	if unit is Structure and not unit.is_constructed():
		play("build_start", unit.global_position)
