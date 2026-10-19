extends Control


func _on_play_button_pressed():
	get_tree().change_scene_to_file("res://source/main-menu/Play.tscn")


func _on_options_button_pressed():
	get_tree().change_scene_to_file("res://source/main-menu/Options.tscn")


func _on_credits_button_pressed():
	get_tree().change_scene_to_file("res://source/main-menu/Credits.tscn")


# Outpost Zero: the colony game this project grew into (docs/open-rts-mode.md). Restarts the game.
func _on_outpost_zero_button_pressed():
	preload("res://source/boot/GameMode.gd").switch_to(get_tree(), "outpost-zero")


func _on_quit_button_pressed():
	get_tree().quit()
