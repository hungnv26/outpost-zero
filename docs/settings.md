# Settings live in Mission Control

Neither game has a settings screen. Outpost Zero's Settings tab and Outpost War's Options screen
are gone. Every setting, including which game the window shows, is a **settings card** in Mission
Control (127.0.0.1:3001), the same way battles are battle cards (docs/outpost-war.md).

## No sign-in

Mission Control opens straight on the dashboard: http://127.0.0.1:3001 has no sign-in screen.
Mission Control itself runs unmodified on 127.0.0.1:3011; `tools/mc_open.mjs` serves 3001 in front of
it, signs in once with the admin account in `.env` (`MC_ADMIN_USER` / `MC_ADMIN_PASS`, never sent
to the browser) and adds that session to requests addressed to 127.0.0.1:3001 or localhost:3001
from its own pages. `/login` goes to the dashboard and signing out does nothing. Callers with an
API key (the adapter, the battle service, the director) pass through unchanged.
`scripts/start.sh` starts both and `scripts/stop.sh` stops both.

Both ports are bound to 127.0.0.1, so only this Mac reaches them, but any program on this Mac now
gets Mission Control as admin without a password. Requests from another site's page (a foreign
`Origin`) or for another host name get no session. To sign in again, stop the relay and open
http://127.0.0.1:3011.

## The settings card

A settings card is any Mission Control task whose description holds a `settings:` block. Any
status works (keep one "Game settings" task in the inbox). When several tasks hold one, the most
recently updated wins. Only the settings a card lists change; the rest keep their last values.

```
settings:
  game: outpost zero        # or outpost war
  display: window           # or fullscreen
  window size: 1920x1080    # 1280x720, 1920x1080, 2560x1440, 3200x1800, 3840x2160
  3d resolution: 100%       # 50%, 67%, 75%, 100% (lower runs faster on large screens)
  anti-aliasing: 2x         # off, 2x, 4x
  menu text: 80%            # 70%, 80%, 90%, 100%, 120%
  map labels: 60%           # 30% to 80%, in steps of 10%
  map zoom: 44              # 12 (close) to 72 (far); the mouse wheel still zooms
```

- **Changes apply in about five seconds.** The colony adapter relays the card to Outpost Zero
  windows (`settings.update` on the world feed). The battle service relays it to Outpost War
  windows. Each window applies only the values that differ.
- **`game` switches the window** between Outpost Zero and Outpost War. The window restarts in the
  other game. `scripts/start.sh` starts the battle service with the full stack so this works in
  both directions.
- **A card with mistakes gets one comment** on its task listing them. The colony adapter writes
  it, or the battle service when the adapter isn't running. The window keeps its current settings
  until the card is fixed.
- **Outpost War's display:** between battles it follows the card. During a battle it uses the
  battle card's `screen` and `mouse`.

## Windows that keep their own settings

A window started with an explicit `--mode` keeps its game, and a tool window keeps its display.
That covers the Arena Setup team windows, `tools/record_match.sh`, screenshot captures
(`--capture-dir`), placed windows (`--window=`) and the smoke tests. `scripts/start.sh` launches the
normal window without `--mode`, so it follows the card. `scripts/start.sh --war` uses
`--prefer-mode=outpost-war`, which picks Outpost War first but still follows the card.

Code: `adapter/src/settings-card.ts` (parser, newest card), `adapter/src/sinks/mission-control.ts`
(polling, comments), `adapter/src/battle-main.ts` (Outpost War), `GameMode.follow` and
`AgentMatch._apply_mc_settings` / `BattleClient._apply_settings` in the game; tests in
`adapter/test/settings.test.ts`.
