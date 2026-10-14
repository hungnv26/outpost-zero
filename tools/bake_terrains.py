#!/usr/bin/env python3
"""Bake the Outpost Zero terrain texture sets.

For each terrain this writes, into game/assets/terrains/<id>/:
  albedo.jpg   1024x1024 colour (sRGB), tiles seamlessly
  normal.jpg   1024x1024 tangent-space normal map (OpenGL / Godot convention)
  rough.jpg    1024x1024 roughness
  macro.png    256x256 large-scale layer: RG = macro normal, B = brightness, A = blend noise

Everything is periodic (spectral synthesis + wrapped stamping), so the textures tile
without seams. Deterministic: the same seed gives the same textures.

  python3 tools/bake_terrains.py            # all terrains
  python3 tools/bake_terrains.py moon mars  # some
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

N = 1024
M = 256
OUT = Path(__file__).resolve().parent.parent / "game" / "assets" / "terrains"


# ----------------------------------------------------------------------------- noise


def spectral(n: int, beta: float, rng: np.random.Generator, fmin: float = 1.0, fmax: float | None = None,
             aniso: tuple[float, float] | None = None) -> np.ndarray:
    """Periodic fractal noise in [0, 1] with a 1/f^beta power spectrum, band-limited to
    [fmin, fmax] cycles per tile. `aniso=(angle, stretch)` elongates features."""
    fx = np.fft.fftfreq(n) * n
    kx, ky = np.meshgrid(fx, fx)
    if aniso:
        a, s = aniso
        c, si = np.cos(a), np.sin(a)
        u = kx * c + ky * si
        v = -kx * si + ky * c
        f = np.sqrt(u * u + (v * s) ** 2)
    else:
        f = np.sqrt(kx * kx + ky * ky)
    f[0, 0] = 1.0
    amp = f ** (-beta / 2.0)
    amp[f < fmin] = 0.0
    if fmax is not None:
        amp[f > fmax] = 0.0
    phase = rng.uniform(0, 2 * np.pi, (n, n))
    spec = amp * np.exp(1j * phase)
    img = np.real(np.fft.ifft2(spec))
    img -= img.min()
    img /= max(img.max(), 1e-9)
    return img


def warp(img: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    n = img.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    return ndimage.map_coordinates(img, [yy + dy, xx + dx], order=1, mode="wrap")


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    return ndimage.gaussian_filter(img, sigma, mode="wrap")


def stamp(target: np.ndarray, cx: float, cy: float, patch: np.ndarray, mode: str = "add") -> None:
    """Add/max a small patch centred at (cx, cy) with wrap-around."""
    n = target.shape[0]
    h, w = patch.shape
    y0 = int(round(cy)) - h // 2
    x0 = int(round(cx)) - w // 2
    ys = (np.arange(h) + y0) % n
    xs = (np.arange(w) + x0) % n
    region = target[np.ix_(ys, xs)]
    target[np.ix_(ys, xs)] = region + patch if mode == "add" else np.maximum(region, patch)


def rocks(n: int, count: int, rmin: float, rmax: float, rng: np.random.Generator, height: float = 1.0):
    """Scatter rounded, slightly irregular stones. Returns (height, mask)."""
    h = np.zeros((n, n))
    mask = np.zeros((n, n))
    for _ in range(count):
        r = rng.uniform(rmin, rmax) * (rng.random() ** 2 * 0.8 + 0.2) ** 0.5
        size = int(r * 2.6) | 1
        yy, xx = np.mgrid[0:size, 0:size] - size // 2
        ang = rng.uniform(0, np.pi)
        sx, sy = rng.uniform(0.7, 1.3), rng.uniform(0.6, 1.0)
        u = (xx * np.cos(ang) + yy * np.sin(ang)) / sx
        v = (-xx * np.sin(ang) + yy * np.cos(ang)) / sy
        d = np.sqrt(u * u + v * v) / r
        lump = 1 + 0.15 * np.sin(np.arctan2(v, u) * rng.integers(3, 6) + rng.uniform(0, 6))
        dome = np.clip(1 - (d / lump) ** 2, 0, 1) ** 0.6
        cx, cy = rng.uniform(0, n), rng.uniform(0, n)
        stamp(h, cx, cy, dome * r * 0.5 * height, "max")
        stamp(mask, cx, cy, (dome > 0.05).astype(float), "max")
    return h, mask


def craters(n: int, count: int, rmin: float, rmax: float, rng: np.random.Generator):
    """Bowl-shaped craters with raised rims and bright ejecta. Returns (height, ejecta)."""
    h = np.zeros((n, n))
    ej = np.zeros((n, n))
    for _ in range(count):
        r = rmin * (rmax / rmin) ** (rng.random() ** 2.2)
        size = int(r * 4.4) | 1
        yy, xx = np.mgrid[0:size, 0:size] - size // 2
        d = np.sqrt(xx * xx + yy * yy) / r
        bowl = np.where(d < 1, (d ** 2 - 1) * 0.9, 0)
        rim = np.exp(-((d - 1.0) / 0.18) ** 2) * 0.35
        apron = np.where(d > 1, np.exp(-(d - 1) * 2.2) * 0.12, 0)
        ejecta = np.where(d > 0.95, np.exp(-(d - 1) * 1.6), 0) * (d < 2.2)
        cx, cy = rng.uniform(0, n), rng.uniform(0, n)
        stamp(h, cx, cy, (bowl + rim + apron) * r * 0.35)
        stamp(ej, cx, cy, ejecta * min(1.0, r / rmax * 2), "max")
    return h, ej


def voronoi(n: int, count: int, rng: np.random.Generator, jitter_warp: float = 0.0):
    """Periodic Voronoi: returns (distance to nearest point, distance to the cell edge, cell id)."""
    pts = rng.uniform(0, n, (count, 2))
    tiled = np.concatenate([pts + np.array([dx, dy]) * n for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    ids = np.tile(np.arange(count), 9)
    tree = cKDTree(tiled)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    if jitter_warp:
        wx = (spectral(n, 3.0, rng, 2, 24) - 0.5) * jitter_warp
        wy = (spectral(n, 3.0, rng, 2, 24) - 0.5) * jitter_warp
        xx, yy = xx + wx, yy + wy
    d, i = tree.query(np.stack([xx.ravel(), yy.ravel()], -1), k=2)
    d1 = d[:, 0].reshape(n, n)
    edge = (d[:, 1] - d[:, 0]).reshape(n, n)
    cell = ids[i[:, 0]].reshape(n, n)
    return d1, edge, cell


# ----------------------------------------------------------------------------- output


def lerp_colors(t: np.ndarray, stops: list[tuple[float, tuple[float, float, float]]]) -> np.ndarray:
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    xs = [s[0] for s in stops]
    for c in range(3):
        out[..., c] = np.interp(t, xs, [s[1][c] for s in stops])
    return out


def normal_map(h: np.ndarray, strength: float) -> np.ndarray:
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / ln, ny / ln, nz / ln], -1)


def save_rgb(path: Path, rgb: np.ndarray, quality: int = 92) -> None:
    Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(path, quality=quality, subsampling=0)


def save_set(tid: str, albedo, height, rough, macro_h, macro_b, n_strength=6.0, m_strength=3.0, rng=None):
    d = OUT / tid
    d.mkdir(parents=True, exist_ok=True)
    save_rgb(d / "albedo.jpg", albedo)
    save_rgb(d / "normal.jpg", normal_map(height, n_strength) * 0.5 + 0.5, 94)
    r = np.clip(rough, 0, 1)
    save_rgb(d / "rough.jpg", np.stack([r, r, r], -1), 90)
    mn = normal_map(macro_h, m_strength) * 0.5 + 0.5
    blend = spectral(M, 3.0, rng, 1, 6)
    macro = np.stack([mn[..., 0], mn[..., 1], np.clip(macro_b, 0, 1), blend], -1)
    Image.fromarray((macro * 255 + 0.5).astype(np.uint8), "RGBA").save(d / "macro.png")
    print(f"  {tid}: done")


def grain(rng, n=N, amount=0.06):
    return 1 + (rng.standard_normal((n, n)) * amount)


# ----------------------------------------------------------------------------- terrains


def grassland(rng):
    # Turf seen from above: three blade directions mixed by low-frequency masks.
    blades = np.zeros((N, N))
    masks = [spectral(N, 3.2, rng, 1, 8) for _ in range(3)]
    tot = sum(masks)
    for k, m in enumerate(masks):
        ang = rng.uniform(0, np.pi)
        b = spectral(N, 0.6, rng, 140, 512, aniso=(ang, 3.5))
        blades += b * m / tot
    blades = blades * 0.75 + spectral(N, 0.4, rng, 200, 512) * 0.25
    blades = np.clip((blades - blades.mean()) * 2.2 + 0.5, 0, 1)
    clumps = spectral(N, 2.6, rng, 3, 60)
    dry = spectral(N, 2.6, rng, 6, 40)
    soil = np.clip((spectral(N, 2.8, rng, 8, 50) - 0.74) * 5, 0, 1) * 0.7
    h = blades * 0.6 + clumps * 0.4
    green = lerp_colors(h, [(0, (0.10, 0.17, 0.05)), (0.5, (0.22, 0.34, 0.10)), (1, (0.40, 0.52, 0.20))])
    straw = lerp_colors(h, [(0, (0.30, 0.27, 0.12)), (1, (0.62, 0.57, 0.32))])
    col = green * (1 - np.clip((dry - 0.55) * 2.5, 0, 0.7)[..., None]) + straw * np.clip((dry - 0.55) * 2.5, 0, 0.7)[..., None]
    dirt = lerp_colors(spectral(N, 2.0, rng, 20, 200), [(0, (0.22, 0.17, 0.11)), (1, (0.38, 0.30, 0.20))])
    col = col * (1 - soil[..., None]) + dirt * soil[..., None]
    col *= grain(rng, amount=0.05)[..., None]
    rough = 0.82 + 0.1 * blades
    macro_h = spectral(M, 3.4, rng, 1, 12)
    col *= (0.7 + 0.6 * blades)[..., None]
    save_set("grassland", col, h * 2.2, rough, macro_h, 0.5 + (spectral(M, 3.0, rng, 1, 8) - 0.5) * 0.6, 7.0, 2.0, rng)


def sand_ripples(rng, wavelength_px: float, angle: float, warp_px: float):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    wx = (spectral(N, 3.2, rng, 1, 12) - 0.5) * warp_px
    u = (xx * np.cos(angle) + yy * np.sin(angle) + wx) / wavelength_px
    # Periodic in the tile only if the wave count per tile is an integer along both axes:
    # snap direction to an integer lattice vector.
    phase = 2 * np.pi * u
    saw = (np.sin(phase) + 0.35 * np.sin(2 * phase + 1.1)) * 0.5 + 0.5
    return saw


def lattice_ripples(rng, kx: int, ky: int, warp_amp: float):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    w = (spectral(N, 3.0, rng, 1, 10) - 0.5) * warp_amp
    phase = 2 * np.pi * (kx * xx + ky * yy) / N + w
    s = np.sin(phase)
    asym = np.where(s > 0, s, s * 0.45)  # gentle windward, steep lee side
    return asym * 0.5 + 0.5


def sahara(rng):
    rip = lattice_ripples(rng, 17, 5, 5.0)
    rip2 = lattice_ripples(rng, -4, 14, 4.0)
    mix = spectral(N, 3.0, rng, 1, 6)
    h = rip * (0.5 + 0.5 * mix) + rip2 * (1 - mix) * 0.2 + spectral(N, 1.4, rng, 60, 400) * 0.25
    tone = spectral(N, 2.8, rng, 2, 40)
    col = lerp_colors(tone * 0.75 + rip * 0.25, [(0, (0.70, 0.49, 0.27)), (0.5, (0.81, 0.61, 0.37)), (1, (0.89, 0.71, 0.46))])
    specks = (rng.random((N, N)) > 0.985) * rng.uniform(-0.25, 0.25, (N, N))
    col *= (grain(rng, amount=0.05) + specks)[..., None]
    macro_h = lattice_ripples_macro(rng)
    save_set("sahara", col, h * 2.2, 0.88 + 0.06 * tone, macro_h, 0.5 + (macro_h - 0.5) * 0.4, 5.0, 4.0, rng)


def lattice_ripples_macro(rng):
    yy, xx = np.mgrid[0:M, 0:M].astype(np.float64)
    w = (spectral(M, 3.0, rng, 1, 5) - 0.5) * 2.5
    phase = 2 * np.pi * (3 * xx + 1 * yy) / M + w
    s = np.sin(phase)
    return np.where(s > 0, s, s * 0.5) * 0.5 + 0.5


def arctic(rng):
    sastrugi = spectral(N, 2.4, rng, 2, 120, aniso=(0.5, 4.0))
    fine = spectral(N, 1.2, rng, 80, 500)
    d1, edge, cell = voronoi(N, 70, rng, 18)
    ice = np.clip((spectral(N, 2.8, rng, 5, 30) - 0.66) * 5, 0, 1)
    h = sastrugi * 0.8 + fine * 0.15 - ice * 0.2
    snow = lerp_colors(sastrugi, [(0, (0.78, 0.84, 0.92)), (1, (0.96, 0.97, 0.99))])
    icec = lerp_colors(spectral(N, 2.2, rng, 4, 80), [(0, (0.55, 0.68, 0.80)), (1, (0.74, 0.84, 0.92))])
    crack = (1 - np.clip(edge / 2.2, 0, 1)) * ice
    icec = icec * (1 - crack[..., None] * 0.35)
    col = snow * (1 - ice[..., None]) + icec * ice[..., None]
    col *= grain(rng, amount=0.02)[..., None]
    rough = 0.75 - 0.5 * ice + 0.1 * fine
    macro_h = spectral(M, 3.4, rng, 1, 10)
    save_set("arctic", col, h * 2.0 + crack * -0.5, rough, macro_h, 0.5 + (macro_h - 0.5) * 0.3, 4.5, 2.5, rng)


def beach(rng):
    rip = lattice_ripples(rng, 30, 6, 6.0)
    wet = spectral(N, 3.0, rng, 3, 14)
    wet_mask = np.clip((wet - 0.55) * 1.8 + 0.3, 0, 0.8)
    h = rip * 0.6 + spectral(N, 1.3, rng, 60, 400) * 0.3
    dry = lerp_colors(spectral(N, 2.4, rng, 4, 60), [(0, (0.80, 0.71, 0.52)), (1, (0.93, 0.86, 0.68))])
    wetc = lerp_colors(rip, [(0, (0.62, 0.55, 0.42)), (1, (0.72, 0.64, 0.50))])
    col = dry * (1 - wet_mask[..., None]) + wetc * wet_mask[..., None]
    shells = (rng.random((N, N)) > 0.9988).astype(float)
    shells = np.clip(blur(shells, 0.8) * 9, 0, 1)
    col = col * (1 - shells[..., None]) + np.array([0.95, 0.92, 0.86]) * shells[..., None]
    col *= grain(rng, amount=0.05)[..., None]
    rough = 0.9 - 0.55 * wet_mask
    macro_h = spectral(M, 3.4, rng, 1, 8)
    save_set("beach", col, h * 1.8 + shells * 0.6, rough, macro_h, 0.5 + (spectral(M, 3, rng, 1, 5) - 0.5) * 0.55, 4.5, 1.5, rng)


def canyon(rng):
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    w = (spectral(N, 3.0, rng, 1, 10) - 0.5) * 60
    layers = (np.sin(2 * np.pi * (2 * yy + 1 * xx + w) / N) * 0.5 + 0.5)
    fine_layers = (np.sin(2 * np.pi * (11 * yy + 3 * xx + w * 1.7) / N) * 0.5 + 0.5)
    band = layers * 0.45 + fine_layers * 0.15 + spectral(N, 2.6, rng, 2, 30) * 0.4
    rock_h = spectral(N, 2.2, rng, 2, 200)
    d1, edge, cell = voronoi(N, 45, rng, 14)
    fract = (1 - np.clip(edge / 1.3, 0, 1)) * (spectral(N, 3.0, rng, 1, 8) > 0.45)
    gravel_h, gravel_m = rocks(N, 1600, 2, 7, rng, 0.8)
    h = rock_h * 0.6 + band * 0.3 - fract * 0.12 + gravel_h * 0.02
    col = lerp_colors(band, [(0, (0.46, 0.20, 0.11)), (0.35, (0.62, 0.30, 0.16)), (0.6, (0.74, 0.43, 0.25)), (0.85, (0.83, 0.63, 0.45)), (1, (0.70, 0.45, 0.30))])
    col *= (0.85 + 0.3 * rock_h)[..., None]
    col *= (1 - fract * 0.18)[..., None]
    gcol = lerp_colors(rng.random((N, N)), [(0, (0.40, 0.22, 0.14)), (1, (0.70, 0.50, 0.38))])
    col = col * (1 - gravel_m[..., None] * 0.8) + gcol * gravel_m[..., None] * 0.8
    col *= grain(rng, amount=0.04)[..., None]
    macro_h = spectral(M, 3.0, rng, 1, 14)
    save_set("canyon", col, h * 3.0, 0.8 + 0.1 * rock_h, macro_h, 0.5 + (macro_h - 0.5) * 0.5, 6.0, 3.0, rng)


def mars(rng):
    regolith = spectral(N, 2.2, rng, 2, 250)
    dust = spectral(N, 3.2, rng, 1, 10)
    big_h, big_m = rocks(N, 90, 10, 26, rng)
    small_h, small_m = rocks(N, 2200, 1.5, 6, rng)
    h = regolith * 0.35 + big_h * 0.05 + small_h * 0.05
    col = lerp_colors(regolith * 0.5 + dust * 0.5, [(0, (0.42, 0.20, 0.11)), (0.5, (0.62, 0.33, 0.18)), (1, (0.76, 0.46, 0.28))])
    rock_shade = blur(big_h, 1.0) / max(big_h.max(), 1e-6)
    rockc = lerp_colors(rng.random((N, N)) * 0.4 + rock_shade * 0.6, [(0, (0.22, 0.13, 0.09)), (1, (0.52, 0.32, 0.22))])
    m = np.clip(big_m + small_m, 0, 1)
    col = col * (1 - m[..., None] * 0.85) + rockc * m[..., None] * 0.85
    # dust settles around stones (lighter halo)
    halo = np.clip(blur(m, 4) - m, 0, 1) * 0.6
    col = col * (1 + halo[..., None] * 0.25)
    col *= grain(rng, amount=0.05)[..., None]
    macro_h = spectral(M, 3.2, rng, 1, 10)
    save_set("mars", col, h * 4.0, 0.9 - 0.15 * m, macro_h, 0.5 + (spectral(M, 3.0, rng, 1, 6) - 0.5) * 0.4, 6.0, 2.5, rng)


def moon(rng):
    base = spectral(N, 2.0, rng, 2, 400)
    ch, ej = craters(N, 260, 4, 70, rng)
    pebbles_h, pebbles_m = rocks(N, 900, 1.2, 4, rng, 0.8)
    h = base * 1.2 + ch * 0.06 + pebbles_h * 0.03
    tone = spectral(N, 2.6, rng, 1, 30)
    col = lerp_colors(tone * 0.7 + base * 0.3, [(0, (0.30, 0.30, 0.30)), (0.5, (0.45, 0.45, 0.44)), (1, (0.60, 0.60, 0.58))])
    col *= (1 + ej * 0.35)[..., None]
    col *= grain(rng, amount=0.06)[..., None]
    macro_h, _ = craters(M, 14, 6, 30, rng)
    macro_h = macro_h / max(np.abs(macro_h).max(), 1e-6) * 0.5 + 0.5
    save_set("moon", col, h * 2.5, 0.95 + 0 * base, macro_h, 0.5 + (spectral(M, 3, rng, 1, 6) - 0.5) * 0.4, 6.0, 4.0, rng)


def venus(rng):
    base = spectral(N, 2.0, rng, 2, 300)
    d1, edge, cell = voronoi(N, 220, rng, 14)
    plates = (cell * 0.618) % 1
    cracks = 1 - np.clip(edge / 2.5, 0, 1)
    d2, edge2, _ = voronoi(N, 30, rng, 30)
    big_cracks = 1 - np.clip(edge2 / 4.0, 0, 1)
    h = base * 0.5 + plates * 0.15 - cracks * 0.4 - big_cracks * 0.6
    col = lerp_colors(base * 0.6 + plates * 0.4, [(0, (0.26, 0.20, 0.13)), (0.5, (0.40, 0.31, 0.19)), (1, (0.55, 0.43, 0.27))])
    col *= (1 - cracks * 0.35 - big_cracks * 0.45)[..., None]
    col *= grain(rng, amount=0.05)[..., None]
    macro_h = spectral(M, 3.0, rng, 1, 12)
    save_set("venus", col, h * 3.0, 0.88 + 0.08 * base, macro_h, 0.5 + (macro_h - 0.5) * 0.5, 6.0, 3.0, rng)


def europa(rng):
    ice = spectral(N, 2.2, rng, 2, 300)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
    ridges = np.zeros((N, N))
    stain = np.zeros((N, N))
    for _ in range(9):
        kx, ky = int(rng.integers(-3, 4)), int(rng.integers(-3, 4))
        if kx == 0 and ky == 0:
            continue
        w = (spectral(N, 3.4, rng, 1, 4) - 0.5) * rng.uniform(8, 22)
        ph = 2 * np.pi * (kx * xx + ky * yy) / N + rng.uniform(0, 2 * np.pi) + w / 30
        dist = np.abs(np.sin(ph / 2))  # one thin band per wave
        width = rng.uniform(0.004, 0.012)
        ridge = np.exp(-(dist / width) ** 2)
        double = np.exp(-((dist - width * 1.6) / (width * 0.6)) ** 2)
        ridges = np.maximum(ridges, ridge * 0.6 + double * 0.4)
        stain = np.maximum(stain, np.exp(-(dist / (width * 2.4)) ** 2))
    chaos = np.clip((spectral(N, 3.0, rng, 1, 8) - 0.7) * 4, 0, 1)
    d1, edge, cell = voronoi(N, 160, rng, 12)
    blocks = (1 - np.clip(edge / 2.0, 0, 1)) * chaos
    h = ice * 0.4 + ridges * 0.8 - blocks * 0.5
    col = lerp_colors(ice, [(0, (0.72, 0.74, 0.76)), (1, (0.90, 0.91, 0.91))])
    brown = np.array([0.55, 0.36, 0.24])
    k = np.clip(stain * 0.7 + chaos * 0.35, 0, 1)
    col = col * (1 - k[..., None]) + brown * k[..., None]
    col *= (1 - blocks * 0.25)[..., None]
    col *= grain(rng, amount=0.02)[..., None]
    macro_h = spectral(M, 3.3, rng, 1, 8)
    save_set("europa", col, h * 2.5, 0.55 + 0.3 * k, macro_h, 0.5 + (macro_h - 0.5) * 0.25, 5.0, 2.0, rng)


def titan(rng):
    dunes = lattice_ripples(rng, 6, 2, 14.0)
    rip = lattice_ripples(rng, 52, 9, 8.0)
    inter = spectral(N, 3.0, rng, 1, 6)
    fine = spectral(N, 1.2, rng, 80, 500)
    h = dunes * 0.45 + rip * (0.2 + 0.15 * inter) + fine * 0.25
    col = lerp_colors(dunes * 0.3 + inter * 0.4 + fine * 0.3, [(0, (0.24, 0.16, 0.09)), (0.5, (0.32, 0.22, 0.12)), (1, (0.42, 0.30, 0.17))])
    col *= (0.88 + 0.24 * fine)[..., None]
    col *= grain(rng, amount=0.06)[..., None]
    macro_h = lattice_ripples_macro(rng)
    save_set("titan", col, h * 2.2, 0.92 + 0 * h, macro_h, 0.5 + (macro_h - 0.5) * 0.45, 5.5, 4.0, rng)


TERRAINS = {
    "grassland": grassland, "sahara": sahara, "arctic": arctic, "beach": beach, "canyon": canyon,
    "mars": mars, "moon": moon, "venus": venus, "europa": europa, "titan": titan,
}

if __name__ == "__main__":
    wanted = sys.argv[1:] or list(TERRAINS)
    for i, tid in enumerate(wanted):
        TERRAINS[tid](np.random.default_rng(1000 + list(TERRAINS).index(tid)))
