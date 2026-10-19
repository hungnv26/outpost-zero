# Open RTS mode

Outpost Zero is built on [Open RTS](https://github.com/lampe-games/godot-open-rts) (Lampe Games,
MIT), a Godot 4 real-time strategy game with no story: a deathmatch of one species, two resources
(Resource A and B), workers, tanks, helicopters, drones, vehicle and aircraft factories, turrets and
a Command Center, against scripted computer players, with fog of war and a minimap. All of it is
still in this project, and Open RTS mode plays it as it was made.

## Switching

- **Start scene:** `game/source/boot/Boot.tscn` picks the mode
  (`game/source/boot/GameMode.gd`). The order is `-- --mode=open-rts|outpost-zero` on the command
  line, then the last choice (`user://game_mode.cfg`), then Outpost Zero.
- **From Outpost Zero:** Settings, Game mode, **Switch to Open RTS** (press twice to confirm).
- **From Open RTS:** the **Outpost Zero** button on its main menu.
- **What a switch does:** it saves the choice and restarts the game with the project's absolute
  path. That keeps the world feed, the shroud, lighting and window settings from leaking between
  modes.
- **Launching Open RTS directly:** `scripts/start.sh --classic` opens it without starting Hermes,
  Mission Control, the adapter or Ollama, since Open RTS needs none of them.
- **Outpost Zero launchers:** `scripts/start.sh`, the Arena Setup page and `tools/record_match.sh`
  always pass `--mode=outpost-zero`.

## What differs between the modes

| | Outpost Zero | Open RTS |
|---|---|---|
| Start | the colony (`agent/AgentMatch.tscn`) | Open RTS logos, then its main menu |
| Match end | its own (races, endings) | Open RTS's victory, defeat and finish screens |
| God mode | off | off (its `toggle_god_mode` key still works) |
| Names on screen | colony terms, no Agent RTS era terms | Open RTS's own (Command Center, Resource A and B) |
| Services | Hermes, adapter, optionally Mission Control | none |
| Window title | Outpost Zero | Open RTS |

The two modes keep separate saved settings: Open RTS's `user://options` resource and Outpost
Zero's `outpost_zero_settings.cfg`.

## Fixes to Open RTS for Godot 4.7

Open RTS targets Godot 4.3, and this project runs 4.7. Two problems stopped full matches:

- **The navigation rebuild froze the match.** Since Godot 4.4 an asynchronous bake clears the mesh
  it bakes into. `TerrainNavigation._rebake` baked into the live mesh, so the map had no walkable
  area until the bake finished. Unit placement then found nothing navigable and searched up to
  999,999 rings, freezing the game about 60 to 90 seconds into every match. It now bakes into a
  copy and swaps it in when done. `UnitPlacementUtils` also stops searching beyond 150 m (more than
  any map needs) as a safety net.
- **Computer players stopped re-arming.** `OffenseController` never formed a new battlegroup after
  losing one, so a computer player without armies stopped producing and the match could stall
  forever. It now re-arms.

Earlier Outpost Zero changes to Open RTS files keep the original behaviour when Outpost Zero's
settings are absent. They are the camera tilt, no keyboard panning while typing, the navigation
margin, two crash guards and the MovementObstacle snap fix.

## Checking it

`tools/classic_smoke.sh` (or `--quick`) plays unattended computer-only matches through the new
boot scene. These must end with a winner. It also runs upstream's manual test scenes
(`game/tests/manual`), and none of this may log a script error. Run it after any change to Open
RTS's own files: everything in `game/source` outside `agent/` and `boot/`.

Last run (2026-10-19, Godot 4.7.2): Plain & Simple with 2 computer players finished at 149 s of
game time; Big Arena with 4 finished at 909 s; all five test scenes passed.
