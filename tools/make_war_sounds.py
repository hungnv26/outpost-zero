#!/usr/bin/env python3
"""Outpost War's sound effects, synthesised (no recordings, so no licences): writes 16-bit mono
WAV files to game/assets/sfx/. Run again after changing a recipe:
    python3 tools/make_war_sounds.py
Played by game/source/war/WarSound.gd (docs/outpost-war.md)."""
import os
import wave

import numpy as np

RATE = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "game", "assets", "sfx")
rng = np.random.default_rng(7)


def t(seconds):
    return np.arange(int(RATE * seconds)) / RATE


def lowpass(x, cutoff):
    # One-pole low-pass, run twice for a softer slope.
    a = np.exp(-2 * np.pi * cutoff / RATE)
    for _ in range(2):
        y = np.empty_like(x)
        acc = 0.0
        for i, v in enumerate(x):
            acc = (1 - a) * v + a * acc
            y[i] = acc
        x = y
    return x


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def env(n, attack, decay_rate):
    e = np.exp(-decay_rate * np.arange(n) / RATE)
    a = max(1, int(RATE * attack))
    e[:a] *= np.linspace(0, 1, a)
    return e


def noise(seconds):
    return rng.uniform(-1, 1, int(RATE * seconds))


def write(name, x, peak=0.9):
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    data = (np.clip(x, -1, 1) * 32767).astype("<i2")
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(data.tobytes())
    print(f"{name}.wav  {len(x) / RATE:.2f} s")


# Tank cannon and ground turret: a low thump under a short crack.
d = 0.7
tt = t(d)
freq = 60 * np.exp(-tt * 3) + 32
thump = np.sin(2 * np.pi * np.cumsum(freq) / RATE) * env(len(tt), 0.002, 9)
crack = highpass(noise(d), 900) * env(len(tt), 0.0005, 45)
body = lowpass(noise(d), 500) * env(len(tt), 0.003, 12)
write("cannon", 1.0 * thump + 0.45 * crack + 0.6 * body)

# Helicopter rockets and air turret: a hiss that swells and fades.
d = 0.9
tt = t(d)
hiss = highpass(lowpass(noise(d), 4000), 600)
swell = np.sin(np.pi * np.clip(tt / d, 0, 1)) ** 1.5
pop = lowpass(noise(d), 700) * env(len(tt), 0.001, 30)
write("rocket", 0.8 * hiss * swell + 0.5 * pop, peak=0.75)

# A unit destroyed: a short boom with a rumbling tail.
d = 1.2
tt = t(d)
boom = lowpass(noise(d), 380) * env(len(tt), 0.004, 4.5)
low = np.sin(2 * np.pi * (48 * np.exp(-tt * 1.5) + 28) * tt) * env(len(tt), 0.004, 6)
debris = highpass(noise(d), 2500) * env(len(tt), 0.002, 18) * 0.25
write("explosion_small", boom + 0.7 * low + debris)

# A building destroyed: longer and deeper.
d = 2.4
tt = t(d)
boom = lowpass(noise(d), 260) * env(len(tt), 0.006, 2.2)
low = np.sin(2 * np.pi * (40 * np.exp(-tt * 0.9) + 22) * tt) * env(len(tt), 0.006, 2.6)
crash = lowpass(highpass(noise(d), 1200), 5000) * env(len(tt), 0.01, 7) * 0.35
write("explosion_large", boom + 0.9 * low + crash)

# A structure placed: a metallic clank.
d = 0.5
tt = t(d)
clank = (np.sin(2 * np.pi * 820 * tt) + 0.6 * np.sin(2 * np.pi * 1330 * tt) + 0.3 * np.sin(2 * np.pi * 2210 * tt)) * env(len(tt), 0.001, 14)
hit = highpass(noise(d), 1500) * env(len(tt), 0.0005, 60)
write("build_start", clank + 0.5 * hit, peak=0.6)

# A structure finished: two soft tones, a fifth apart.
d = 0.9
tt = t(d)
tone = lambda f, start: np.where(tt >= start, np.sin(2 * np.pi * f * (tt - start)) * np.exp(-(tt - start).clip(0) * 5), 0)
write("build_done", tone(523.25, 0.0) + 0.9 * tone(783.99, 0.16), peak=0.45)

# A unit rolls out: one short blip.
d = 0.25
tt = t(d)
write("unit_ready", np.sin(2 * np.pi * 660 * tt) * env(len(tt), 0.004, 22), peak=0.35)

# Ambience: wind over open ground, 8 s, loops without a seam.
d = 8.0
n = int(RATE * d)
brown = np.cumsum(rng.uniform(-1, 1, n + RATE))
brown = highpass(brown - np.mean(brown), 40)
wind = lowpass(brown, 700)
gust = 0.65 + 0.35 * np.sin(2 * np.pi * np.arange(n + RATE) / RATE / 4.0 + 1.0)
wind = wind * gust
# Crossfade the extra second onto the start so the end flows into the beginning.
fade = np.linspace(0, 1, RATE)
loop = wind[:n].copy()
loop[:RATE] = wind[:RATE] * fade + wind[n:] * (1 - fade)
write("ambient_wind", loop, peak=0.5)
