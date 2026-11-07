"""Detail patches: the reservoir valleys drawn at higher resolution, with the old USGS maps
made before each dam draped over them (the way the Ashokan valley already works).

PATCHES lists each valley: a lon/lat box, the reservoirs it covers, and `before`, the year the
old maps must predate (the first dam work in that valley).

  python pipeline/patches.py plan  <work_dir>   pick the map sheets (USGS TNM API) -> plan.json
  python pipeline/patches.py fetch <work_dir>   download terrain tiles and the chosen GeoTIFFs
  python pipeline/patches.py build <work_dir> <out_dir>
        for each patch write, to <out_dir> (web/public/data):
          patch_<name>_height.png   Terrarium heights, zoom-12 terrain tiles (~22 m here)
          patch_<name>_map.jpg      the old sheets reprojected onto the same grid, collars cut
          patch_<name>_res.png      R = reservoir id (flat water surface flood-filled from
                                    each reservoir's point), as in export_web.py
        and patches.json describing them (bounds, sheets with year and source URL, ids).

Needs rasterio (see README). Old maps: USGS Historical Topographic Map Collection (public domain).
Terrain: AWS Terrain Tiles (Terrarium), mostly USGS 3DEP here.
"""
import json, math, os, re, sys, urllib.parse, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "catchment-data-fetch/0.1"}
Z = 12

PATCHES = [
    # name, (west, south, east, north), before, view label
    ("croton", (-73.90, 41.20, -73.58, 41.47), 1900,   # New Croton dam begun 1892, valley flooded 1905
     "Croton watershed"),
    ("kensico", (-73.81, 41.05, -73.69, 41.16), 1913, "Kensico"),
    ("schoharie", (-74.51, 42.28, -74.36, 42.42), 1919, "Schoharie"),
    ("rondout", (-74.52, 41.78, -74.33, 41.88), 1937, "Rondout"),
    ("neversink", (-74.71, 41.79, -74.57, 41.91), 1941, "Neversink"),
    ("pepacton", (-75.02, 42.02, -74.66, 42.17), 1947, "Pepacton"),
    ("cannonsville", (-75.43, 42.02, -75.12, 42.15), 1955, "Cannonsville"),
]

def get(url, path=None, tries=4):
    import time
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
                data = r.read(); break
        except Exception:
            if k == tries - 1: raise
            time.sleep(2 ** (k + 1))
    if path:
        open(path + ".part", "wb").write(data); os.replace(path + ".part", path)
    return data

# --- plan ---------------------------------------------------------------------------------
def plan(work):
    out = {}
    for name, (w, s, e, n), before, label in PATCHES:
        q = urllib.parse.urlencode({"datasets": "Historical Topographic Maps", "bbox": f"{w},{s},{e},{n}",
                                    "max": 500, "outputFormat": "JSON", "prodFormats": "GeoTIFF"})
        items = json.loads(get("https://tnmaccess.nationalmap.gov/api/v1/products?" + q))["items"]
        quads = {}
        for it in items:
            m = re.search(r"1:(\d+)-scale Quadrangle for (.+?), NY (\d{4})", it["title"])
            if not m or m.group(1) != "62500" or not it["urls"].get("GeoTIFF"): continue
            bb = it["boundingBox"]
            # only quads that actually overlap the patch
            if bb["maxX"] <= w or bb["minX"] >= e or bb["maxY"] <= s or bb["minY"] >= n: continue
            key = (round(bb["minX"], 3), round(bb["minY"], 3))
            quads.setdefault(key, []).append(dict(quad=m.group(2), year=int(m.group(3)), url=it["urls"]["GeoTIFF"],
                                                  bounds=[bb["minX"], bb["minY"], bb["maxX"], bb["maxY"]],
                                                  bytes=it.get("sizeInBytes")))
        sheets = []
        for key, eds in sorted(quads.items()):
            pre = [x for x in eds if x["year"] < before]
            # the last survey before the dam; else the oldest there is
            pick = max(pre, key=lambda x: x["year"]) if pre else min(eds, key=lambda x: x["year"])
            pick["predates_dam"] = bool(pre); sheets.append(pick)
        out[name] = dict(bounds=[w, s, e, n], before=before, label=label, sheets=sheets)
        print(f"{name:13s} before {before}: " + ", ".join(f"{x['quad']} {x['year']}{'' if x['predates_dam'] else ' (after!)'}" for x in sheets))
    json.dump(out, open(f"{work}/plan.json", "w"), indent=1)

# --- fetch --------------------------------------------------------------------------------
n2 = 2 ** Z
tx = lambda lon: (lon + 180) / 360 * n2
ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n2
lon_of = lambda x: x / n2 * 360 - 180
lat_of = lambda y: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n2))))

def tiles(b):
    w, s, e, n = b
    return [(x, y) for x in range(int(tx(w)), int(tx(e)) + 1) for y in range(int(ty(n)), int(ty(s)) + 1)]

def fetch(work):
    pl = json.load(open(f"{work}/plan.json"))
    os.makedirs(f"{work}/tiles", exist_ok=True); os.makedirs(f"{work}/topo", exist_ok=True)
    jobs = []
    for p in pl.values():
        for x, y in tiles(p["bounds"]):
            path = f"{work}/tiles/{Z}_{x}_{y}.png"
            if not os.path.exists(path):
                jobs.append((f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png", path))
        for sh in p["sheets"]:
            path = f"{work}/topo/" + os.path.basename(urllib.parse.unquote(sh["url"]))
            if not os.path.exists(path): jobs.append((sh["url"], path))
    print(f"{len(jobs)} downloads", flush=True)
    with cf.ThreadPoolExecutor(6) as ex:
        for i, _ in enumerate(ex.map(lambda j: get(*j), jobs)):
            if (i + 1) % 20 == 0: print(f"  {i + 1}/{len(jobs)}", flush=True)

# --- build --------------------------------------------------------------------------------
def build(work, out):
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    from scipy import ndimage
    pl = json.load(open(f"{work}/plan.json"))
    scene = json.load(open(f"{out}/scene.json"))
    meta = []
    for name, p in pl.items():
        w, s, e, n = p["bounds"]
        # pixel window on the zoom-12 tile grid (web mercator), snapped to whole pixels
        X0, X1 = math.floor(tx(w) * 256), math.ceil(tx(e) * 256)
        Y0, Y1 = math.floor(ty(n) * 256), math.ceil(ty(s) * 256)
        W, H = X1 - X0, Y1 - Y0
        elev = np.zeros((H, W), np.float32)
        for x, y in tiles(p["bounds"]):
            a = np.asarray(Image.open(f"{work}/tiles/{Z}_{x}_{y}.png").convert("RGB"), np.float32)
            t = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
            ox, oy = x * 256 - X0, y * 256 - Y0
            sx0, sy0 = max(0, -ox), max(0, -oy)
            sx1, sy1 = min(256, W - ox), min(256, H - oy)
            if sx1 > sx0 and sy1 > sy0:
                elev[oy + sy0:oy + sy1, ox + sx0:ox + sx1] = t[sy0:sy1, sx0:sx1]
        elev = np.clip(elev, -100, None)
        b = dict(west=lon_of(X0 / 256), east=lon_of(X1 / 256), north=lat_of(Y0 / 256), south=lat_of(Y1 / 256))
        x = elev + 32768
        r = np.floor(x / 256); g = np.floor(x - r * 256); bl = np.round((x - r * 256 - g) * 256)
        over = bl > 255; g[over] += 1; bl[over] = 0
        Image.fromarray(np.stack([r, g, bl], -1).astype(np.uint8)).save(f"{out}/patch_{name}_height.png", optimize=True)

        # reservoir ids from flat water: flood-fill the surface around each reservoir's point
        gy, gx = np.gradient(elev); flat = np.hypot(gx, gy) < 0.08
        ids = np.zeros((H, W), np.uint8); res_in = []
        for res in scene["reservoirs"]:
            if not (b["west"] < res["lon"] < b["east"] and b["south"] < res["lat"] < b["north"]): continue
            px = int(tx(res["lon"]) * 256 - X0); py = int(ty(res["lat"]) * 256 - Y0)
            R = 40
            win = (slice(max(0, py - R), py + R), slice(max(0, px - R), px + R))
            near = np.abs(elev - res["water_level_m"]) < 1.0
            lab, _ = ndimage.label(near & flat)
            cand = np.unique(lab[win][lab[win] > 0])
            if not len(cand): continue
            sizes = ndimage.sum(np.ones_like(lab), lab, cand)
            area = lab == cand[int(np.argmax(sizes))]
            area = ndimage.binary_closing(area, iterations=2)
            ids[area & (ids == 0)] = res["id"]; res_in.append(res["id"])
        ids = ndimage.maximum_filter(ids, size=3)
        Image.fromarray(np.stack([ids, ids * 0, ids * 0], -1)).save(f"{out}/patch_{name}_res.png", optimize=True)

        # the old sheets, reprojected onto the patch grid at 2x (≈11 m/px), collars dropped
        S = 2
        R3857 = 6378137.0
        mxm = lambda lon: math.radians(lon) * R3857
        mym = lambda lat: R3857 * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
        dst_t = from_bounds(mxm(b["west"]), mym(b["south"]), mxm(b["east"]), mym(b["north"]), W * S, H * S)
        canvas = np.zeros((3, H * S, W * S), np.uint8)
        for sh in p["sheets"]:
            path = f"{work}/topo/" + os.path.basename(urllib.parse.unquote(sh["url"]))
            with rasterio.open(path) as src:
                arr = src.read()
                if arr.shape[0] == 1 and src.colormap(1):           # paletted scans
                    cm = src.colormap(1); lut = np.array([cm.get(i, (0, 0, 0, 0))[:3] for i in range(256)], np.uint8)
                    arr = np.moveaxis(lut[arr[0]], -1, 0)
                arr = arr[:3]
                tmp = np.zeros((3, H * S, W * S), np.uint8)
                for k in range(3):
                    reproject(arr[k], tmp[k], src_transform=src.transform, src_crs=src.crs,
                              dst_transform=dst_t, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
            # keep only inside the sheet's neatline (its 15-minute box), not the margins
            qw, qs, qe, qn = sh["bounds"]
            cols = np.array([lon_of((X0 + (i + 0.5) / S) / 256) for i in range(W * S)])
            rows = np.array([lat_of((Y0 + (j + 0.5) / S) / 256) for j in range(H * S)])
            inside = ((rows > qs) & (rows < qn))[:, None] & ((cols > qw) & (cols < qe))[None, :]
            canvas[:, inside] = tmp[:, inside]
        Image.fromarray(np.moveaxis(canvas, 0, -1)).save(f"{out}/patch_{name}_map.jpg", quality=82, optimize=True)
        meta.append(dict(name=name, label=p["label"], bounds=b, size=[W, H], before=p["before"], reservoirs=res_in,
                         sheets=[dict(quad=sh["quad"], year=sh["year"], predates_dam=sh["predates_dam"], url=sh["url"])
                                 for sh in p["sheets"]]))
        print(f"{name:13s} {W}x{H}  reservoirs {res_in}  sheets " + ", ".join(f"{x['quad']} {x['year']}" for x in p["sheets"]), flush=True)
    json.dump(dict(source="USGS Historical Topographic Map Collection; AWS Terrain Tiles", patches=meta),
              open(f"{out}/patches.json", "w"), indent=1)

if __name__ == "__main__":
    cmd, work = sys.argv[1], sys.argv[2]
    os.makedirs(work, exist_ok=True)
    {"plan": lambda: plan(work), "fetch": lambda: fetch(work), "build": lambda: build(work, sys.argv[3])}[cmd]()
