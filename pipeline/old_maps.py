"""Find and download pre-reservoir USGS topographic sheets for each valley.

For every valley in VALLEYS it queries The National Map (TNM) for historical topo GeoTIFFs that
intersect the valley's box, keeps one sheet per quadrangle (the latest edition printed before the
reservoir started filling, preferring 1:24,000 over 1:31,680 over 1:62,500), downloads them and
writes <out>/<valley>/sheets.json. Use --skip to drop editions found (by eye) to be reprints that
already show the reservoir.

usage: python pipeline/old_maps.py <out_dir> [--only id,id] [--skip url_substring,...]
"""
import json, os, sys, urllib.parse, urllib.request

# id: (bbox west, south, east, north), fill start year[, latest map year]. Boxes come from the
# reservoir outlines found in modern terrain (pipeline/export_web.py) plus ~1.5 km. A map cutoff
# earlier than filling is set where later editions already print the planned reservoir (the
# 1902 Tarrytown sheet shows New Croton Reservoir in blue).
VALLEYS = {
    "new-croton": ((-73.876, 41.200, -73.713, 41.266), 1905, 1900),
    "kensico": ((-73.790, 41.052, -73.703, 41.140), 1915),
    "schoharie": ((-74.471, 42.321, -74.417, 42.407), 1924),
    "rondout": ((-74.505, 41.784, -74.408, 41.855), 1950),
    "neversink": ((-74.690, 41.805, -74.623, 41.891), 1953),
    "pepacton": ((-74.982, 42.052, -74.731, 42.135), 1954),
    "cannonsville": ((-75.394, 42.048, -75.152, 42.183), 1963),
}
SCALE_RANK = {"24000": 0, "31680": 1, "62500": 2}


def query(bbox):
    q = urllib.parse.urlencode({"datasets": "Historical Topographic Maps", "bbox": ",".join(map(str, bbox)),
                                "max": 300, "prodFormats": "GeoTIFF"})
    return json.load(urllib.request.urlopen("https://tnmaccess.nationalmap.gov/api/v1/products?" + q, timeout=120))["items"]


def main():
    out = sys.argv[1]
    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else list(VALLEYS)
    skip = sys.argv[sys.argv.index("--skip") + 1].split(",") if "--skip" in sys.argv else []
    for vid in only:
        bbox, fill, *cut = VALLEYS[vid]
        cutoff = cut[0] if cut else fill
        best = {}
        for it in query(bbox):
            year = int(it["publicationDate"][:4])
            scale = next((s for s in SCALE_RANK if f"{s}-scale" in it["title"] or f"_{s}_" in it["downloadURL"]), None)
            if scale is None or year >= cutoff or any(s in it["downloadURL"] for s in skip):
                continue
            bb = it["boundingBox"]
            quad = (round(bb["minX"], 3), round(bb["minY"], 3), round(bb["maxX"], 3), round(bb["maxY"], 3))
            key = (SCALE_RANK[scale], -year)
            if quad not in best or key < best[quad][0]:
                best[quad] = (key, dict(title=it["title"], year=year, scale=scale, url=it["downloadURL"],
                                         neatline=list(quad)))
        sheets = [v[1] for v in best.values()]
        # a finer sheet makes a coarser one covering the same ground unnecessary
        sheets.sort(key=lambda s: SCALE_RANK[s["scale"]])
        keep = []
        for s in sheets:
            w, so, e, n = s["neatline"]
            covered = any(k["neatline"][0] <= w and k["neatline"][1] <= so and k["neatline"][2] >= e and k["neatline"][3] >= n
                          for k in keep)
            if not covered:
                keep.append(s)
        os.makedirs(f"{out}/{vid}", exist_ok=True)
        for s in keep:
            fn = urllib.parse.unquote(s["url"].rsplit("/", 1)[1])
            s["file"] = fn
            p = f"{out}/{vid}/{fn}"
            if not os.path.exists(p):
                urllib.request.urlretrieve(s["url"], p)
        json.dump(dict(valley=vid, bbox=bbox, fill_start=fill, sheets=keep), open(f"{out}/{vid}/sheets.json", "w"), indent=1)
        print(vid, [(s["title"].replace("USGS ", "").replace("-scale Quadrangle for", ""), s["year"]) for s in keep])


if __name__ == "__main__":
    main()
