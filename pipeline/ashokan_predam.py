"""Reconstruct the Ashokan valley as it was before the reservoir (pre-1912).

Inputs
  <terrain_dir>/ashokan_height16.png + ashokan_meta.json   (from pipeline/terrain.py)
  pre-dam USGS 1:62,500 topo GeoTIFFs (from USGS topoView / TNM):
    NY_Slide Mountain_148515_1905_62500_geo.tif   (west basin)
    NY_Rosendale_148354_1903_62500_geo.tif        (east basin, dam site)

Method (tier 3 in the plan: a synthetic valley, guided by the historic map)
  1. Mask the reservoir: the flat water surface in modern terrain (~178 m), closed over the
     dividing weir and widened over the Olive Bridge Dam so both are removed.
  2. Old stream centerlines, hand-traced from the warped pre-dam maps (data/ashokan_thalwegs.geojson).
  3. Give each stream pixel an elevation by linear interpolation along the stream between the
     old creek bed at the dam (121 m: 587 ft spillway minus 190 ft max depth) and its upstream
     end (today's water level, or a spot elevation from the 1903 map).
  4. Fill the rest of the basin with a harmonic (Laplace) interpolation between shoreline and
     streams, shaped by a power curve so valley floors come out flatter than a plain V.

Outputs (to <terrain_dir>)
  ashokan_predam_height16.png      same grid and encoding as ashokan_height16.png
  ashokan_predam_meta.json
  ashokan_topo_predam.png          the pre-dam maps warped onto the terrain grid (texture)
  ashokan_reservoir_mask.png       255 = reconstructed area
  ashokan_before_after.png         side-by-side hillshade check

usage: python pipeline/ashokan_predam.py <terrain_dir> <topo_dir> [--debug <dir>]
"""
import json, math, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_bounds

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tdir, topodir = sys.argv[1], sys.argv[2]
debug = sys.argv[sys.argv.index("--debug") + 1] if "--debug" in sys.argv else None

# file, neatline (west, south, east, north) of each 15-minute quad, so collars are dropped
TOPO = [("NY_Slide Mountain_148515_1905_62500_geo.tif", (-74.50, 41.75, -74.25, 42.00)),
        ("NY_Rosendale_148354_1903_62500_geo.tif", (-74.25, 41.75, -74.00, 42.00))]
WATER_LEVEL_TOL = 0.6     # m, around the modal water surface
CLOSE_PX = 12             # closes gaps narrower than ~170 m (the dividing weir, causeways)
DAM_RADIUS_PX = 45        # ~320 m disk over the Olive Bridge Dam
SHAPE_POWER = 1.6         # >1 flattens valley floors
MIN_BASIN_PX = 50_000

meta = json.load(open(f"{tdir}/ashokan_meta.json"))
H, W = meta["height"], meta["width"]
v = np.asarray(Image.open(f"{tdir}/ashokan_height16.png")).astype(np.float64)
lo, hi = meta["elev_min_m"], meta["elev_max_m"]
elev = lo + v / 65535 * (hi - lo)

N = 2 ** meta["zoom"] * 256
def ty(lat): return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
def to_px(lon, lat):
    return (int((lon + 180) / 360 * N - (meta["west"] + 180) / 360 * N), int(ty(lat) - ty(meta["north"])))

# --- 1. warp the pre-dam maps onto the terrain grid ------------------------------------
R = 6378137
mx = lambda lon: math.radians(lon) * R
my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
dst_T = from_bounds(mx(meta["west"]), my(meta["south"]), mx(meta["east"]), my(meta["north"]), W, H)
tex = np.zeros((3, H, W), np.uint8)
lon_px = meta["west"] + (np.arange(W) + 0.5) / W * (meta["east"] - meta["west"])
lat_px = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty(meta["north"]) + np.arange(H) + 0.5) / N))))
for name, (qw, qs, qe, qn) in TOPO:
    with rasterio.open(os.path.join(topodir, name)) as r:
        tmp = np.zeros_like(tex)
        for b in range(3):
            reproject(r.read(b + 1), tmp[b], src_transform=r.transform, src_crs=r.crs,
                      dst_transform=dst_T, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
        # keep only the map inside its neatline (NAD27 vs WGS84 offset here is ~10 m, ignored)
        m = ((lon_px >= qw) & (lon_px < qe))[None, :] & ((lat_px >= qs) & (lat_px < qn))[:, None]
        tex[:, m] = tmp[:, m]
Image.fromarray(tex.transpose(1, 2, 0)).save(f"{tdir}/ashokan_topo_predam.png")

# --- 2. reservoir mask ------------------------------------------------------------------
hist, edges = np.histogram(elev, bins=np.arange(150, 200, 0.25))
level = float(edges[hist.argmax()] + 0.125)
flat = np.abs(elev - level) < WATER_LEVEL_TOL
lab, n = ndimage.label(flat)
sizes = ndimage.sum(flat, lab, range(1, n + 1))
mask = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= MIN_BASIN_PX])
yy, xx = np.ogrid[-CLOSE_PX:CLOSE_PX + 1, -CLOSE_PX:CLOSE_PX + 1]
mask = ndimage.binary_closing(mask, structure=(xx ** 2 + yy ** 2 <= CLOSE_PX ** 2))
dams = json.load(open(f"{ROOT}/data/dams.geojson"))["features"]
dam = next(f for f in dams if f["properties"]["name"] == "Ashokan Dam")
dx, dy = to_px(*dam["geometry"]["coordinates"])
Y, X = np.ogrid[:H, :W]
dam_disk = (X - dx) ** 2 + (Y - dy) ** 2 <= DAM_RADIUS_PX ** 2
mask |= dam_disk

# outlet: the old creek bed just below the dam = lowest modern ground within ~2 km south of it
win = (slice(dy, min(H, dy + 280)), slice(max(0, dx - 150), dx + 150))
oy, ox = np.unravel_index(elev[win].argmin(), elev[win].shape)
oy, ox = oy + win[0].start, ox + win[1].start
outlet_elev = float(elev[oy, ox])

# --- 3. old streams, hand-traced from the pre-dam maps (data/ashokan_thalwegs.geojson) ---
# Automatic extraction of the printed blue linework proved too gappy (the wide Esopus is drawn
# as a pale double line), so the centerlines were traced by eye on the warped maps.
from PIL import ImageDraw
thal = json.load(open(f"{ROOT}/data/ashokan_thalwegs.geojson"))["features"]
ras = np.zeros((H, W), np.float64); hit = np.zeros((H, W), bool)
def to_fpx(lon, lat): return ((lon + 180) / 360 * N - (meta["west"] + 180) / 360 * N, ty(lat) - ty(meta["north"]))
main_pts = None
for f in thal:
    pts = [to_fpx(*c) for c in f["geometry"]["coordinates"]]
    seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg)
    if f["properties"].get("start_elev_m") is not None:
        z0 = f["properties"]["start_elev_m"]; main_pts = (pts, seg, total, z0)
    else:  # starts on the main stem: take the main stem's elevation at the nearest vertex
        mp, ms, mt, mz0 = main_pts
        k = min(range(len(mp)), key=lambda i: math.dist(mp[i], pts[0]))
        z0 = mz0 + (level - mz0) * sum(ms[:k]) / mt
    acc = 0.0
    for i, L in enumerate(seg):
        steps = max(2, int(L * 2))
        for j in range(steps + 1):
            u = j / steps
            x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u; y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u
            z1 = f["properties"].get("end_elev_m", level)
            z = z0 + (z1 - z0) * (acc + L * u) / total
            yi, xi = int(round(y)), int(round(x))
            sl = (slice(max(0, yi - 2), yi + 3), slice(max(0, xi - 2), xi + 3))
            ras[sl] = np.where(hit[sl], np.minimum(ras[sl], z), z); hit[sl] = True
        acc += L
sp = hit & mask
stream_elev = ras[sp]
bed_elev = float(stream_elev.min())

# --- 4. harmonic fill ------------------------------------------------------------------
# unknowns: mask pixels that are not stream pixels; fixed: outside mask (=modern) and streams
fixed_val = elev.copy()
fixed_val[sp] = stream_elev
fixed_val[dam_disk & ~sp] = np.nan  # dam pixels are unknown (removes the dam)
unknown = mask & ~sp
# solve for t in [0,1]: 1 at shoreline (modern ground), 0 at streams -> then shape and map
idx = -np.ones((H, W), np.int64); idx[unknown] = np.arange(unknown.sum())
rows, cols, vals = [], [], []
rhs = np.zeros(unknown.sum())
uy, ux = np.nonzero(unknown)
diag = np.zeros(unknown.sum())
for oy_, ox_ in ((0, 1), (0, -1), (1, 0), (-1, 0)):
    ny, nx = uy + oy_, ux + ox_
    ok = (ny >= 0) & (ny < H) & (nx >= 0) & (nx < W)
    i = np.nonzero(ok)[0]; ny, nx = ny[ok], nx[ok]
    diag[i] += 1
    nb = idx[ny, nx]
    inner = nb >= 0
    rows += list(i[inner]); cols += list(nb[inner]); vals += [-1.0] * inner.sum()
    # boundary neighbours: stream -> t=0, outside mask -> t=1
    bnd = ~inner
    is_stream = sp[ny[bnd], nx[bnd]]
    np.add.at(rhs, i[bnd], np.where(is_stream, 0.0, 1.0))
A = sparse.csr_matrix((vals + list(diag), (rows + list(range(len(diag))), cols + list(range(len(diag))))),
                      shape=(len(diag), len(diag)))
tt = spsolve(A, rhs)
# the local floor below each unknown pixel: harmonic interpolation of stream elevations
B = np.zeros(unknown.sum())
for oy_, ox_ in ((0, 1), (0, -1), (1, 0), (-1, 0)):
    ny, nx = uy + oy_, ux + ox_
    ok = (ny >= 0) & (ny < H) & (nx >= 0) & (nx < W)
    i = np.nonzero(ok)[0]; ny, nx = ny[ok], nx[ok]
    bnd = idx[ny, nx] < 0
    val = np.where(sp[ny[bnd], nx[bnd]], fixed_val[ny[bnd], nx[bnd]], level)
    np.add.at(B, i[bnd], val)
floor = spsolve(A, B)  # harmonic blend of boundary elevations (streams + shoreline)
# shape: pull the blend toward the stream elevations away from the shore (flatter floors)
shaped_t = np.clip(tt, 0, 1) ** SHAPE_POWER
floor_streams = (floor - level * tt) / np.maximum(1 - tt, 1e-6)  # stream-weighted part of the blend
floor_streams = np.clip(floor_streams, bed_elev, level)
z = floor_streams + (level - floor_streams) * shaped_t

pre = elev.copy()
pre[uy, ux] = z
pre[sp] = stream_elev
pre = np.where(mask, ndimage.gaussian_filter(pre, 1.0), pre)

# --- outputs ----------------------------------------------------------------------------
plo, phi = float(pre.min()), float(pre.max())
Image.fromarray(np.round((pre - plo) / (phi - plo) * 65535).astype(np.uint16)).save(f"{tdir}/ashokan_predam_height16.png")
Image.fromarray((mask * 255).astype(np.uint8)).save(f"{tdir}/ashokan_reservoir_mask.png")
m2 = dict(meta, name="ashokan_predam", elev_min_m=plo, elev_max_m=phi,
          era="before 1912 (reconstructed)", water_level_m=level, creek_bed_at_dam_m=bed_elev,
          modern_channel_below_dam_m=round(outlet_elev, 1),
          max_reconstructed_depth_m=round(level - float(pre[mask].min()), 1),
          method="synthetic valley: modern terrain outside the reservoir; inside, stream centerlines hand-traced from the "
                 "1903/1905 USGS topo maps, interpolated between shoreline and old creek bed (pipeline/ashokan_predam.py)",
          sources=["AWS Terrain Tiles (USGS 3DEP)", "USGS 1:62,500 Slide Mountain 1905", "USGS 1:62,500 Rosendale 1903"])
json.dump(m2, open(f"{tdir}/ashokan_predam_meta.json", "w"), indent=2)

def hillshade(e):
    gy, gx = np.gradient(e); mpp = meta["meters_per_pixel_approx"]
    sl = np.arctan(np.hypot(gx, gy) / mpp * 1.5); asp = np.arctan2(-gx, gy)
    hs = np.sin(math.radians(45)) * np.cos(sl) + np.cos(math.radians(45)) * np.sin(sl) * np.cos(math.radians(315) - asp)
    return np.clip(hs * 255, 0, 255).astype(np.uint8)
a, b = hillshade(elev), hillshade(pre)
a = np.stack([a] * 3, -1); a[mask & (np.abs(elev - level) < 1)] = [90, 130, 180]
b = np.stack([b] * 3, -1); b[sp] = [40, 90, 200]
Image.fromarray(np.concatenate([a, np.full((H, 20, 3), 255, np.uint8), b], 1)).save(f"{tdir}/ashokan_before_after.png")
print(json.dumps({k: m2[k] for k in ("water_level_m", "creek_bed_at_dam_m", "max_reconstructed_depth_m")}),
      "mask px", int(mask.sum()), "stream px", int(sp.sum()))
if debug:
    os.makedirs(debug, exist_ok=True)
    d = tex.transpose(1, 2, 0).copy(); d[mask] = (d[mask] * 0.6).astype(np.uint8); d[sp] = [255, 0, 0]
    d[max(0, oy - 4):oy + 4, max(0, ox - 4):ox + 4] = [255, 0, 255]
    Image.fromarray(d).save(f"{debug}/ashokan_streams_debug.png")
