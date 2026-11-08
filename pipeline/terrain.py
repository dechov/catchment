"""Fetch AWS Terrarium elevation tiles for a bbox, mosaic, write 16-bit heightmap + metadata.
usage: terrain.py name z west south east north outdir tiledir
"""
import sys, math, json, os, concurrent.futures as cf, urllib.request, io
import numpy as np
from PIL import Image

name, z = sys.argv[1], int(sys.argv[2])
W, S, E, N = map(float, sys.argv[3:7])
outdir, tiledir = sys.argv[7], sys.argv[8]
n = 2 ** z

def tx(lon): return (lon + 180) / 360 * n
def ty(lat):
    r = math.radians(lat)
    return (1 - math.asinh(math.tan(r)) / math.pi) / 2 * n

x0, x1 = int(tx(W)), int(tx(E))
y0, y1 = int(ty(N)), int(ty(S))
os.makedirs(tiledir, exist_ok=True)

def fetch(xy):
    x, y = xy
    p = f"{tiledir}/{z}_{x}_{y}.png"
    if not os.path.exists(p):
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        with urllib.request.urlopen(url, timeout=60) as r:
            open(p, "wb").write(r.read())
    return xy, p

coords = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
print(f"{name}: z{z} {len(coords)} tiles", flush=True)
H, Wd = (y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256
elev = np.zeros((H, Wd), np.float32)
with cf.ThreadPoolExecutor(16) as ex:
    for (x, y), p in ex.map(fetch, coords):
        a = np.asarray(Image.open(p).convert("RGB"), np.float32)
        e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        elev[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = e

def lon(px): return px / n * 360 - 180
def lat(py): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))

# a few tiles hold huge negative glitch values; nothing real in this region is below -100 m
elev = np.clip(elev, -100, None)
lo, hi = float(elev.min()), float(elev.max())
# encode: meters = lo + v/65535*(hi-lo)
v = np.round((elev - lo) / (hi - lo) * 65535).astype(np.uint16)
os.makedirs(outdir, exist_ok=True)
Image.fromarray(v).save(f"{outdir}/{name}_height16.png")
# preview hillshade
gy, gx = np.gradient(elev)
mpp = 40075016 * math.cos(math.radians((N + S) / 2)) / (n * 256)
sl = np.arctan(np.hypot(gx, gy) / mpp * 1.5); asp = np.arctan2(-gx, gy)
az, alt = math.radians(315), math.radians(45)
hs = np.sin(alt) * np.cos(sl) + np.cos(alt) * np.sin(sl) * np.cos(az - asp)
img = np.clip(hs * 255, 0, 255).astype(np.uint8)
water = elev <= 0.5
rgb = np.stack([img] * 3, -1); rgb[water] = [70, 110, 160]
Image.fromarray(rgb).save(f"{outdir}/{name}_hillshade.png")
meta = dict(name=name, zoom=z, projection="web mercator (EPSG:3857) tile grid",
            west=lon(x0), east=lon(x1 + 1), north=lat(y0), south=lat(y1 + 1),
            width=Wd, height=H, meters_per_pixel_approx=round(mpp, 2),
            elev_min_m=lo, elev_max_m=hi,
            encoding="uint16 v -> meters = elev_min_m + v/65535*(elev_max_m-elev_min_m)",
            source="AWS Terrain Tiles (Terrarium), derived largely from USGS 3DEP in this region")
json.dump(meta, open(f"{outdir}/{name}_meta.json", "w"), indent=2)
print(json.dumps(meta, indent=2))
