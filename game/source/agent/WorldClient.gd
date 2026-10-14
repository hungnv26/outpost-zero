extends Node

# WebSocket client for the adapter's world feed (see adapter/src/contract.ts).
# Reconnects forever; emits every server message as a Dictionary.

signal connection_changed(online)
signal message_received(msg)

const DEFAULT_URL = "ws://127.0.0.1:8771/world"
const RETRY_S = 2.0

var url = DEFAULT_URL
var online = false

var _ws: WebSocketPeer = null
var _retry_at = 0.0


func _ready():
	var env_url = OS.get_environment("OUTPOST_ZERO_WS")
	if env_url != "":
		url = env_url
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--ws="):
			url = arg.substr(5)


func send_command(cmd: Dictionary):
	if online:
		_ws.send_text(JSON.stringify(cmd))


func _process(_delta):
	var now = Time.get_ticks_msec() / 1000.0
	if _ws == null:
		if now < _retry_at:
			return
		_ws = WebSocketPeer.new()
		_ws.inbound_buffer_size = 4 * 1024 * 1024
		if _ws.connect_to_url(url) != OK:
			_drop(now)
			return
	_ws.poll()
	match _ws.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not online:
				online = true
				connection_changed.emit(true)
				send_command({"type": "hello", "client": "godot"})
			while _ws.get_available_packet_count() > 0:
				var parsed = JSON.parse_string(_ws.get_packet().get_string_from_utf8())
				if parsed is Dictionary:
					message_received.emit(parsed)
		WebSocketPeer.STATE_CLOSED:
			_drop(now)


func _drop(now):
	_ws = null
	_retry_at = now + RETRY_S
	if online:
		online = false
		connection_changed.emit(false)
