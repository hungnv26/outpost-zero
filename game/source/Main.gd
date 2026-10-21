extends Control

const GameMode = preload("res://source/boot/GameMode.gd")

@onready var _logos = find_child("Logos")


func _ready():
	var to_menu = get_tree().change_scene_to_file.bind("res://source/main-menu/Main.tscn")
	# Outpost Zero: Outpost War opens with its own title sequence instead of the logos.
	if GameMode.running == GameMode.OUTPOST_WAR and DisplayServer.get_name() != "headless":
		var intro = load("res://source/war/WarIntro.gd").new()
		add_child(intro)
		intro.tree_exited.connect(to_menu)
		return
	_logos.tree_exited.connect(to_menu)
