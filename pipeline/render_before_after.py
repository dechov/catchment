"""Side-by-side picture of the Ashokan valley: pre-dam (old map draped on reconstructed relief)
and today (modern relief with the reservoir).
usage: python pipeline/render_before_after.py <terrain_dir> <out.png>
"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
Image.MAX_IMAGE_PIXELS = None
tdir, out = sys.argv[1], sys.argv[2]

def load(name):
    m = json.load(open(f"{tdir}/{name}_meta.json"))
    v = np.asarray(Image.open(f"{tdir}/{name}_height16.png")).astype(np.float64)
    return m, m["elev_min_m"] + v / 65535 * (m["elev_max_m"] - m["elev_min_m"])

def shade(e, mpp):
    gy, gx = np.gradient(e)
    sl = np.arctan(np.hypot(gx, gy) / mpp * 2.0); asp = np.arctan2(-gx, gy)
    return np.clip(np.sin(math.radians(40)) * np.cos(sl) + np.cos(math.radians(40)) * np.sin(sl) * np.cos(math.radians(315) - asp), 0, 1)

m, now = load("ashokan"); _, pre = load("ashokan_predam")
mask = np.asarray(Image.open(f"{tdir}/ashokan_reservoir_mask.png")) > 0
tex = np.asarray(Image.open(f"{tdir}/ashokan_topo_predam.png")).astype(np.float64) / 255
mpp = m["meters_per_pixel_approx"]
s_pre, s_now = shade(pre, mpp)[..., None], shade(now, mpp)[..., None]
before = tex * (0.35 + 0.75 * s_pre)
after = np.repeat(0.25 + 0.75 * s_now, 3, -1) * np.array([0.93, 0.91, 0.86])
water = mask & (np.abs(now - json.load(open(f"{tdir}/ashokan_predam_meta.json"))["water_level_m"]) < 1)
after[water] = [0.30, 0.47, 0.66]
ys, xs = np.nonzero(mask)
N = 2 ** m["zoom"] * 256
ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
row_42n = int(ty(42.0) - ty(m["north"])) + 2  # the 1903/1905 sheets stop at 42°N
sl = (slice(max(row_42n, ys.min() - 120), ys.max() + 120), slice(max(0, xs.min() - 120), xs.max() + 120))
a = Image.fromarray((np.clip(before[sl], 0, 1) * 255).astype(np.uint8))
b = Image.fromarray((np.clip(after[sl], 0, 1) * 255).astype(np.uint8))
w, h = a.size
canvas = Image.new("RGB", (w, h * 2 + 20), "white"); canvas.paste(a, (0, 0)); canvas.paste(b, (0, h + 20))
d = ImageDraw.Draw(canvas)
font = ImageFont.load_default(size=40)
for y, label in ((14, "c. 1905: Esopus valley (USGS maps on reconstructed terrain)"), (h + 34, "Today: Ashokan Reservoir")):
    x0, y0, x1, y1 = d.textbbox((24, y), label, font=font)
    d.rectangle([x0 - 10, y0 - 8, x1 + 10, y1 + 8], fill="white"); d.text((24, y), label, fill="black", font=font)
canvas.thumbnail((1800, 2400)); canvas.save(out); print(out, canvas.size)
