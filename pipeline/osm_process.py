"""Turn raw OpenStreetMap extracts (Overpass JSON) into the small GeoJSON files the scene uses.

Inputs (<osm_dir>, fetched with the queries in the README):
  aqueducts.json  ways/relations named like aqueducts and tunnels, plus water pipelines
  lakes.json      natural=water
  rivers.json     waterway=river
Outputs (data/):
  osm_aqueducts.geojson  one MultiLineString per timeline feature id, ways merged into chains
  osm_lakes.geojson      water polygons (closed ways only; the extract has no relation geometry)
  osm_rivers.geojson     simplified river lines
Data (c) OpenStreetMap contributors, ODbL.

usage: python pipeline/osm_process.py <osm_dir>
"""
import json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
osm = sys.argv[1]

# OSM name -> timeline feature id. Trails that run on top of the Old Croton Aqueduct count as
# its route; side structures (gatehouses, weirs, shafts, plants, bypasses) are left out.
NAME_TO_ID = {
    "Old Croton Aqueduct": "old-croton-aqueduct",
    "Old Croton Aqueduct Trail": "old-croton-aqueduct",
    "Aqueduct Walk": "old-croton-aqueduct",
    "New Croton Aqueduct": "new-croton-aqueduct",
    "Catskill Aqueduct": "catskill-aqueduct",
    "Rondout Pressure Tunnel": "catskill-aqueduct",
    "Wallkill Pressure Tunnel": "catskill-aqueduct",
    "Delaware Aqueduct": "delaware-aqueduct",
    "Roundout - West Branch Tunnel": "delaware-aqueduct",
    "Delaware Aqueduct Bypass": "delaware-bypass",
    "East Delaware Aqueduct": "east-delaware-tunnel",
    "West Delaware Tunnel": "west-delaware-tunnel",
    "Neversink Tunnel": "neversink-tunnel",
    "Shandaken Tunnel": "shandaken-tunnel",
}


def dist_m(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111_320


def merge_chains(lines, tol_m=40):
    """Greedy line merge: join lines whose ends meet (within tol), flipping as needed."""
    chains = [list(l) for l in lines if len(l) >= 2]
    merged = True
    while merged:
        merged = False
        for i in range(len(chains)):
            for j in range(len(chains)):
                if i == j or not chains[i] or not chains[j]:
                    continue
                a, b = chains[i], chains[j]
                if dist_m(a[-1], b[0]) < tol_m: chains[i] = a + b[1:]
                elif dist_m(a[-1], b[-1]) < tol_m: chains[i] = a + b[::-1][1:]
                elif dist_m(a[0], b[-1]) < tol_m: chains[i] = b + a[1:]
                elif dist_m(a[0], b[0]) < tol_m: chains[i] = b[::-1] + a[1:]
                else: continue
                chains[j] = []; merged = True
        chains = [c for c in chains if c]
    return chains


def simplify(pts, tol_m):
    """Douglas-Peucker in metres."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    k = math.cos(math.radians(a[1]))
    ax, ay, bx, by = a[0] * k, a[1], b[0] * k, b[1]
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy) or 1e-12
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i][0] * k, pts[i][1]
        d = abs(dy * px - dx * py + bx * ay - by * ax) / L * 111_320
        if d > best: best, idx = d, i
    if best <= tol_m:
        return [a, b]
    return simplify(pts[:idx + 1], tol_m)[:-1] + simplify(pts[idx:], tol_m)


def line_len_km(c): return sum(dist_m(c[i], c[i + 1]) for i in range(len(c) - 1)) / 1000


def main():
    out = {}
    for e in json.load(open(f"{osm}/aqueducts.json"))["elements"]:
        if e["type"] != "way" or "geometry" not in e:
            continue
        fid = NAME_TO_ID.get(e.get("tags", {}).get("name", "").strip())
        if fid:
            out.setdefault(fid, []).append([(round(g["lon"], 6), round(g["lat"], 6)) for g in e["geometry"]])
    feats = []
    for fid, lines in sorted(out.items()):
        chains = [simplify(c, 8) for c in merge_chains(lines)]
        chains.sort(key=line_len_km, reverse=True)
        feats.append({"type": "Feature", "properties": {"id": fid, "ways": len(lines), "chains": len(chains),
                      "length_km": round(sum(map(line_len_km, chains)), 1)},
                      "geometry": {"type": "MultiLineString", "coordinates": chains}})
        print(f"{fid:24s} ways {len(lines):4d} -> chains {len(chains):3d}, {feats[-1]['properties']['length_km']} km")
    json.dump({"type": "FeatureCollection", "attribution": "(c) OpenStreetMap contributors, ODbL", "features": feats},
              open(f"{ROOT}/data/osm_aqueducts.geojson", "w"))

    lakes = []
    for e in json.load(open(f"{osm}/lakes.json"))["elements"]:
        g = e.get("geometry")
        if e["type"] != "way" or not g or len(g) < 4 or (g[0]["lat"], g[0]["lon"]) != (g[-1]["lat"], g[-1]["lon"]):
            continue
        pts = [(round(p["lon"], 5), round(p["lat"], 5)) for p in g]
        far = max(range(len(pts)), key=lambda i: dist_m(pts[0], pts[i]))  # closed ring: split in two
        ring = simplify(pts[:far + 1], 15)[:-1] + simplify(pts[far:], 15)
        if len(ring) < 4:
            continue
        t = e.get("tags", {})
        lakes.append({"type": "Feature", "properties": {"name": t.get("name"), "water": t.get("water")},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})
    json.dump({"type": "FeatureCollection", "attribution": "(c) OpenStreetMap contributors, ODbL", "features": lakes},
              open(f"{ROOT}/data/osm_lakes.geojson", "w"), separators=(",", ":"))

    rivers = []
    for e in json.load(open(f"{osm}/rivers.json"))["elements"]:
        g = e.get("geometry")
        if not g:
            continue
        rivers.append([(round(p["lon"], 5), round(p["lat"], 5)) for p in g])
    rivers = [simplify(c, 25) for c in merge_chains(rivers, 15)]
    json.dump({"type": "FeatureCollection", "attribution": "(c) OpenStreetMap contributors, ODbL",
               "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "MultiLineString", "coordinates": rivers}}]},
              open(f"{ROOT}/data/osm_rivers.geojson", "w"), separators=(",", ":"))
    print(len(lakes), "lakes,", len(rivers), "river lines")


if __name__ == "__main__":
    main()
