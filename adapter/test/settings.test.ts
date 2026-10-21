import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "../src/contract.ts";
import { parseSettingsCard, pickSettingsTask } from "../src/settings-card.ts";
import { World } from "../src/world.ts";

test("the settings card carries every former in-game setting", () => {
  const r = parseSettingsCard(`My game settings
\`\`\`
settings:
  game: Outpost War
  display: fullscreen
  window size: 2560x1440
  3d resolution: 75%
  anti-aliasing: 4x
  menu text: 90%
  map labels: 50%   # smaller names over the units
  map zoom: 30
\`\`\``);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.settings, { game: "outpost-war", fullscreen: true, window_size: [2560, 1440], render_scale: 0.75, msaa: 2, text_size: 0.9, label_size: 0.5, zoom: 30 });
  // A partial card changes only what it lists.
  const part = parseSettingsCard("settings:\n  game: outpost zero");
  assert.ok(part.ok && JSON.stringify(part.settings) === JSON.stringify({ game: "outpost-zero" }));
});

test("a settings card with mistakes lists each one", () => {
  const r = parseSettingsCard("settings:\n  game: chess\n  display: huge\n  window size: 800x600\n  3d resolution: 60%\n  anti-aliasing: 8x\n  map zoom: 200\n  volume: 3");
  assert.equal(r.ok, false);
  if (r.ok) return;
  const all = r.errors.join("\n");
  for (const bit of ["game must be", "display must be", "window size must be", "3d resolution must be", "anti-aliasing must be", "map zoom must be", 'unknown setting "volume"']) assert.ok(all.includes(bit), `missing ${bit}:\n${all}`);
});

test("the newest settings card wins, and the world sends it to the game once", () => {
  const tasks = [
    { id: 1, description: "settings:\n  display: window", updated_at: 100 },
    { id: 2, description: "battle:\n  map: Big Arena", updated_at: 300 },
    { id: 3, description: "notes\n\nsettings:\n  display: fullscreen", updated_at: 200 },
  ];
  assert.equal(pickSettingsTask(tasks)?.id, 3);
  assert.equal(pickSettingsTask([{ id: 9, description: "nothing" }]), null);

  const world = new World("fake");
  const sent: ServerMessage[] = [];
  world.on("message", (m: ServerMessage) => sent.push(m));
  world.setSettings({ fullscreen: true });
  world.setSettings({ fullscreen: true }); // unchanged: not sent again
  world.setSettings({ fullscreen: false, zoom: 30 });
  const updates = sent.filter((m) => m.type === "settings.update");
  assert.equal(updates.length, 2);
  assert.deepEqual(world.snapshot().settings, { fullscreen: false, zoom: 30 });
});
