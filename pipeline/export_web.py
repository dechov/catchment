"""Pack terrain, reservoir outlines and the timeline into web-sized files for the 3D scene.

Heights are written as Terrarium-encoded RGB PNGs (meters = R*256 + G + B/256 - 32768), because
browsers decode PNGs to 8 bits per channel.

Reservoir outlines for the region come from the flat water surfaces in modern terrain: from each
reservoir's point in data/timeline.json, flood-fill the connected area within 1 m of that point's
surface. The result is an id mask (R channel = reservoir index + 1).

usage: python pipeline/export_web.py <terrain_dir> <out_dir>    (out_dir = web/public/data)
"""
import json, math, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tdir, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def load(name):
    m = json.load(open(f"{tdir}/{name}_meta.json"))
    v = np.asarray(Image.open(f"{tdir}/{name}_height16.png")).astype(np.float64)
    return m, m["elev_min_m"] + v / 65535 * (m["elev_max_m"] - m["elev_min_m"])

def terrarium(e, path):
    # heights are kept to 0.25 m (B channel in steps of 64), which roughly halves the PNG size
    x = np.round((np.clip(e, -1000, 9000) + 32768) * 4) / 4
    r = np.floor(x / 256); g = np.floor(x - r * 256); b = np.round((x - r * 256 - g) * 256)
    over = b > 255; g[over] += 1; b[over] = 0
    over = g > 255; r[over] += 1; g[over] = 0
    Image.fromarray(np.stack([r, g, b], -1).astype(np.uint8)).save(path, optimize=True)

def downsample(e, w):
    h = round(e.shape[0] * w / e.shape[1])
    return np.asarray(Image.fromarray(e.astype(np.float32)).resize((w, h), Image.BILINEAR)).astype(np.float64)

def lonlat_to_px(m, lon, lat, scale=1.0):
    N = 2 ** m["zoom"] * 256
    ty = lambda la: (1 - math.asinh(math.tan(math.radians(la))) / math.pi) / 2 * N
    return (((lon + 180) / 360 * N - (m["west"] + 180) / 360 * N) * scale, (ty(lat) - ty(m["north"])) * scale)

def bounds(m):
    return {k: m[k] for k in ("west", "south", "east", "north")}

timeline = json.load(open(f"{ROOT}/data/timeline.json"))
reservoirs = [f for f in timeline["features"] if f["kind"] == "reservoir"]

# --- region -----------------------------------------------------------------------------
rm, re_ = load("region")
RW = 2048
reg = downsample(re_, RW)
sc = RW / rm["width"]
terrarium(reg, f"{out}/region_height.png")

# outlines are found at full resolution (~28 m), then reduced to the export grid
gy, gx = np.gradient(re_)
flat = np.hypot(gx, gy) < 0.05
full_ids = np.zeros(re_.shape, np.uint8)
res_out = []
for i, f in enumerate(reservoirs):
    x, y = lonlat_to_px(rm, f["lon"], f["lat"])
    xi, yi = int(round(x)), int(round(y))
    R = 60  # ~1.7 km search window: the listed point may sit off the water
    win = (slice(max(0, yi - R), yi + R), slice(max(0, xi - R), xi + R))
    cand = np.round(re_[win][flat[win]] * 2) / 2
    level = None
    # reservoirs that no longer exist (the Manhattan distributing/receiving basins) have no
    # water in modern terrain: they get a small disc instead
    if cand.size > 30 and not f.get("retired"):
        vals, counts = np.unique(cand, return_counts=True)
        level = float(vals[counts.argmax()])
        area_w = np.abs(re_[win] - level) < 0.4
        lab, n = ndimage.label(area_w)
        if n:
            sizes = ndimage.sum(area_w, lab, range(1, n + 1))
            # nearest large component to the point
            best = max(range(n), key=lambda k: sizes[k])
            area = np.zeros(re_.shape, bool)
            # grow the chosen component beyond the window
            seed = np.zeros(re_.shape, bool); seed[win] = lab == best + 1
            near = np.abs(re_ - level) < 0.4
            labf, _ = ndimage.label(near)
            area = np.isin(labf, np.unique(labf[seed]))
            if area.sum() > 200_000:  # leaked into a valley floor; keep the windowed part
                area = seed
    if level is None or area.sum() < 20:
        Y, X = np.ogrid[:re_.shape[0], :re_.shape[1]]
        area = (X - x) ** 2 + (Y - y) ** 2 <= 6 ** 2
        level = float(re_[yi, xi])
    full_ids[area & (full_ids == 0)] = i + 1
    res_out.append(dict(f, id=i + 1, water_level_m=round(level, 1), area_km2=round(area.sum() * rm["meters_per_pixel_approx"] ** 2 / 1e6, 2)))
ids = np.asarray(Image.fromarray(ndimage.maximum_filter(full_ids, size=3)).resize(reg.shape[::-1], Image.NEAREST))
# natural lakes and ponds from OpenStreetMap: id 255 = always water. Polygons that mostly overlap
# a city reservoir are skipped so those keep their fill schedule.
from PIL import ImageDraw
SS = 3
lake_img = Image.new("L", (reg.shape[1] * SS, reg.shape[0] * SS), 0)
dl = ImageDraw.Draw(lake_img)
res_big = np.asarray(Image.fromarray(ids).resize(lake_img.size, Image.NEAREST)) > 0
n_lakes = 0
for f in json.load(open(f"{ROOT}/data/osm_lakes.geojson"))["features"]:
    ring = [lonlat_to_px(rm, lo, la, sc * SS) for lo, la in f["geometry"]["coordinates"][0]]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    x0, x1, y0, y1 = int(max(0, min(xs))), int(min(lake_img.size[0] - 1, max(xs))), int(max(0, min(ys))), int(min(lake_img.size[1] - 1, max(ys)))
    if x1 <= x0 or y1 <= y0:
        continue
    if res_big[y0:y1 + 1, x0:x1 + 1].mean() > 0.3:
        continue
    dl.polygon(ring, fill=255); n_lakes += 1
lakes = np.asarray(lake_img.resize(reg.shape[::-1], Image.BOX)) > 100
ids = ids.copy(); ids[lakes & (ids == 0)] = 255
print("natural water polygons:", n_lakes)
Image.fromarray(np.stack([ids, np.zeros_like(ids), np.zeros_like(ids)], -1)).save(f"{out}/region_reservoirs.png")

# rivers (OpenStreetMap), simplified, as [lon, lat] polylines
riv = json.load(open(f"{ROOT}/data/osm_rivers.geojson"))["features"][0]["geometry"]["coordinates"]
json.dump([[[round(x, 4), round(y, 4)] for x, y in line] for line in riv], open(f"{out}/rivers.json", "w"), separators=(",", ":"))

# --- valley details: before/after terrain + old maps -------------------------------------
VALLEYS = ["ashokan", "new-croton", "kensico", "schoharie", "rondout", "neversink", "pepacton", "cannonsville"]
MESH_MAX, TOPO_MAX = 1280, 3072
valleys_out = []
for vid in VALLEYS:
    if not os.path.exists(f"{tdir}/{vid}_predam_meta.json"):
        print("skip valley", vid); continue
    vm, now = load(vid); _, pre = load(f"{vid}_predam")
    vw = min(MESH_MAX, round(vm["width"] * min(1, MESH_MAX / max(vm["width"], vm["height"]))))
    pm = json.load(open(f"{tdir}/{vid}_predam_meta.json"))
    now_s, pre_s = downsample(now, vw), downsample(pre, vw)
    terrarium(pre_s, f"{out}/{vid}_pre.png")
    vh = round(vm["height"] * vw / vm["width"])
    mask_img = Image.open(f"{tdir}/{vid}_reservoir_mask.png").resize((vw, vh), Image.BILINEAR)
    mask_img.save(f"{out}/{vid}_mask.png")
    # the dam: modern ground standing above the water inside the reservoir footprint, in whole
    # metres over the pre-dam ground (8-bit, almost all zero, so the file is tiny)
    dam_h = np.where((np.asarray(mask_img) > 127) & (now_s > pm["water_level_m"] + 1), np.clip(now_s - pre_s, 0, 255), 0)
    Image.fromarray(np.round(dam_h).astype(np.uint8)).save(f"{out}/{vid}_dam.png", optimize=True)
    topo = Image.open(f"{tdir}/{vid}_topo_predam.png").convert("RGB")
    topo.thumbnail((TOPO_MAX, TOPO_MAX)); topo.save(f"{out}/{vid}_topo.jpg", quality=74, optimize=True)
    rname = {"ashokan": "Ashokan", "new-croton": "New Croton", "kensico": "Kensico", "schoharie": "Schoharie",
             "rondout": "Rondout", "neversink": "Neversink", "pepacton": "Pepacton", "cannonsville": "Cannonsville"}[vid]
    rid = next(r["id"] for r in res_out if r["name"] == f"{rname} Reservoir")
    maps = pm.get("old_maps") or [{"title": t, "year": int(t[-4:])} for t in ("USGS 1:62500 Rosendale, NY 1903", "USGS 1:62500 Slide Mountain, NY 1905")]
    valleys_out.append(dict(id=vid, bounds=bounds(vm), water_level_m=pm["water_level_m"], reservoir_id=rid,
                            maps=[dict(title=m["title"], year=m["year"]) for m in maps],
                            synthetic=vid != "ashokan"))
    print("valley", vid, vw, "x", vh)

# --- scene.json -------------------------------------------------------------------------
dams = json.load(open(f"{ROOT}/data/dams.geojson"))["features"]
aq = json.load(open(f"{ROOT}/data/aqueducts.geojson"))["features"]
osm_routes = {f["properties"]["id"]: [[[round(x, 5), round(y, 5)] for x, y in c] for c in f["geometry"]["coordinates"] if len(c) > 1]
              for f in json.load(open(f"{ROOT}/data/osm_aqueducts.geojson"))["features"] if f["properties"]["length_km"] > 1}
scene = dict(
    region=dict(bounds=bounds(rm), size=list(reg.shape[::-1])),
    valleys=valleys_out,
    reservoirs=res_out,
    dams=[dict(name=d["properties"]["name"], lon=d["geometry"]["coordinates"][0], lat=d["geometry"]["coordinates"][1],
               year=d["properties"]["year_completed"], height_ft=d["properties"]["height_ft"],
               length_ft=d["properties"]["length_ft"]) for d in dams if d["properties"]["year_completed"]],
    # routes: OpenStreetMap chains where mapped, else the schematic waypoints
    aqueducts=[dict(f["properties"],
                    chains=osm_routes.get(f["properties"]["id"]) or [f["geometry"]["coordinates"]],
                    route="osm" if f["properties"]["id"] in osm_routes else "schematic",
                    **{k: next(t for t in timeline["features"] if t["id"] == f["properties"]["id"])[k]
                       for k in ("construction_start", "in_service", "retired")}) for f in aq],
    events=timeline["events"],
)
json.dump(scene, open(f"{out}/scene.json", "w"), separators=(",", ":"))
for r in res_out:
    print(f'{r["id"]:2d} {r["name"]:32s} level {r["water_level_m"]:7.1f}  km2 {r["area_km2"]}')
print("files:", sorted(os.listdir(out)))
