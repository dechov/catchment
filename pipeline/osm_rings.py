"""Rings of OpenStreetMap water areas.

A multipolygon relation's outer boundary is usually split over several member ways, each an open
line. Drawing those members one by one as polygons closes every one of them with a straight
chord across the lake (Cannonsville's west arm was cut this way), so they are stitched end to
end into closed rings first. A ring that cannot be closed is dropped.
"""


def stitch(segs):
    """Join open lines (lists of (lon, lat)) that share end points into closed rings."""
    segs = [list(s) for s in segs if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop()
        grown = True
        while ring[0] != ring[-1] and grown:
            grown = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]: ring = ring + s[1:]
                elif s[-1] == ring[-1]: ring = ring + s[::-1][1:]
                elif s[-1] == ring[0]: ring = s + ring[1:]
                elif s[0] == ring[0]: ring = s[::-1] + ring[1:]
                else: continue
                segs.pop(i); grown = True; break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def water_rings(e):
    """(outer rings, inner rings) of an Overpass way or relation with geometry, as (lon, lat)."""
    pts = lambda g: [(p["lon"], p["lat"]) for p in g]
    if e["type"] == "way":
        g = e.get("geometry") or []
        return ([pts(g)] if len(g) >= 4 and g[0] == g[-1] else []), []
    if e["type"] != "relation":
        return [], []
    by = {"outer": [], "inner": []}
    for m in e.get("members", []):
        if m.get("type") == "way" and m.get("geometry") and m.get("role", "outer") in ("outer", "inner", ""):
            by[m.get("role") or "outer"].append(pts(m["geometry"]))
    return stitch(by["outer"]), stitch(by["inner"])
