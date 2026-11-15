"""What if: the Stormville Reservoir on Fishkill Creek, which the 1903-04 Commission on Additional
Water Supply (Burr, Hering and Freeman) proposed and the city passed over for Ashokan, flooded
over TODAY's landscape.

What the report gives (p. 16 of its 1904 printing, archive.org reportcommissio01burrgoog): a
reservoir "at Stormville, on Fishkill Creek, covering 1,694 acres", high water "364 feet above
Croton datum", 49 sq mi of drainage, 10,000 million gallons of storage. The text read so far does
not give the dam's site, so it is reconstructed here: the dam goes where the creek, dammed to 364 ft
(taken as ~111 m above sea level; Croton datum is within a few feet of it), backs up a lake of about
that area. That site is just north of Stormville, east of the Taconic Parkway, and the lake also
needs two low dikes where the ground on its rim dips under 364 ft (toward Stormville, and toward
Sylvan Lake). Storage comes out higher than the report's (~17 vs 10 billion gallons): its figure is
probably the usable storage above the outlet, and today's terrain has the creek's own water and
fill in it, so the volume is the least certain number here.

Then it lists what the water would cover today: roads and rail from the USGS National
Transportation Dataset (optional; the 1 GB New York GeoPackage from The National Map).

usage: python pipeline/whatif_fishkill.py <work_dir> <out_data_dir> [TRAN_New_York_State_GPKG.gpkg]
writes <out_data_dir>/whatif_fishkill.json and whatif_fishkill_mask.png
"""
import heapq, json, math, os, sqlite3, struct, subprocess, sys
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
work, out = sys.argv[1:3]
ntd = sys.argv[3] if len(sys.argv) > 3 else None
LEVEL_FT = 364
LEVEL = LEVEL_FT * 0.3048
DAM = (41.5877, -73.7417)    # the site whose lake matches the report's 1,694 acres (see above)
FREEBOARD = 3.0              # crest above high water, m
BOX = (-73.82, 41.50, -73.60, 41.68)

# --- terrain (AWS Terrarium, ~14 m) ---------------------------------------------------------
os.makedirs(work, exist_ok=True)
if not os.path.exists(f"{work}/fishkill_meta.json"):
    subprocess.run([sys.executable, "-I", f"{ROOT}/pipeline/terrain.py", "fishkill", "13", *map(str, BOX), work, f"{work}/tiles"],
                   check=True, stdout=subprocess.DEVNULL)
meta = json.load(open(f"{work}/fishkill_meta.json"))
v = np.asarray(Image.open(f"{work}/fishkill_height16.png")).astype(np.float64)
z = meta["elev_min_m"] + v / 65535 * (meta["elev_max_m"] - meta["elev_min_m"])
H, W = z.shape
mpp = meta["meters_per_pixel_approx"]
N = 2 ** meta["zoom"] * 256
x0 = (meta["west"] + 180) / 360 * N
ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
y0 = ty(meta["north"])
to_px = lambda lon, lat: ((lon + 180) / 360 * N - x0, ty(lat) - y0)
def lonlat(i, j):
    return ((x0 + j + .5) / N * 360 - 180,
            math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y0 + i + .5) / N)))))

# --- D8 flow: priority-flood, each cell draining to the cell that reached it ------------------
done = np.zeros((H, W), bool); recv = -np.ones(H * W, np.int64); pq = []
for i in range(H):
    for j in range(W):
        if i in (0, H - 1) or j in (0, W - 1): heapq.heappush(pq, (z[i, j], i, j)); done[i, j] = True
filled = z.copy()
NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
while pq:
    e, i, j = heapq.heappop(pq)
    for di, dj in NB:
        a, b = i + di, j + dj
        if 0 <= a < H and 0 <= b < W and not done[a, b]:
            done[a, b] = True; filled[a, b] = max(z[a, b], e + 1e-4); recv[a * W + b] = i * W + j
            heapq.heappush(pq, (filled[a, b], a, b))
acc = np.ones(H * W)
for k in np.argsort(-filled, axis=None):
    if recv[k] >= 0: acc[recv[k]] += acc[k]
acc = acc.reshape(H, W) * mpp ** 2 / 1e6   # km2

# --- the dam's basin and the lake ------------------------------------------------------------
j, i = map(int, to_px(DAM[1], DAM[0]))
win = acc[i - 3:i + 4, j - 3:j + 4]; a, b = np.unravel_index(win.argmax(), win.shape); i, j = i - 3 + a, j - 3 + b
src = np.nonzero(recv >= 0)[0]; dst = recv[src]; o = np.argsort(dst); src, dst = src[o], dst[o]
s0, s1 = np.searchsorted(dst, np.arange(H * W)), np.searchsorted(dst, np.arange(H * W), side="right")
up, st = [i * W + j], [i * W + j]
while st:
    c = st.pop()
    for s in src[s0[c]:s1[c]]: up.append(s); st.append(s)
basin = np.zeros(H * W, bool); basin[up] = True; basin = basin.reshape(H, W)
lake = basin & (z < LEVEL); lab, _ = ndimage.label(lake); lake = lab == lab[i, j]
# where the rim dips under high water: the dam (across the creek) and dikes elsewhere
rim = ndimage.binary_dilation(lake) & ~lake & (z < LEVEL)
lab, n = ndimage.label(rim, structure=np.ones((3, 3)))
walls = []
for k in range(1, n + 1):
    ii, jj = np.nonzero(lab == k)
    p = np.stack([jj, ii], 1).astype(float); c = p.mean(0)
    _, _, vt = np.linalg.svd(p - c); ax = vt[0]
    t = (p - c) @ ax; ends = []
    # the crest follows the rim: the cells averaged in ~100 m steps along the line
    for s, t0 in ((-1, t.min()), (1, t.max())):
        # carry the crest on until it meets ground above the crest height
        q = c + ax * t0
        for _ in range(60):
            qi, qj = int(round(q[1])), int(round(q[0]))
            if not (0 <= qi < H and 0 <= qj < W) or z[qi, qj] >= LEVEL + FREEBOARD: break
            q = q + ax * s
        ends.append(q)
    step = max(1.0, 100 / mpp); mids = []
    for t0 in np.arange(t.min(), t.max() + 1e-6, step):
        sel = (t >= t0) & (t < t0 + step)
        if sel.any(): mids.append(p[sel].mean(0))
    crest = [lonlat(e[1], e[0]) for e in [ends[0], *mids, ends[1]]]
    is_dam = (abs(ii - i) + abs(jj - j)).min() < 6
    walls.append(dict(dam=bool(is_dam), crest=[[round(x, 6), round(y, 6)] for x, y in crest],
                      low_m=float(z[ii, jj].min()), cells=int(len(ii))))
walls.sort(key=lambda w: (not w["dam"], -w["cells"]))

area = lake.sum() * mpp ** 2
vol = ((LEVEL - z)[lake]).sum() * mpp ** 2
stats = dict(acres=round(area / 4046.86), area_km2=round(area / 1e6, 2), drainage_sq_mi=round(acc[i, j] / 2.58999, 1),
             volume_bn_gal=round(vol * 264.172 / 1e9, 1), max_depth_ft=round((LEVEL - z[lake].min()) / 0.3048),
             dam_height_ft=round((LEVEL + FREEBOARD - walls[0]["low_m"]) / 0.3048))
print(stats); [print(w) for w in walls]

# --- the mask, cropped to the lake, a little wider along its shore so the terrain trims it ---
ii, jj = np.nonzero(lake)
pad = 6
r0, r1, c0, c1 = ii.min() - pad, ii.max() + pad + 1, jj.min() - pad, jj.max() + pad + 1
shore = ndimage.binary_dilation(lake, iterations=2) & (z >= LEVEL - 0.5) & ~rim
m = (lake | shore)[r0:r1, c0:c1]
Image.fromarray((m * 255).astype(np.uint8)).save(f"{out}/whatif_fishkill_mask.png")
(w_, n_), (e_, s_) = lonlat(r0 - .5, c0 - .5), lonlat(r1 - .5, c1 - .5)

# --- what it would cover today ----------------------------------------------------------------
def gpkg_lines(blob):
    flags = blob[3]; w = blob[8 + [0, 32, 48, 48, 64][(flags >> 1) & 7]:]
    def read(p):
        bo = "<" if w[p] == 1 else ">"; t = struct.unpack(bo + "I", w[p + 1:p + 5])[0] % 1000; p += 5
        n = struct.unpack(bo + "I", w[p:p + 4])[0]; p += 4
        if t == 2:
            xy = struct.unpack(bo + "d" * 2 * n, w[p:p + 16 * n]); return [list(zip(xy[0::2], xy[1::2]))], p + 16 * n
        res = []
        for _ in range(n): ls, p = read(p); res += ls
        return res, p
    return read(0)[0]
def under(lon, lat):
    jx, iy = to_px(lon, lat); iy, jx = int(iy), int(jx)
    return 0 <= iy < H and 0 <= jx < W and lake[iy, jx]
roads, rail_km = {}, 0.0
if ntd:
    db = sqlite3.connect(ntd)
    lo0, la0 = lonlat(ii.max(), jj.min()); lo1, la1 = lonlat(ii.min(), jj.max())
    for table in ("Trans_RoadSegment", "Trans_RailFeature"):
        q = (f"select t.name, t.SHAPE from {table} t join rtree_{table}_SHAPE r on t.fid = r.id "
             f"where r.maxx > {lo0} and r.minx < {lo1} and r.maxy > {la0} and r.miny < {la1}")
        for name, g in db.execute(q):
            for line in gpkg_lines(g):
                for (a1, b1), (a2, b2) in zip(line[:-1], line[1:]):
                    if under((a1 + a2) / 2, (b1 + b2) / 2):
                        km = math.hypot((a2 - a1) * math.cos(math.radians(b1)), b2 - b1) * 111.32
                        if table == "Trans_RailFeature": rail_km += km
                        else: roads[name or ""] = roads.get(name or "", 0) + km
NICE = {"State Rte 216": "Route 216", "Co Hwy 8": "County Route 8", "Co Rd 9": "County Route 9", "Co Rd 7": "County Route 7"}
named = sorted(((NICE.get(k, k), v) for k, v in roads.items() if k), key=lambda x: -x[1])

doc = dict(
    name="Stormville Reservoir", level_m=round(LEVEL, 2), level_ft=LEVEL_FT, crest_m=round(LEVEL + FREEBOARD, 2),
    mask=dict(file="whatif_fishkill_mask.png", bounds=dict(west=w_, north=n_, east=e_, south=s_)),
    dam_at=[round(x, 6) for x in lonlat(i, j)], walls=walls, stats=stats,
    report=dict(acres=1694, level_ft=364, drainage_sq_mi=49, storage_mgal=10000, year=1904,
                source="Report of the Commission on Additional Water Supply for the City of New York (1904), p. 16",
                url="https://archive.org/details/reportcommissio01burrgoog"),
    roads_km=round(sum(roads.values()), 1), rail_km=round(rail_km, 1),
    roads=[dict(name=k, km=round(v, 1)) for k, v in named if v >= 0.1],
    roads_source="USGS National Transportation Dataset (The National Map), 2026" if ntd else None,
)
json.dump(doc, open(f"{out}/whatif_fishkill.json", "w"), indent=1)
print(doc["roads_km"], "km of road,", doc["rail_km"], "km of rail")
