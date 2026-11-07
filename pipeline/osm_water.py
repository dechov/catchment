"""Turn the raw OpenStreetMap extracts in data/osm/ into what the 3D scene draws.

Outputs (to <out_dir>, normally web/public/data)
  water_mask.png   lakes and rivers on the region grid at 2x resolution
                   R = standing water (natural lakes, ponds, other cities' reservoirs)
                   G = rivers (centrelines drawn 2-3 px wide, ~60 m px)
  rivers.json      the same rivers as simplified lon/lat polylines
                   NYC's own reservoirs are left out: the scene fills those over time.
  routes.json      the real aqueduct and tunnel routes, keyed by the aqueduct ids in
                   data/aqueducts.geojson. Each route is a list of runs, and each run has a
                   kind (tunnel / cutcover / bridge) and a lon/lat polyline, ordered from the
                   source downstream. Aqueducts that OSM does not map keep their schematic line.

Inputs: data/osm/{aqueducts,lakes,lake_relations,rivers}.json (Overpass, `out geom`),
        data/aqueducts.geojson, web/public/data/scene.json (region bounds)

usage: python pipeline/osm_water.py <out_dir> [--debug <png>]
Data © OpenStreetMap contributors (ODbL).
"""
import json, math, os, sys
from collections import defaultdict
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]
debug = sys.argv[sys.argv.index("--debug") + 1] if "--debug" in sys.argv else None
OSM = f"{ROOT}/data/osm"
load = lambda n: json.load(open(f"{OSM}/{n}.json"))["elements"]

scene = json.load(open(f"{out}/scene.json"))
B = scene["region"]["bounds"]
W = scene["region"]["size"][0] * 2
mx = lambda lon: math.radians(lon)
my = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
X0, X1, Y0, Y1 = mx(B["west"]), mx(B["east"]), my(B["north"]), my(B["south"])
H = round(W * (Y0 - Y1) / (X1 - X0))
def px(lon, lat): return ((mx(lon) - X0) / (X1 - X0) * W, (Y0 - my(lat)) / (Y0 - Y1) * H)
KM_PER_DEG_LAT = 111.2
def dist_km(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * KM_PER_DEG_LAT

def simplify(pts, tol_km=0.02):
    """Douglas-Peucker on lon/lat, tolerance in km."""
    if len(pts) < 3: return pts
    k = math.cos(math.radians(pts[0][1]))
    def d(p, a, b):
        ax, ay, bx, by, x, y = a[0] * k, a[1], b[0] * k, b[1], p[0] * k, p[1]
        L = (bx - ax) ** 2 + (by - ay) ** 2
        t = 0 if L == 0 else max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L))
        return math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) * KM_PER_DEG_LAT
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, bi = 0, -1
        for m in range(i + 1, j):
            dm = d(pts[m], pts[i], pts[j])
            if dm > best: best, bi = dm, m
        if best > tol_km: keep[bi] = True; stack += [(i, bi), (bi, j)]
    return [p for p, kp in zip(pts, keep) if kp]

geom = lambda e: [(g["lon"], g["lat"]) for g in e.get("geometry", []) if g]

# --- lakes and rivers -------------------------------------------------------------------
# NYC's reservoirs: the ones in the timeline are found by the reservoir id mask; these others
# are also NYC-built (Croton system) and must not appear before they were dammed.
NYC_EXTRA = {"Muscoot Reservoir", "Diverting Reservoir", "East Branch Reservoir", "Bog Brook Reservoir",
             "Lower Ashokan Reservoir", "Kensico Reservoir / Rye Lake", "Boyd Corners Reservoir"}
res_img = Image.open(f"{out}/region_reservoirs.png").convert("RGB").resize((W, H), Image.NEAREST)
res_px = res_img.load()

def rings_of_relation(e):
    """Assemble closed outer/inner rings from a multipolygon's member ways."""
    rings = {"outer": [], "inner": []}
    for role in rings:
        segs = [geom(m) for m in e.get("members", []) if m["type"] == "way" and m.get("role", "outer") == role and m.get("geometry")]
        while segs:
            ring = segs.pop()
            for _ in range(len(segs) + 1):
                if ring[0] == ring[-1]: break
                for i, s in enumerate(segs):
                    if s[0] == ring[-1]: ring += s[1:]
                    elif s[-1] == ring[-1]: ring += s[::-1][1:]
                    elif s[-1] == ring[0]: ring = s + ring[1:]
                    elif s[0] == ring[0]: ring = s[::-1] + ring[1:]
                    else: continue
                    segs.pop(i); break
            if len(ring) >= 4: rings[role].append(ring)
    return rings["outer"], rings["inner"]

def nyc_overlap(outer):
    """Share of the polygon's sampled pixels that fall on a mapped NYC reservoir."""
    xs, ys = zip(*(px(*p) for p in outer))
    x0, x1, y0, y1 = int(min(xs)), int(max(xs)) + 1, int(min(ys)), int(max(ys)) + 1
    m = Image.new("L", (x1 - x0, y1 - y0)); ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in zip(xs, ys)], fill=1)
    mp, n, hit = m.load(), 0, 0
    step = max(1, (x1 - x0) * (y1 - y0) // 4000)
    for i in range(0, (x1 - x0) * (y1 - y0), step):
        x, y = i % (x1 - x0), i // (x1 - x0)
        if mp[x, y] and 0 <= x + x0 < W and 0 <= y + y0 < H:
            n += 1; hit += res_px[x + x0, y + y0][0] > 0
    return hit / n if n else 0

SKIP_WATER = {"river", "stream", "canal", "tidal", "wastewater", "basin", "fountain"}
polys, dropped = [], defaultdict(int)
for e in load("lakes") + load("lake_relations"):
    t = e.get("tags", {})
    if t.get("water") in SKIP_WATER or t.get("tidal") == "yes": continue   # tidal Hudson: drawn from sea level
    if e["type"] == "way":
        g = geom(e)
        if len(g) < 4 or g[0] != g[-1]: continue
        outers, inners = [g], []
    else:
        outers, inners = rings_of_relation(e)
    if not outers: continue
    if t.get("name") in NYC_EXTRA: dropped["nyc (by name)"] += 1; continue
    if max(nyc_overlap(o) for o in outers) > 0.3: dropped["nyc (by mask)"] += 1; continue
    polys.append((outers, inners, t.get("name")))

mask = Image.new("RGB", (W, H))
lake_layer, hole_layer, river_layer = (Image.new("L", (W, H)) for _ in range(3))
dl, dh, dr = (ImageDraw.Draw(i) for i in (lake_layer, hole_layer, river_layer))
for outers, inners, _ in polys:
    for o in outers: dl.polygon([px(*p) for p in o], fill=255)
    for i in inners: dh.polygon([px(*p) for p in i], fill=255)
BIG = ("Delaware River", "Susquehanna River", "Lehigh River", "Hudson River", "West Branch Delaware River",
       "Delaware River East Branch", "Esopus Creek", "Wallkill River", "Neversink River", "Housatonic River")
n_rivers = 0
for e in load("rivers"):
    g = geom(e)
    if len(g) < 2: continue
    name = e.get("tags", {}).get("name", "")
    dr.line([px(*p) for p in g], fill=255, width=3 if name.startswith(BIG) else 2, joint="curve")
    n_rivers += 1
# rivers as simplified [lon, lat] polylines too: drawn as crisp lines, the mask's G channel is
# too coarse up close in the valley patches
riv_lines = []
for e in load("rivers"):
    g = geom(e)
    if len(g) >= 2: riv_lines.append([[round(lo, 4), round(la, 4)] for lo, la in simplify(g, 0.025)])
json.dump(riv_lines, open(f"{out}/rivers.json", "w"), separators=(",", ":"))
from PIL import ImageChops
lake_layer = ImageChops.subtract(lake_layer, hole_layer)
mask = Image.merge("RGB", (lake_layer, river_layer, Image.new("L", (W, H))))
mask.save(f"{out}/water_mask.png", optimize=True)
print(f"water_mask.png {W}x{H}: {len(polys)} lakes/ponds, {n_rivers} river ways; dropped {dict(dropped)}")

# --- aqueduct routes --------------------------------------------------------------------
aq = load("aqueducts")
schematic = {f["properties"]["id"]: f for f in json.load(open(f"{ROOT}/data/aqueducts.geojson"))["features"]}
named = lambda *ns: [e for e in aq if e["type"] == "way" and e.get("tags", {}).get("name") in ns and len(geom(e)) >= 2]
pipe = lambda es: [e for e in es if e["tags"].get("man_made") == "pipeline" or e["tags"].get("waterway") in ("canal", "pressurised")]
by_id = {e["id"]: e for e in aq if e["type"] == "way"}

def kind_of(e, default):
    t = e.get("tags", {})
    note = (t.get("note", "") + " " + t.get("name", "")).lower()
    if "pressure tunnel" in note or t.get("tunnel") in ("flooded", "yes", "culvert") or t.get("layer") == "-3": return "tunnel"
    if t.get("location") == "overground" or t.get("bridge") == "yes": return "bridge" if t.get("bridge") == "yes" else default
    return default

ROUTES = {
    # Croton: the 1842 masonry conduit runs just under the surface; the trail follows its roof
    "old-croton-aqueduct": ([e for e in aq if e["type"] == "way" and e["tags"].get("name", "").startswith(
        ("Old Croton Aqueduct Trail", "Old Croton Aqueduct Walk", "Aqueduct Walk (")) and e["tags"].get("highway")]
        + named("Old Croton Aqueduct"), "cutcover"),
    "new-croton-aqueduct": (pipe(named("New Croton Aqueduct")), "tunnel"),
    # Catskill: cut-and-cover and grade tunnels, with deep pressure tunnels under valleys
    "catskill-aqueduct": (pipe(named("Catskill Aqueduct", "Rondout Pressure Tunnel", "Wallkill Pressure Tunnel"))
                          + [by_id[i] for i in (79366473,) if i in by_id], "cutcover"),
    "shandaken-tunnel": (named("Shandaken Tunnel"), "tunnel"),
    "delaware-aqueduct": (pipe(named("Delaware Aqueduct", "Roundout - West Branch Tunnel", "West Branch Bypass")), "tunnel"),
    "east-delaware-tunnel": (pipe(named("East Delaware Aqueduct")), "tunnel"),
    "west-delaware-tunnel": (pipe(named("West Delaware Tunnel")), "tunnel"),
    "neversink-tunnel": (pipe(named("Neversink Tunnel")), "tunnel"),
}
FORCE = {"delaware-aqueduct", "east-delaware-tunnel", "west-delaware-tunnel", "neversink-tunnel",
         "shandaken-tunnel", "new-croton-aqueduct"}   # deep rock tunnels end to end

def chain(ways, start, kind_default, force):
    """Greedily join ways end to end (flipping as needed), starting nearest the source."""
    segs = []
    for e in ways:
        k = kind_default if force else kind_of(e, kind_default)
        segs.append([(round(lo, 5), round(la, 5), k) for lo, la in geom(e)])
    chains = []
    while segs:
        # start a chain at the segment end nearest the source (or the previous chain's end)
        ref = chains[-1][-1][:2] if chains else start
        best = min([(dist_km(ref, s[0][:2]), i, False) for i, s in enumerate(segs)]
                   + [(dist_km(ref, s[-1][:2]), i, True) for i, s in enumerate(segs)])
        c = segs.pop(best[1]); c = c[::-1] if best[2] else c
        grew = True
        while grew and segs:
            grew = False
            for i, s in enumerate(segs):
                for rev in (False, True):
                    s2 = s[::-1] if rev else s
                    if dist_km(c[-1][:2], s2[0][:2]) < 0.15:
                        c += s2[1:] if c[-1][:2] == s2[0][:2] else s2
                        segs.pop(i); grew = True; break
                if grew: break
        chains.append(c)
    return chains

routes, report = {}, []
for aid, (ways, default) in ROUTES.items():
    if not ways or aid not in schematic: continue
    src = tuple(schematic[aid]["geometry"]["coordinates"][0])
    chains = [c for c in chain(ways, src, default, aid in FORCE) if sum(dist_km(a[:2], b[:2]) for a, b in zip(c, c[1:])) > 0.3]
    runs = []
    for c in chains:
        cur = None
        for lo, la, k in c:
            if cur is None or cur["kind"] != k:
                if cur: cur["coords"].append([lo, la])     # runs share their joint
                cur = {"kind": k, "coords": [[lo, la]]}; runs.append(cur)
            else:
                cur["coords"].append([lo, la])
        runs.append(None)   # gap marker between chains
    runs = [r for r in runs if r]
    for r in runs: r["coords"] = [list(p) for p in simplify([tuple(p) for p in r["coords"]])]
    km = sum(dist_km(a, b) for r in runs for a, b in zip(r["coords"], r["coords"][1:]))
    routes[aid] = {"source": "osm", "runs": runs}
    report.append(f"  {aid:22s} {len(ways):3d} ways -> {len(chains)} pieces, {len(runs)} runs, {km:6.1f} km "
                  f"({', '.join(sorted(set(r['kind'] for r in runs)))})")
json.dump({"attribution": "© OpenStreetMap contributors (ODbL)", "routes": routes},
          open(f"{out}/routes.json", "w"), separators=(",", ":"))
print("routes.json:"); print("\n".join(report))
print("  schematic only:", sorted(set(schematic) - set(routes)))

if debug:
    img = Image.new("RGB", (W, H), (235, 235, 230))
    img.paste((120, 170, 220), mask=lake_layer); img.paste((90, 140, 200), mask=river_layer)
    dd = ImageDraw.Draw(img)
    for f in schematic.values():
        dd.line([px(*p) for p in f["geometry"]["coordinates"]], fill=(200, 200, 200), width=5)
    col = {"tunnel": (200, 40, 40), "cutcover": (30, 30, 30), "bridge": (240, 160, 0)}
    for r in (r for v in routes.values() for r in v["runs"]):
        dd.line([px(*p) for p in r["coords"]], fill=col[r["kind"]], width=4)
    img.save(debug)
