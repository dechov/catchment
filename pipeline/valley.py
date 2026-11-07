"""Build a detailed "before and after" valley for one reservoir: high-resolution terrain, the
pre-dam ground under the water, and the old USGS maps warped onto it.

This is the general version of pipeline/ashokan_predam.py. Where Ashokan's old creeks were traced
by hand, here the drowned valley is SYNTHETIC: depth grows with distance from the shoreline and
the valley floor falls toward the dam, reaching the reservoir's maximum depth there. It gives the
right volume and overall shape, not the real creek bed. Hand-traced creeks can refine it later.

Steps
  1. Terrain tiles for the box at zoom 14 (~7 m), via pipeline/terrain.py's fetcher.
  2. The old sheets (from pipeline/old_maps.py) clipped to their neatlines and warped onto the
     terrain grid; finer sheets are drawn over coarser ones.
  3. Reservoir mask: the flat water surface connected to the reservoir, closed over causeways,
     plus the dam footprint.
  4. Synthetic floor, as above.

usage: python pipeline/valley.py <valley_id> <terrain_dir> <oldmaps_dir> <tile_cache>
outputs <terrain_dir>/<id>_{height16.png,meta.json,predam_height16.png,predam_meta.json,
        reservoir_mask.png,topo_predam.png}
"""
import json, math, os, subprocess, sys
import numpy as np
from PIL import Image
from scipy import ndimage
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_bounds

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
vid, tdir, mapdir, tiles = sys.argv[1:5]
sheets = json.load(open(f"{mapdir}/{vid}/sheets.json"))
W_, S_, E_, N_ = sheets["bbox"]
FT = 0.3048

tl = {f["id"]: f for f in json.load(open(f"{ROOT}/data/timeline.json"))["features"]}
res = tl[vid]
dams = {f["properties"]["nid_id"]: f for f in json.load(open(f"{ROOT}/data/dams.geojson"))["features"]}
dam = dams.get(res.get("dam_nid_id"))
# maximum depth: published where known, else ~85% of the dam's height
MAX_DEPTH_FT = {"neversink": 175, "pepacton": 180, "kensico": 120}
max_depth = MAX_DEPTH_FT.get(vid, (res.get("dam_height_ft") or 100) * 0.85) * FT

# --- 1. terrain ---------------------------------------------------------------------------
if not os.path.exists(f"{tdir}/{vid}_meta.json"):
    subprocess.run([sys.executable, "-I", f"{ROOT}/pipeline/terrain.py", vid, "14", str(W_), str(S_), str(E_), str(N_), tdir, tiles],
                   check=True, stdout=subprocess.DEVNULL)
meta = json.load(open(f"{tdir}/{vid}_meta.json"))
H, W = meta["height"], meta["width"]
v = np.asarray(Image.open(f"{tdir}/{vid}_height16.png")).astype(np.float64)
elev = meta["elev_min_m"] + v / 65535 * (meta["elev_max_m"] - meta["elev_min_m"])
N = 2 ** meta["zoom"] * 256
ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
def to_px(lon, lat): return ((lon + 180) / 360 * N - (meta["west"] + 180) / 360 * N, ty(lat) - ty(meta["north"]))
mpp = meta["meters_per_pixel_approx"]

# --- 2. old maps --------------------------------------------------------------------------
R = 6378137
mx = lambda lon: math.radians(lon) * R
my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
dst_T = from_bounds(mx(meta["west"]), my(meta["south"]), mx(meta["east"]), my(meta["north"]), W, H)
lon_px = meta["west"] + (np.arange(W) + 0.5) / W * (meta["east"] - meta["west"])
lat_px = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty(meta["north"]) + np.arange(H) + 0.5) / N))))
tex = np.zeros((3, H, W), np.uint8)
for s in sorted(sheets["sheets"], key=lambda s: -{"24000": 0, "31680": 1, "62500": 2}[s["scale"]]):  # coarse first
    qw, qs, qe, qn = s["neatline"]
    with rasterio.open(f"{mapdir}/{vid}/{s['file']}") as r:
        tmp = np.zeros_like(tex)
        for b in range(3):
            reproject(r.read(min(b + 1, r.count)), tmp[b], src_transform=r.transform, src_crs=r.crs,
                      dst_transform=dst_T, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
    m = ((lon_px >= qw) & (lon_px < qe))[None, :] & ((lat_px >= qs) & (lat_px < qn))[:, None] & (tmp.sum(0) > 0)
    tex[:, m] = tmp[:, m]
Image.fromarray(tex.transpose(1, 2, 0)).save(f"{tdir}/{vid}_topo_predam.png")

# --- 3. reservoir mask ----------------------------------------------------------------------
cx, cy = to_px(res["lon"], res["lat"])
gy, gx = np.gradient(elev)
flat = np.hypot(gx, gy) < 0.02
R0 = int(1500 / mpp)
win = (slice(max(0, int(cy) - R0), int(cy) + R0), slice(max(0, int(cx) - R0), int(cx) + R0))
vals, counts = np.unique(np.round(elev[win][flat[win]] * 4) / 4, return_counts=True)
level = float(vals[counts.argmax()])
water = np.abs(elev - level) < 0.5
lab, n = ndimage.label(water)
sizes = ndimage.sum(water, lab, range(1, n + 1))
mask = lab == (int(np.argmax(sizes)) + 1)
r = max(3, int(120 / mpp))
yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
mask = ndimage.binary_closing(mask, structure=(xx ** 2 + yy ** 2 <= r ** 2))
Y, X = np.ogrid[:H, :W]
if dam:
    dx, dy = to_px(*dam["geometry"]["coordinates"])
    half = max(150, (dam["properties"]["length_ft"] or 1000) * FT / 2) / mpp
    dam_disk = (X - dx) ** 2 + (Y - dy) ** 2 <= half ** 2
else:  # no dam record: assume the dam sits at the mask's lowest-ground neighbour
    dx, dy = cx, cy
    dam_disk = np.zeros((H, W), bool); half = 0
mask |= dam_disk & (elev > level - 2) & ndimage.binary_dilation(mask, iterations=int(half if dam else 1))

# --- 4. synthetic floor ---------------------------------------------------------------------
inner = mask & ~dam_disk
dist = ndimage.distance_transform_edt(mask) * mpp           # metres to the shoreline
# along-valley distance from the dam (geodesic inside the mask), coarse grid for speed
step = 4
m_c = mask[::step, ::step]
seed = dam_disk[::step, ::step] & m_c
if not seed.any():
    d0 = ndimage.distance_transform_edt(~m_c); seed = d0 == d0[m_c].min() if m_c.any() else seed
geo = np.full(m_c.shape, np.inf); geo[seed] = 0; front = seed.copy(); k = 0
while front.any():
    k += 1
    nxt = ndimage.binary_dilation(front, np.ones((3, 3), bool)) & m_c & np.isinf(geo)
    geo[nxt] = k; front = nxt
geo[np.isinf(geo)] = k
geo = np.asarray(Image.fromarray(geo.astype(np.float32)).resize((W, H), Image.BILINEAR)) * step * mpp
gmax = float(geo[mask].max()) if mask.any() else 1.0
# deepest along the old river: max depth at the dam, shallowing to ~10% at the far end
dmax_local = max_depth * (1 - 0.9 * np.clip(geo / gmax, 0, 1))
half_width = max(60.0, float(np.percentile(dist[mask], 97)))
shape = np.clip(dist / half_width, 0, 1) ** 0.8
depth = dmax_local * (1 - (1 - shape) ** 2)
pre = elev.copy()
pre[mask] = level - depth[mask]
pre = np.where(mask, ndimage.gaussian_filter(pre, 2.0), pre)

lo, hi = float(pre.min()), float(pre.max())
Image.fromarray(np.round((pre - lo) / (hi - lo) * 65535).astype(np.uint16)).save(f"{tdir}/{vid}_predam_height16.png")
Image.fromarray((mask * 255).astype(np.uint8)).save(f"{tdir}/{vid}_reservoir_mask.png")
pm = dict(meta, name=f"{vid}_predam", elev_min_m=lo, elev_max_m=hi, water_level_m=level,
          max_reconstructed_depth_m=round(level - float(pre[mask].min()), 1), assumed_max_depth_m=round(max_depth, 1),
          method="synthetic valley (pipeline/valley.py): depth from distance to shore, deepest toward the dam",
          old_maps=[dict(title=s["title"], year=s["year"], url=s["url"]) for s in sheets["sheets"]])
json.dump(pm, open(f"{tdir}/{vid}_predam_meta.json", "w"), indent=2)
print(vid, f"level {level:.1f} m, mask {mask.sum() * mpp * mpp / 1e6:.1f} km2, depth {pm['max_reconstructed_depth_m']} m "
      f"(target {max_depth:.0f}), {W}x{H} px at {mpp} m")
