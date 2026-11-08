"""Dated editions of the old USGS maps for each detail patch: a stack of map composites, each
shown in the scene from the year its sheets were printed until the next one replaces it.

Each area has a list of year windows. A window's composite takes, for every quadrangle, the
latest sheet printed in that window (1:24,000, 1:31,680 or 1:62,500). Windows before the area's
map cutoff (old_maps.VALLEYS) are "pre" editions, shown before the reservoir; windows after it
are "post" editions, shown once it holds water, so the patch is never left as bare terrain. A
quadrangle with no sheet in a window keeps the sheet of the previous window of the same phase,
(else the next one's), so pre-reservoir ground is never filled in with a map of the reservoir or
the other way round.

Writes <terrain_dir>/<area>_topo_e<i>.png and <terrain_dir>/<area>_editions.json, downloading
sheets into <map_dir>/<area>/.

usage: python pipeline/map_editions.py <terrain_dir> <map_dir> [--only id,id]
"""
import json, math, os, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from old_maps import VALLEYS, SCALE_RANK, query

Image.MAX_IMAGE_PIXELS = None
# area: [(first year, last year), ...] of each edition, oldest first
EDITIONS = {
    "ashokan": [(0, 1911), (1916, 1960), (1961, 2010)],
    "new-croton": [(0, 1898), (1906, 1950), (1951, 2010)],
    "kensico": [(0, 1894), (1916, 1950), (1951, 2010)],
    "schoharie": [(0, 1923), (1926, 2010)],
    "rondout": [(0, 1930), (1931, 1949), (1951, 2010)],
    "neversink": [(0, 1930), (1931, 1952), (1954, 2010)],
    "pepacton": [(0, 1930), (1931, 1953), (1956, 2010)],
    "cannonsville": [(0, 1940), (1941, 1962), (1965, 2010)],
    "city": [(0, 1892), (1893, 1901), (1930, 1950), (1951, 1970), (1971, 2010)],
}
FILL = {"ashokan": (1912, 1912)}   # areas not in old_maps.VALLEYS: (fill start, map cutoff)
NO_RESERVOIR = {"city"}   # one phase: any edition may lend a sheet to another


def composite(sheets, meta, folder):
    """The sheets warped onto a terrain patch's web-mercator grid, finer sheets over coarser."""
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    H, W = meta["height"], meta["width"]
    N = 2 ** meta["zoom"] * 256
    ty = lambda lat: (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
    R = 6378137
    mx = lambda lon: math.radians(lon) * R
    my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    dst_T = from_bounds(mx(meta["west"]), my(meta["south"]), mx(meta["east"]), my(meta["north"]), W, H)
    lon_px = meta["west"] + (np.arange(W) + 0.5) / W * (meta["east"] - meta["west"])
    lat_px = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty(meta["north"]) + np.arange(H) + 0.5) / N))))
    tex = np.zeros((3, H, W), np.uint8)
    for s in sorted(sheets, key=lambda s: (not s.get("lent"), -SCALE_RANK[s["scale"]])):   # lent, then coarse first
        qw, qs, qe, qn = s["neatline"]
        with rasterio.open(f"{folder}/{s['file']}") as r:
            tmp = np.zeros_like(tex)
            for b in range(3):
                reproject(r.read(min(b + 1, r.count)), tmp[b], src_transform=r.transform, src_crs=r.crs,
                          dst_transform=dst_T, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
        m = ((lon_px >= qw) & (lon_px < qe))[None, :] & ((lat_px >= qs) & (lat_px < qn))[:, None] & (tmp.sum(0) > 0)
        tex[:, m] = tmp[:, m]
    return tex.transpose(1, 2, 0)


def pick(items, lo, hi):
    """Per quadrangle and scale, the latest sheet printed in [lo, hi]."""
    best = {}
    for it in items:
        year = int(it["publicationDate"][:4])
        scale = next((s for s in SCALE_RANK if f"{s}-scale" in it["title"] or f"_{s}_" in it["downloadURL"]), None)
        if scale is None or not lo <= year <= hi:
            continue
        bb = it["boundingBox"]
        quad = (round(bb["minX"], 3), round(bb["minY"], 3), round(bb["maxX"], 3), round(bb["maxY"], 3))
        if quad not in best or year > best[quad]["year"]:
            best[quad] = dict(title=it["title"], year=year, scale=scale, url=it["downloadURL"], neatline=list(quad))
    return best


def drop_covered(sheets):
    """A finer sheet makes a coarser one covering the same ground unnecessary."""
    keep = []
    for s in sorted(sheets, key=lambda s: SCALE_RANK[s["scale"]]):
        w, so, e, n = s["neatline"]
        if not any(k["neatline"][0] <= w and k["neatline"][1] <= so and k["neatline"][2] >= e and k["neatline"][3] >= n
                   and SCALE_RANK[k["scale"]] <= SCALE_RANK[s["scale"]] for k in keep):
            keep.append(s)
    return keep


def covered(nl, quads):
    """The share of a neatline's box that the given quadrangle boxes cover (sampled)."""
    w, so, e, n = nl
    pts = [(w + (e - w) * (i + .5) / 12, so + (n - so) * (j + .5) / 12) for i in range(12) for j in range(12)]
    return sum(any(q[0] <= x <= q[2] and q[1] <= y <= q[3] for q in quads) for x, y in pts) / len(pts)


def main():
    tdir, mapdir = sys.argv[1:3]
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else list(EDITIONS)
    for vid in only:
        meta = json.load(open(f"{tdir}/{vid}_meta.json"))
        if vid in VALLEYS:
            bbox, fill, *cut = VALLEYS[vid]
            cutoff = cut[0] if cut else fill
        else:
            bbox = (meta["west"], meta["south"], meta["east"], meta["north"])
            fill, cutoff = FILL[vid]
        if vid in NO_RESERVOIR:
            cutoff = 9999
        items = query(bbox)
        folder = f"{mapdir}/{vid}"; os.makedirs(folder, exist_ok=True)
        wins = EDITIONS[vid]
        owns = [pick(items, lo, hi) for lo, hi in wins]
        phases = ["pre" if hi < cutoff else "post" for lo, hi in wins]
        out, carried = [], {"pre": {}, "post": {}}
        for i, (lo, hi) in enumerate(wins):
            phase, own = phases[i], owns[i]
            # a quadrangle with no sheet in this window: the latest earlier one of the same phase,
            # else the earliest later one of the same phase
            here = {**carried[phase], **own}
            carried[phase] = here
            # a later sheet only fills ground no sheet of this edition covers (the nearest later
            # edition first), and is drawn under them
            lent, have = [], list(here)
            for j in range(i + 1, len(wins)):
                if phases[j] != phase: continue
                for k, q in sorted(owns[j].items(), key=lambda kq: SCALE_RANK[kq[1]["scale"]], reverse=True):
                    if covered(q["neatline"], have) < 0.5:
                        lent.append(q); have.append(k)
            sheets = [dict(s, lent=True) for s in lent] + drop_covered(list(here.values()))
            for s in sheets:
                s["file"] = urllib.parse.unquote(s["url"].rsplit("/", 1)[1])
                if not os.path.exists(f"{folder}/{s['file']}"):
                    urllib.request.urlretrieve(s["url"], f"{folder}/{s['file']}")
            own_years = [s["year"] for s in sheets if s["neatline"] and tuple(s["neatline"]) in own]
            Image.fromarray(composite(sheets, meta, folder)).save(f"{tdir}/{vid}_topo_e{i}.png")
            out.append(dict(file=f"{vid}_topo_e{i}.png", phase=phase, year=min(own_years) if own_years else lo,
                            sheets=[dict(title=s["title"], year=s["year"], url=s["url"]) for s in sheets]))
            print(vid, i, phase, out[-1]["year"], [(s["title"].split(" for ")[-1], s["year"]) for s in sheets], flush=True)
        json.dump(dict(area=vid, fill_start=fill, map_cutoff=cutoff, editions=out), open(f"{tdir}/{vid}_editions.json", "w"), indent=1)


if __name__ == "__main__":
    main()
