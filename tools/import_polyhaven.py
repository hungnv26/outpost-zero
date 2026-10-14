#!/usr/bin/env python3
"""Build the terrain texture sets from Poly Haven photo scans (CC0, polyhaven.com).

Downloads (once, into .data/polyhaven/) the 1K Diffuse / nor_gl / Rough JPGs of the assets
below, then writes game/assets/terrains/<id>/{albedo,normal,rough}.jpg. Earth terrains use
the scans as-is; other worlds colour-grade a scan and, where it helps, blend in features
from the procedural bake (lunar craters, Europa's lineae). The macro layer (macro.png) comes
from tools/bake_terrains.py, so run that first.

  python3 tools/bake_terrains.py && python3 tools/import_polyhaven.py
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".data" / "polyhaven"
OUT = ROOT / "game" / "assets" / "terrains"
UA = {"User-Agent": "outpost-zero-terrain-import"}

# terrain -> (Poly Haven asset, grading)
SOURCES = {
    "grassland": ("aerial_grass_rock", None),
    "sahara": ("aerial_sand", "sahara"),
    "arctic": ("snow_field_aerial", "arctic"),
    "beach": ("aerial_beach_01", None),
    "canyon": ("worn_rock_natural_01", "canyon"),
    "mars": ("red_laterite_soil_stones", "mars"),
    "moon": ("moon_01", "moon"),
    "venus": ("mud_cracked_dry_03", "venus"),
    "europa": ("snow_01", "europa"),
    "titan": ("aerial_sand", "titan"),
}
MAPS = {"Diffuse": "albedo", "nor_gl": "normal", "Rough": "rough"}


def fetch(asset: str) -> Path:
    d = CACHE / asset
    d.mkdir(parents=True, exist_ok=True)
    files = None
    for key in MAPS:
        out = d / f"{key}.jpg"
        if out.exists():
            continue
        if files is None:
            files = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/files/{asset}", headers=UA), timeout=60))
        f = files[key]["1k"]["jpg"]
        if not f["url"].startswith("https://dl.polyhaven.org/"):
            raise SystemExit(f"unexpected download host: {f['url']}")
        data = urllib.request.urlopen(urllib.request.Request(f["url"], headers=UA), timeout=60).read()
        out.write_bytes(data)
    return d


def load(path: Path, size: int = 1024) -> np.ndarray:
    im = Image.open(path).convert("RGB")
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return np.asarray(im, dtype=np.float64) / 255.0


def save(path: Path, rgb: np.ndarray, quality: int = 92) -> None:
    Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(path, quality=quality, subsampling=0)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def remap(lum: np.ndarray, dark, light) -> np.ndarray:
    """Colour-grade a scan: keep its detail (normalised luminance), replace its palette."""
    lo, hi = np.percentile(lum, 2), np.percentile(lum, 98)
    t = np.clip((lum - lo) / max(hi - lo, 1e-6), 0, 1)
    return np.asarray(dark) + (np.asarray(light) - np.asarray(dark)) * t[..., None]


def blend_normals(base: np.ndarray, extra: np.ndarray, amount: float) -> np.ndarray:
    b = base * 2 - 1
    e = extra * 2 - 1
    n = np.stack([b[..., 0] + e[..., 0] * amount, b[..., 1] + e[..., 1] * amount, b[..., 2]], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def grade(tid: str, grading: str | None, albedo, normal, rough):
    baked = OUT / tid
    if grading == "sahara":
        albedo = np.clip(albedo * np.array([1.12, 0.98, 0.76]), 0, 1)
    elif grading == "arctic":
        albedo = np.clip(albedo * 1.12 + 0.04, 0, 1)
    elif grading == "canyon":
        # Weathered sandstone, warmed towards the canyon's red-orange.
        albedo = np.clip(remap(luminance(albedo), (0.36, 0.17, 0.09), (0.86, 0.60, 0.42)) * 0.6 + albedo * np.array([1.1, 0.75, 0.55]) * 0.4, 0, 1)
    elif grading == "mars":
        # Laterite soil is already iron-red; push it towards dusty Martian orange.
        # Dusty butterscotch rather than brick red: partly desaturate, then tint.
        lum = luminance(albedo)[..., None]
        albedo = np.clip((albedo * 0.55 + lum * 0.45) * np.array([1.18, 0.86, 0.62]) + 0.03, 0, 1)
    elif grading == "moon":
        # Real lunar scan; blend in the baked craters so they read from above.
        b_alb = load(baked / "albedo.jpg")
        b_nrm = load(baked / "normal.jpg")
        lum = luminance(albedo)
        albedo = np.stack([lum] * 3, -1) * (0.75 + 0.5 * luminance(b_alb)[..., None] / max(luminance(b_alb).mean(), 1e-6) * 0.5)
        normal = blend_normals(normal, b_nrm, 0.9)
    elif grading == "venus":
        albedo = remap(luminance(albedo), (0.20, 0.15, 0.09), (0.56, 0.44, 0.28))
    elif grading == "europa":
        b_alb = load(baked / "albedo.jpg")
        b_nrm = load(baked / "normal.jpg")
        ice = remap(luminance(albedo), (0.70, 0.73, 0.76), (0.94, 0.95, 0.95))
        stain = np.clip((b_alb[..., 0] - b_alb[..., 2]) * 4.0, 0, 1)[..., None]
        albedo = ice * (1 - stain) + np.array([0.55, 0.36, 0.24]) * stain
        normal = blend_normals(normal, b_nrm, 1.0)
        rough = rough * 0.75
    elif grading == "titan":
        albedo = remap(luminance(albedo), (0.16, 0.10, 0.05), (0.46, 0.32, 0.17))
    return albedo, normal, rough


def main():
    for tid, (asset, grading) in SOURCES.items():
        src = fetch(asset)
        albedo = load(src / "Diffuse.jpg")
        normal = load(src / "nor_gl.jpg")
        rough = load(src / "Rough.jpg")
        if not (OUT / tid / "macro.png").exists():
            raise SystemExit(f"{tid}: run tools/bake_terrains.py first (macro layer missing)")
        albedo, normal, rough = grade(tid, grading, albedo, normal, rough)
        d = OUT / tid
        save(d / "albedo.jpg", albedo)
        save(d / "normal.jpg", normal, 94)
        save(d / "rough.jpg", rough, 90)
        (d / "SOURCE.txt").write_text(
            f"Photo scan: Poly Haven '{asset}' (CC0) https://polyhaven.com/a/{asset}\n"
            + ((f"Colour-graded for {tid}" + (" with procedural features blended in.\n" if grading in ("moon", "europa") else ".\n")) if grading else "")
        )
        print(f"  {tid}: {asset}" + (f" ({grading} grade)" if grading else ""))


if __name__ == "__main__":
    main()
