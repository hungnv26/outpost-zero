extends Control

# Outpost War's waiting screen: no buttons at all. Battles are set up on the Arena Setup page
# (docs/outpost-war.md); this screen shows the title and what the link to it is doing. Close the
# window to quit.

@onready var _status = find_child("Status")


func _ready():
	var client = get_tree().root.get_node_or_null("BattleClient")
	if client != null:
		_status.text = client.status
		client.status_changed.connect(func(text): _status.text = text)
	else:
		_status.text = "Not linked to the battle service (open Outpost War from Arena Setup, http://127.0.0.1:8790)"

