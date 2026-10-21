# Outpost War

Outpost War is the real-time strategy battle that ships alongside Outpost Zero. It is
[Open RTS](https://github.com/lampe-games/godot-open-rts) by Lampe Games (MIT), the Godot 4 game
this project is built on, played as it was made: a deathmatch of one species with two resources
(Resource A and B). You have workers, tanks, helicopters and drones, vehicle and aircraft
factories, turrets and a Command Center, and you fight scripted computer players under fog of
war, with a minimap. The window opens with Outpost War's own title sequence (`war/WarIntro.gd`, about 3.5 s: the title
over the menu's backdrop with a low boom, a line, the tagline, then the menu); a click or key skips
it, and so does a battle arriving. No Godot or Lampe Games logo. Open RTS and Lampe Games are credited in
`game/LICENSE` (MIT) and the README; the game has no Credits screen.

## Setting up a battle: the Arena Setup page

Outpost War has no Play or Options screen and no game switch. Its main menu shows the OUTPOST WAR
title and the state of its link to the battle service, with no buttons (close the window to
quit). Battles are set up on the
same Arena Setup page that runs Outpost Zero's races (http://127.0.0.1:8790), on its **Outpost War**
tab (http://127.0.0.1:8790/#war):

1. Run `scripts/start.sh --war` (the battle service `adapter/src/battle-main.ts` on 127.0.0.1:8796,
   Arena Setup and the game window; no agents, adapter, model or Mission Control), or open Arena
   Setup on its own with `node tools/arena_setup.mjs`: the page starts the battle service when
   needed.
2. **Battle**: the map, the number of players, and for each one an AI model (provider, model and
   API key; docs/rts-arena.md), the scripted computer player or you (one human at most); the
   speed, the time limit in game minutes, the token budget per model, fog of war, window or
   fullscreen, and whether the mouse is kept inside the window. *Save battle settings* keeps them
   for next time.
3. **Play**: *Open Outpost War window* opens the game; *Start battle* hands the battle to it
   (opening a window if none is connected; a fresh window plays its 1.5 s intro first, then the
   battle starts); *Stop battle* ends it.
4. When the battle ends (one side left, the time limit, or the human leaving through the match
   menu), the page shows the winner, the game time and each side's units and buildings, and the
   game returns to its menu.

The page sends the battle as a battle card (below) with the referee token (`ARENA_TOKEN` in
`.env`), so the battle service checks it with the same rules whichever way it arrives.

### The battle card

```
battle:
  map: Plain & Simple        # or Big Arena
  players:                   # colours in slot order: blue, red, green, purple,
    - blue: human            #   darkgreen, khaki, navy, turquoise (4 on Plain & Simple)
    - red: ai                # ai = the scripted opponent; one human at most
    - green: openai:gpt-5    # an AI model, provider:model (docs/rts-arena.md)
  speed: 1                   # 0.25 to 4 (game time scale)
  minutes: 30                # game-time limit, then the side ahead on value wins; 0 = none
  fog: on                    # off shows the whole map
  screen: window             # or fullscreen
  mouse: free                # or restricted (kept inside the window)
  budget: 400k               # tokens per model player
```

Only `map` and `players` are required. Model players name `anthropic`, `openai`, `openrouter` or
`ollama` and a model.

Mission Control battle tasks are off by default. With `BATTLE_FROM_MC=1` in the battle service's
environment, a Mission Control task whose description holds this card and is moved to In progress
starts the battle too, the result comes back as a comment and the task is marked done.

## Maps

- **Duel** (2 players, 80 x 44 m, bases 56 m apart): Outpost Zero's map for two. The bases face each other across the
  middle, mirrored exactly, each with three A deposits and one B. The default on Arena Setup.
- **Plain & Simple** (up to 4) and **Big Arena** (up to 8): Open RTS's maps. With fewer players than
  bases the empty bases' deposits stay on the map.

## Outpost Zero's look

A battle is fought on one of Outpost Zero's ten battlefields (design/maps.json), chosen on Arena
Setup (**Battlefield**: one of them, random, or none for Open RTS's plain map; card line
`battlefield:`). The battle service sends the battlefield to the game, and
`game/source/war/WarDressing.gd` dresses the map when the battle loads:

- **Terrain and light:** the battlefield's ground textures (Mars, Sahara, Arctic, Grassland...)
  continue past the map's edge, with its sun and ambient light (`agent/Terrains.gd`).
- **Scenery:** Outpost Zero's trees, rocks, craters, mesas, crystals and water around the map
  (`agent/Scenery.gd`); outside the playable area, so it never gets in the way.
- **Battlefield items:** the battlefield's structures and obstacles (wrecks, relays, ruins,
  hangars, ridges, craters, lakes...) between the bases, drawn by `agent/Battlefield.gd`. They block
  movement and building, so the layout is generated in one quarter of the map and mirrored into
  the other three, as the spawns are: every side faces the same ground. Spawns, deposits and a lane
  from each base to the centre stay clear, and items keep gaps a tank fits through.
- **Units:** Outpost Zero's models in place of Open RTS's (`war/WarSkins.gd`), machines and armed
  people only: soldiers with guns for workers, tanks and combat mechs for tanks, spaceship gunships
  for helicopters, a speeder for the scout drone,
  a large dome for the command center, a garage module, a hangar and Kenney turrets for the other
  buildings. Each keeps its Open RTS body (health, weapons, speed); a ring in the team's colour at
  its feet tells the sides apart, and characters walk, stand and shoot with what they do.
- **Watching:** with nobody human playing (or fog off) the whole map shows, scenery included, and
  the camera starts over the middle of the map.

## Sound

Open RTS has no sound effects, only voice lines for a human player, so battles between AI models
were silent. `war/WarSound.gd` plays synthesised effects from `game/assets/sfx/` (made by
`python3 tools/make_war_sounds.py`; no recordings, so nothing to license): cannon shots (tanks,
ground turrets), rocket shots (helicopters, air turrets), small and large explosions when units and
buildings are destroyed, a clank when a building is placed, a chime when it is finished, a blip
when a unit rolls out, and wind underneath. Each is panned to where it happens, repeats are rate
limited and at most ten play at once. `OUTPOST_SOUND_LOG=1` prints every sound to the game log.

## Switching between the games

Arena Setup opens each game's windows with an explicit `-- --mode=outpost-war|outpost-zero`, and
such a window keeps that mode (so do tools, recorders and team windows). A window started without
`--mode` follows `game:` on the Mission Control settings card (docs/settings.md); the
old id `open-rts` is still accepted. The start scene is `game/source/boot/Boot.tscn`
(`game/source/boot/GameMode.gd`).

## What differs between the modes

| | Outpost Zero | Outpost War |
|---|---|---|
| Start | the colony (`agent/AgentMatch.tscn`) | the Godot logo (1.5 s), then the OUTPOST WAR menu, waiting for a battle |
| Setup | the Arena Setup page (Outpost Zero tab) | the Arena Setup page (Outpost War tab) |
| Settings | the Mission Control settings card | the battle's own display settings on Arena Setup |
| Match end | its own (races, endings) | Open RTS's victory, defeat and finish screens |
| God mode | off | off (the `toggle_god_mode` key still works) |
| Names on screen | colony terms, no Agent RTS era terms | Open RTS's own (Command Center, Resource A and B) |
| Services | Hermes, adapter, optionally Mission Control | the battle service and Arena Setup (no agents or model) |
| Window title | Outpost Zero | Outpost War |

Outpost War windows use Outpost Zero's display settings (`user://outpost_zero_settings.cfg` and the
Mission Control settings card's window size, 3D resolution and anti-aliasing; docs/settings.md):
window size in real pixels up to 4K, with the menus and HUD scaled to the window. Open RTS alone
opened 1600x900 without anti-aliasing. Outpost War's display settings (window or fullscreen, mouse) come from each battle and are
stored in Open RTS's `user://options` resource; Outpost Zero keeps `outpost_zero_settings.cfg`.

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

- **Every helicopter and drone froze the game for 5 to 10 seconds** (found 2026-10-20). The air
  navigation map stayed empty: Godot 4.5+ builds region data on a background thread, and on the
  separately created air map that build never landed. Placing a new aircraft then found no
  walkable spot, searched about 195,000 positions out to 150 m and dropped it on its factory.
  `AirNavigation` now builds the air region in place. A placement search over 50 ms, and a frame
  over half a second during a battle, are printed to the game log (`SLOW ...`, `STALL ...`).
- **Starting units were teleported to the map's corner** (found 2026-10-20). A new unit snaps
  onto the navigation map one frame after it appears; at a match's start the map is still being
  built in the background, so the nearest point came back as (0, 0) and every starting worker and
  drone landed in the top-left corner. The side spawned there barely noticed; the other side's
  workers then gathered at its opponent's deposits and carried every load across the map.
  `Movement` now waits for the map and only ever corrects a unit's height.
- **The ending:** when a battle is decided the final scene freezes for 10 seconds, then the
  ending screen (`war/EndingScreen.gd`) shows the winner and who played it, how it was won, the game
  time and battlefield, and each side's units and buildings left, with each AI model's turns, tokens
  and orders (sent by the battle service as `battle.summary`). It stays up 45 seconds, or until the
  next battle starts, then the menu returns.
- **A battle ends when a side loses its last building** (finished or being built), not its last
  unit: a couple of aircraft the winner's tanks cannot shoot no longer drag a lost battle on. The
  final scene freezes for a moment before the menu returns.

Earlier Outpost Zero changes to Open RTS files keep the original behaviour when Outpost Zero's
settings are absent. They are the camera tilt, no keyboard panning while typing, the navigation
margin, two crash guards and the MovementObstacle snap fix.

## Checking it

`tools/war_smoke.sh` (or `--quick`) plays unattended computer-only matches through the boot
scene, using `-- --mode=outpost-war --war-autoplay=MAP --war-players=N --war-speed=N` (a test
hook, not a setting). These must end with a winner, or with one side holding 80% of the value
when a scripted stall runs into the time limit. The battle lobby and card parser are covered by
`adapter/test/battle.test.ts`. It also runs Open RTS's manual test scenes (`game/tests/manual`), and none of
this may log a script error. Run it after any change to the original Open RTS files: everything
in `game/source` outside `agent/` and `boot/`.

Last run (2026-10-19, Godot 4.7.2): Plain & Simple with 2 computer players finished at 149 s of
game time; Big Arena with 4 finished at 909 s; all five test scenes passed.

Verified end to end on 2026-10-19: a Mission Control task (75) with a blue-against-red computer
card started the battle in the game window; blue won at 1:52 of game time, the result came back
as a comment and the task was marked done.

Verified end to end on 2026-10-20 from Arena Setup: a blue-against-red computer battle at 4× with
no window open; the page opened Outpost War, the battle waited out the intro and started, blue won
at 1:43 of game time and the result showed on the page. (The first try found that a battle sent
during the intro was lost when the intro switched to the menu; `BattleClient` now holds it until
the menu is up.)
