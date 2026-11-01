#!/usr/bin/env python3
"""Pixel forensics on the dried-world state-mix screenshot.
The color audit says (albedo, after 12h drying):
  MUD        lum 0.376  rgb(109, 95, 63)   <- crusted mud body
  WET-plastic lum 0.379 rgb(102, 99, 57)
  SATURATED   lum 0.306 rgb(78, 81, 47)
  DAMP        lum 0.434 rgb(122, 112, 65)
If the on-screen ground shows a LIGHT speckled field (mud mottle up to
(97,74,56)+crust) next to darker uniform soil, the user's "mud is lighter"
report is confirmed visually. This measures it.
"""
import sys
from PIL import Image
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/download/qa_mud_realism/C_state_mix.png"
im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
H, W, _ = im.shape
# ground = lower 55% of frame, drop HUD edges
g = im[int(H * 0.45):int(H * 0.97), int(W * 0.05):int(W * 0.95)]
lum = g @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

print(f"image {W}x{H}, ground crop {g.shape[1]}x{g.shape[0]}")
print(f"luminance  mean {lum.mean():6.1f}  std {lum.std():5.1f}")
print(f"percentiles  p5 {np.percentile(lum,5):5.1f}  p25 {np.percentile(lum,25):5.1f}  "
      f"p50 {np.percentile(lum,50):5.1f}  p75 {np.percentile(lum,75):5.1f}  p95 {np.percentile(lum,95):5.1f}")

# coarse 6x10 grid of mean colors — where are the light/dark patches?
gh, gw = 6, 10
print("\ngrid mean RGB (rows top->bottom of the ground crop):")
for a in range(gh):
    row = []
    for b in range(gw):
        blk = g[a * g.shape[0] // gh:(a + 1) * g.shape[0] // gh,
                b * g.shape[1] // gw:(b + 1) * g.shape[1] // gw]
        m = blk.reshape(-1, 3).mean(0)
        row.append(f"{int(m[0]):3d},{int(m[1]):3d},{int(m[2]):3d}")
    print("  " + " | ".join(row))

# hue check: mud vs soil should differ in R/G ratio (mud browner/redder,
# lush soil greener). Ratio map on mid-luminance pixels only (avoid shadow/sky)
mid = (lum > np.percentile(lum, 30)) & (lum < np.percentile(lum, 85))
r = g[..., 0][mid]; gg = g[..., 1][mid]
print(f"\nmid-luminance R/G ratio: mean {(r/gg).mean():.2f}  std {(r/gg).std():.2f}")
