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
from PIL import ImageDraw
# OpenStreetMap water polygons (ways and multipolygon outers), in full-resolution pixels
osm_polys = []
for e in json.load(open(f"{ROOT}/data/osm/lakes.json"))["elements"] + json.load(open(f"{ROOT}/data/osm/lake_relations.json"))["elements"]:
    rings = []
    if e["type"] == "way" and e.get("geometry") and len(e["geometry"]) > 3: rings = [e["geometry"]]
    elif e["type"] == "relation":
        rings = [m["geometry"] for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
    for r in rings:
        pts = [lonlat_to_px(rm, g["lon"], g["lat"]) for g in r]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        osm_polys.append((min(xs), min(ys), max(xs), max(ys), pts))
def osm_footprint(area):
    """Rasterise the OSM polygons that mostly overlap `area` (a found reservoir surface)."""
    ys, xs = np.nonzero(area)
    if not len(xs): return None
    x0, y0, x1, y1 = xs.min() - 20, ys.min() - 20, xs.max() + 20, ys.max() + 20
    out_a = np.zeros(area.shape, bool); hit = False
    for (a0, b0, a1, b1, pts) in osm_polys:
        if a1 < x0 or a0 > x1 or b1 < y0 or b0 > y1 or (a1 - a0) * (b1 - b0) < 4: continue
        img = Image.new("L", (int(a1 - a0) + 3, int(b1 - b0) + 3))
        ImageDraw.Draw(img).polygon([(x - a0 + 1, y - b0 + 1) for x, y in pts], fill=1)
        m = np.asarray(img) > 0
        oy, ox = int(b0) - 1, int(a0) - 1
        sy0, sx0 = max(0, oy), max(0, ox)
        sub = m[sy0 - oy: sy0 - oy + area.shape[0] - sy0, sx0 - ox: sx0 - ox + area.shape[1] - sx0]
        reg_ = area[sy0: sy0 + sub.shape[0], sx0: sx0 + sub.shape[1]]
        if sub.sum() and (sub & reg_).sum() / sub.sum() > 0.6:
            out_a[sy0: sy0 + sub.shape[0], sx0: sx0 + sub.shape[1]] |= sub; hit = True
    return out_a if hit and out_a.sum() > 0.5 * area.sum() else None
city_poly = {g["properties"]["id"]: g["geometry"]["coordinates"][0]
             for g in json.load(open(f"{ROOT}/data/city_reservoirs.geojson"))["features"]}
poly_ids = []   # (id, ring) drawn straight onto the export grid below
for i, f in enumerate(reservoirs):
    if f.get("drowned_by"):   # under a later reservoir: drawn by that valley's patch instead
        res_out.append(dict(f, key=f["id"], id=i + 1, water_level_m=f["spillway_elev_m"], area_km2=None)); continue
    if f["id"] in city_poly:   # gone or too small for the terrain: traced footprint
        poly_ids.append((i + 1, city_poly[f["id"]]))
        x, y = lonlat_to_px(rm, f["lon"], f["lat"])
        res_out.append(dict(f, key=f["id"], id=i + 1, water_level_m=round(float(re_[int(y), int(x)]), 1), area_km2=None)); continue
    x, y = lonlat_to_px(rm, f["lon"], f["lat"])
    xi, yi = int(round(x)), int(round(y))
    R = 60  # ~1.7 km search window: the listed point may sit off the water
    win = (slice(max(0, yi - R), yi + R), slice(max(0, xi - R), xi + R))
    cand = np.round(re_[win][flat[win]] * 2) / 2
    near_w = (slice(max(0, yi - 15), yi + 15), slice(max(0, xi - 15), xi + 15))
    near_c = np.round(re_[near_w][flat[near_w]] * 2) / 2
    if near_c.size > 30: cand = near_c   # prefer the surface right at the point
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
            # the sizeable component closest to the point (neighbouring reservoirs share windows)
            cy, cx = yi - win[0].start, xi - win[1].start
            dt = ndimage.distance_transform_edt(~((np.arange(lab.shape[0])[:, None] == cy) & (np.arange(lab.shape[1])[None, :] == cx)))
            mind = ndimage.minimum(dt, lab, range(1, n + 1))
            best = min((k for k in range(n) if sizes[k] >= 30), key=lambda k: mind[k], default=int(np.argmax(sizes)))
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
    # where OpenStreetMap maps the reservoir, its outline is far finer than the terrain's 28 m:
    # use the OSM polygon(s) that mostly lie on the found surface
    osm_area = osm_footprint(area)
    if osm_area is not None: area = osm_area
    full_ids[area & (full_ids == 0)] = i + 1
    res_out.append(dict(f, key=f["id"], id=i + 1, water_level_m=round(level, 1), area_km2=round(area.sum() * rm["meters_per_pixel_approx"] ** 2 / 1e6, 2)))
# Exported at twice the mesh grid (~50 m): R = reservoir id (spread a little past the shore so a
# nearest lookup always finds it), G = how much of the pixel is water, from a smoothed outline,
# sampled with linear filtering so shores come out smooth rather than in steps.
OW, OH = reg.shape[1] * 2, reg.shape[0] * 2
ids = np.asarray(Image.fromarray(full_ids).resize((OW, OH), Image.NEAREST)).copy()
cov = np.asarray(Image.fromarray(ndimage.gaussian_filter((full_ids > 0).astype(np.float32), 0.8)).resize((OW, OH), Image.BILINEAR))
cov = np.clip((cov - 0.5) * 2.5 + 0.5, 0, 1)
for rid, ring in poly_ids:   # traced footprints, drawn 4x oversampled
    big = Image.new("L", (OW * 4, OH * 4)); scl = OW * 4 / rm["width"]
    ImageDraw.Draw(big).polygon([lonlat_to_px(rm, lo, la, scl) for lo, la in ring], fill=255)
    c = np.asarray(big.resize((OW, OH), Image.BOX)) / 255
    ids[c > 0] = rid; cov = np.maximum(cov, c)
grow = ndimage.grey_dilation(ids, size=5)
ids = np.where(ids > 0, ids, grow).astype(np.uint8)
# natural lakes, ponds and rivers are added by pipeline/osm_water.py (water_mask.png, rivers.json)
Image.fromarray(np.stack([ids, np.round(cov * 255).astype(np.uint8), np.zeros_like(ids)], -1)).save(f"{out}/region_reservoirs.png", optimize=True)

# --- valley details: before/after terrain + old maps -------------------------------------
VALLEYS = ["ashokan", "new-croton", "kensico", "schoharie", "rondout", "neversink", "pepacton", "cannonsville", "city"]
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
    # the water itself: today's flat surface inside the footprint (the footprint also covers the
    # dam and, around it, ground downstream of it)
    lvl = pm["water_level_m"] if pm["water_level_m"] is not None else -1e9
    water_m = (np.asarray(mask_img) > 127) & (np.abs(now_s - lvl) < 1.0)
    water_m = ndimage.binary_opening(water_m, iterations=1)
    Image.fromarray((water_m * 255).astype(np.uint8)).save(f"{out}/{vid}_water.png", optimize=True)
    dam_h = np.where((np.asarray(mask_img) > 127) & (now_s > lvl + 1), np.clip(now_s - pre_s, 0, 255), 0)
    Image.fromarray(np.round(dam_h).astype(np.uint8)).save(f"{out}/{vid}_dam.png", optimize=True)
    topo = Image.open(f"{tdir}/{vid}_topo_predam.png").convert("RGB")
    topo.thumbnail((TOPO_MAX, TOPO_MAX)); topo.save(f"{out}/{vid}_topo.jpg", quality=74, optimize=True)
    rname = {"ashokan": "Ashokan", "new-croton": "New Croton", "kensico": "Kensico", "schoharie": "Schoharie",
             "rondout": "Rondout", "neversink": "Neversink", "pepacton": "Pepacton", "cannonsville": "Cannonsville", "city": None}[vid]
    rid = next((r["id"] for r in res_out if r["name"] == f"{rname} Reservoir"), -1)   # -1: the city, no reservoir
    maps = pm.get("old_maps") or [{"title": t, "year": int(t[-4:])} for t in ("USGS 1:62500 Rosendale, NY 1903", "USGS 1:62500 Slide Mountain, NY 1905")]
    old = []
    for ol in pm.get("old_lakes", []):
        Image.open(f"{tdir}/{ol['file']}").resize((vw, vh), Image.BILINEAR).save(f"{out}/{ol['file']}")
        old.append(dict(file=ol["file"], level_m=ol["level_m"], name=ol["name"],
                        reservoir_id=next(r["id"] for r in res_out if r["key"] == ol["reservoir"])))
    # the rivers as they ran before the reservoir (traced from the old maps), drawn until it floods
    tp = f"{ROOT}/data/thalwegs/{vid}.geojson" if vid != "ashokan" else f"{ROOT}/data/ashokan_thalwegs.geojson"
    old_rivers = [f["geometry"]["coordinates"] for f in json.load(open(tp))["features"]] if os.path.exists(tp) else []
    valleys_out.append(dict(id=vid, bounds=bounds(vm), water_level_m=pm["water_level_m"], reservoir_id=rid, old_lakes=old,
                            old_rivers=old_rivers,
                            maps=[dict(title=m["title"], year=m["year"]) for m in maps],
                            synthetic=pm.get("synthetic", vid != "ashokan")))
    print("valley", vid, vw, "x", vh)

# --- dams: crest lines from OpenStreetMap -------------------------------------------------
# Each dam's crest is the OSM dam line(s) with its name, else the nearest one within 300 m. A dam
# mapped as an area becomes the line along its long axis. Which side holds the water is read
# from the reservoir outlines, and the crest height from the reservoir's level.
dams = json.load(open(f"{ROOT}/data/dams.geojson"))["features"]
osm_dams = [e for e in json.load(open(f"{ROOT}/data/osm/dams.json"))["elements"]
            if e["type"] == "way" and e.get("geometry") and e["tags"].get("waterway", e["tags"].get("man_made")) == "dam"]
KM = 111.2
def d_km(a, b): return math.hypot((a[0] - b[0]) * math.cos(math.radians(a[1])), a[1] - b[1]) * KM
def crest_of(e):
    g = [(p["lon"], p["lat"]) for p in e["geometry"]]
    if len(g) > 3 and g[0] == g[-1]:   # an area: its long axis
        k = math.cos(math.radians(g[0][1]))
        P = np.array([(x * k, y) for x, y in g[:-1]]); c = P.mean(0)
        u = np.linalg.svd(P - c)[2][0]; t = (P - c) @ u
        a_, b_ = c + u * t.min(), c + u * t.max()
        g = [(a_[0] / k, a_[1]), (b_[0] / k, b_[1])]
    return [[round(x, 6), round(y, 6)] for x, y in g]
norm = lambda n: n.lower().replace("reservoir ", "").replace("olivebridge", "ashokan").replace(" dam", "").strip()
def crests_for(name, lon, lat):
    named = [e for e in osm_dams if norm(e["tags"].get("name", "")) == norm(name)
             and min(d_km((lon, lat), (p["lon"], p["lat"])) for p in e["geometry"]) < 2]
    if named: return [crest_of(e) for e in named]
    near = min(osm_dams, key=lambda e: min(d_km((lon, lat), (p["lon"], p["lat"])) for p in e["geometry"]))
    return [crest_of(near)] if min(d_km((lon, lat), (p["lon"], p["lat"])) for p in near["geometry"]) < 0.6 else []
ids_full = full_ids
def res_at(lon, lat):
    x, y = lonlat_to_px(rm, lon, lat)
    if 0 <= int(y) < ids_full.shape[0] and 0 <= int(x) < ids_full.shape[1]: return int(ids_full[int(y), int(x)])
    return 0
res_by_nid = {r["dam_nid_id"]: r for r in res_out if r.get("dam_nid_id")}
def dam_record(name, lon, lat, year, height_ft, length_ft, type_, nid=None, retired=None, crest_elev=None, crest=None):
    crests = [crest] if crest else crests_for(name, lon, lat)
    r = res_by_nid.get(nid)
    up = []
    for c in crests:   # +1: the water is on the left of the crest as drawn, -1: on the right
        (x0, y0), (x1, y1) = c[0], c[-1]
        mx_, my_ = (x0 + x1) / 2, (y0 + y1) / 2
        k = math.cos(math.radians(my_)); L = math.hypot((x1 - x0) * k, y1 - y0) or 1e-9
        nx, ny = -(y1 - y0) / L * 0.002, (x1 - x0) * k / L * 0.002
        left, right = res_at(mx_ + nx / k, my_ + ny), res_at(mx_ - nx / k, my_ - ny)
        up.append(1 if left and not right else -1 if right and not left else 0)
    if crest_elev is None and r: crest_elev = r["water_level_m"] + 3
    return dict(name=name, lon=lon, lat=lat, year=year, height_ft=height_ft, length_ft=length_ft, type=type_,
                retired=retired, crests=crests, upstream=up, crest_elev_m=crest_elev)
dam_list = [dam_record(d["properties"]["name"], *d["geometry"]["coordinates"], d["properties"]["year_completed"],
                       d["properties"]["height_ft"], d["properties"]["length_ft"], d["properties"]["type"], d["properties"]["nid_id"])
            for d in dams if d["properties"]["year_completed"]]
dam_list += [dam_record(r["dam"]["name"], r["dam"]["lon"], r["dam"]["lat"], r["in_service"], r["dam"]["height_ft"],
                        r["dam"]["length_ft"], r["dam"]["type"], retired=r.get("retired"), crest_elev=r["spillway_elev_m"],
                        crest=r["dam"].get("crest"))
             for r in reservoirs if r.get("dam")]
for d in dam_list:
    print(f"dam {d['name']:32s} crests {len(d['crests'])} up {d['upstream']} crest {d['crest_elev_m']}")

# --- scene.json -------------------------------------------------------------------------
aq = json.load(open(f"{ROOT}/data/aqueducts.geojson"))["features"]
scene = dict(
    region=dict(bounds=bounds(rm), size=list(reg.shape[::-1])),
    valleys=valleys_out,
    reservoirs=res_out,
    dams=dam_list,
    # schematic waypoints; real routes, where OpenStreetMap maps them, are in routes.json
    aqueducts=[dict(f["properties"], coords=f["geometry"]["coordinates"],
                    **{k: next(t for t in timeline["features"] if t["id"] == f["properties"]["id"])[k]
                       for k in ("construction_start", "in_service", "retired")}) for f in aq],
    events=timeline["events"],
)
json.dump(scene, open(f"{out}/scene.json", "w"), separators=(",", ":"))
for r in res_out:
    print(f'{r["id"]:2d} {r["name"]:32s} level {r["water_level_m"]:7.1f}  km2 {r["area_km2"]}')
print("files:", sorted(os.listdir(out)))
