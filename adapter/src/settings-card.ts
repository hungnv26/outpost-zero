// The settings card (docs/settings.md): every game setting, kept in Mission Control instead of an
// in-game Settings panel. Any Mission Control task whose description holds a `settings:` block is
// a settings card; the most recently updated one applies. Only the settings it lists change.
//
//   settings:
//     game: outpost zero        # or outpost war
//     display: window           # or fullscreen
//     window size: 1920x1080
//     3d resolution: 100%
//     anti-aliasing: 2x
//     menu text: 80%
//     map labels: 60%
//     map zoom: 44

// The game's own choices (game/source/agent/Settings.gd).
export const WINDOW_SIZES = ["1280x720", "1920x1080", "2560x1440", "3200x1800", "3840x2160"];
export const RENDER_SCALES = [0.5, 0.67, 0.75, 1.0];
export const TEXT_SIZES = [0.7, 0.8, 0.9, 1.0, 1.2];
export const LABEL_SIZES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
export const ZOOM_MIN = 12;
export const ZOOM_MAX = 72;

export interface GameSettings {
  game?: "outpost-zero" | "outpost-war";
  fullscreen?: boolean;
  window_size?: [number, number];
  render_scale?: number;
  msaa?: 0 | 1 | 2;
  text_size?: number;
  label_size?: number;
  zoom?: number;
}

export type SettingsResult = { ok: true; settings: GameSettings } | { ok: false; errors: string[] };

export interface SettingsTask {
  id: number;
  description?: string;
  updated_at?: number | string;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function hasSettingsCard(text: string | undefined): boolean {
  return /^\s*settings\s*:\s*$/im.test(text ?? "");
}

// The newest task holding a settings card, or null.
export function pickSettingsTask<T extends SettingsTask>(tasks: T[]): T | null {
  const cards = tasks.filter((t) => hasSettingsCard(t.description));
  const stamp = (t: T) => (typeof t.updated_at === "number" ? t.updated_at : Date.parse(String(t.updated_at ?? "")) || 0);
  cards.sort((a, b) => stamp(b) - stamp(a) || b.id - a.id);
  return cards[0] ?? null;
}

function cardLines(text: string): string[] | null {
  const lines = (text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*settings\s*:\s*$/i.test(l));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*```/.test(l)) break;
    if (l.trim() === "") continue;
    if (!/^\s+/.test(l)) break;
    out.push(l);
  }
  return out;
}

const percent = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(v.trim());
  return m ? Number(m[1]) / (v.includes("%") || Number(m[1]) > 1 ? 100 : 1) : NaN;
};
const near = (v: number, list: number[]) => list.find((x) => Math.abs(x - v) < 0.006);
const pct = (list: number[]) => list.map((x) => `${Math.round(x * 100)}%`).join(", ");

export function parseSettingsCard(text: string): SettingsResult {
  const lines = cardLines(text);
  if (lines === null) return { ok: false, errors: ["no settings card: start a block with a line `settings:`"] };
  const settings: GameSettings = {};
  const errors: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9 \-_]+?)\s*:\s*(.+)$/.exec(line);
    if (!m) {
      errors.push(`could not read "${line}"`);
      continue;
    }
    const k = key(m[1]);
    const v = m[2].trim();
    switch (k) {
      case "game": {
        const g = key(v);
        if (g === "outpostzero") settings.game = "outpost-zero";
        else if (g === "outpostwar") settings.game = "outpost-war";
        else errors.push(`game must be outpost zero or outpost war`);
        break;
      }
      case "display":
      case "screen":
        if (key(v) === "window" || key(v) === "windowed") settings.fullscreen = false;
        else if (key(v) === "fullscreen") settings.fullscreen = true;
        else errors.push("display must be window or fullscreen");
        break;
      case "windowsize": {
        const size = v.replace(/\s/g, "").replace("×", "x").toLowerCase().replace(/4k$/, "");
        if (WINDOW_SIZES.includes(size)) settings.window_size = size.split("x").map(Number) as [number, number];
        else errors.push(`window size must be one of ${WINDOW_SIZES.join(", ")}`);
        break;
      }
      case "3dresolution":
      case "renderscale": {
        const r = near(percent(v), RENDER_SCALES);
        if (r !== undefined) settings.render_scale = r;
        else errors.push(`3d resolution must be one of ${pct(RENDER_SCALES)}`);
        break;
      }
      case "antialiasing":
      case "msaa": {
        const a = ({ off: 0, "0": 0, "2x": 1, "2": 1, "4x": 2, "4": 2 } as Record<string, 0 | 1 | 2>)[v.toLowerCase().replace(/\s|×/g, (c) => (c === "×" ? "x" : ""))];
        if (a !== undefined) settings.msaa = a;
        else errors.push("anti-aliasing must be off, 2x or 4x");
        break;
      }
      case "menutext":
      case "textsize": {
        const t = near(percent(v), TEXT_SIZES);
        if (t !== undefined) settings.text_size = t;
        else errors.push(`menu text must be one of ${pct(TEXT_SIZES)}`);
        break;
      }
      case "maplabels":
      case "labelsize": {
        const l = near(percent(v), LABEL_SIZES);
        if (l !== undefined) settings.label_size = l;
        else errors.push(`map labels must be one of ${pct(LABEL_SIZES)}`);
        break;
      }
      case "mapzoom":
      case "zoom": {
        const z = Number(v);
        if (Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX) settings.zoom = z;
        else errors.push(`map zoom must be a number from ${ZOOM_MIN} (close) to ${ZOOM_MAX} (far)`);
        break;
      }
      default:
        errors.push(`unknown setting "${m[1].trim()}" (game, display, window size, 3d resolution, anti-aliasing, menu text, map labels, map zoom)`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, settings };
}
