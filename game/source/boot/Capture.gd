extends Node

# Saves viewport screenshots at given seconds; lives under the root so scene changes keep it.

var dir = ""
var times = []
var quit_after = false


func _ready():
	process_mode = Node.PROCESS_MODE_ALWAYS
	DirAccess.make_dir_recursive_absolute(dir)
	for t in times:
		get_tree().create_timer(t, true, false, true).timeout.connect(_shot.bind(t))


func _shot(t: float):
	get_viewport().get_texture().get_image().save_png("%s/war_%03d.png" % [dir, int(t)])
	if quit_after and t == times.max():
		get_tree().quit()
