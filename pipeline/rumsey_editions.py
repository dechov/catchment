"""Older map editions for the city patch, from georeferenced David Rumsey maps of Manhattan.

The maps (data/rumsey layout: <id>_<year>.png in web mercator, with <id>.json giving title,
author, year and lon/lat bounds) are Stanford's published georeferenced copies of David Rumsey
Map Collection scans, CC BY-NC-SA 3.0 ("Image from the David Rumsey Map Collection courtesy
Stanford University Libraries"). Each GROUP below becomes one edition: its maps resampled onto
the city patch's grid (later maps of a group drawn over earlier ones), black where none reach.
The sheets' margins, borders, titles and inset views land on the rivers, New Jersey and Brooklyn,
so each edition is clipped to Manhattan: a rough outline widened ~300 m, and today's land.

The editions go first in <terrain_dir>/city_editions.json, ahead of the USGS ones that
map_editions.py writes; running this again replaces them. Run it after map_editions.py and before
export_web.py.

usage: python pipeline/rumsey_editions.py <terrain_dir> <rumsey_dir>
"""
import json, math, sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
# editions, oldest first: the Rumsey ids drawn into each (two Dripps sheets meet at 50th Street)
GROUPS = [["g2784000"], ["g2495000", "g2620000"], ["g0149024"], ["g3723000"]]
# Manhattan, roughly (lon, lat), Battery round by the Hudson, Inwood and the Harlem and East Rivers
MANHATTAN = [(-74.020, 40.700), (-74.018, 40.712), (-74.013, 40.735), (-74.012, 40.757), (-73.997, 40.775),
             (-73.983, 40.800), (-73.962, 40.830), (-73.945, 40.857), (-73.935, 40.875), (-73.922, 40.879),
             (-73.910, 40.875), (-73.927, 40.855), (-73.933, 40.835), (-73.932, 40.810), (-73.927, 40.800),
             (-73.942, 40.778), (-73.958, 40.757), (-73.968, 40.740), (-73.972, 40.727), (-73.975, 40.712),
             (-73.995, 40.707), (-74.010, 40.700)]
R = 6378137
mx = lambda lon: math.radians(lon) * R
my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def onto(img, b, meta):
    """A web-mercator image with lon/lat bounds b, resampled onto the patch grid of meta."""
    W, H = meta["width"], meta["height"]
    X0, X1, Y0, Y1 = mx(meta["west"]), mx(meta["east"]), my(meta["north"]), my(meta["south"])
    sx0, sx1, sy0, sy1 = mx(b["west"]), mx(b["east"]), my(b["north"]), my(b["south"])
    w, h = img.size
    # the patch's corners in the source image's pixels: an affine map (both are web mercator)
    a = (X1 - X0) / W / ((sx1 - sx0) / w); c = (X0 - sx0) / ((sx1 - sx0) / w)
    e = (Y1 - Y0) / H / ((sy1 - sy0) / h); f = (Y0 - sy0) / ((sy1 - sy0) / h)
    out = img.convert("RGB").transform((W, H), Image.AFFINE, (a, 0, c, 0, e, f), resample=Image.BILINEAR, fillcolor=(0, 0, 0))
    return np.asarray(out)


def clip_mask(meta, tdir, widen_m=300):
    from PIL import ImageDraw
    from scipy import ndimage
    W, H = meta["width"], meta["height"]
    X0, X1, Y0, Y1 = mx(meta["west"]), mx(meta["east"]), my(meta["north"]), my(meta["south"])
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).polygon([((mx(lo) - X0) / (X1 - X0) * W, (my(la) - Y0) / (Y1 - Y0) * H) for lo, la in MANHATTAN], fill=1)
    near = ndimage.binary_dilation(np.asarray(im) > 0, iterations=int(widen_m / meta["meters_per_pixel_approx"]))
    # and today's land (which takes in the old shores; the landfill only added to them), so the
    # paper isn't laid over the rivers
    v = np.asarray(Image.open(f"{tdir}/city_height16.png")).astype(np.float64)
    land = meta["elev_min_m"] + v / 65535 * (meta["elev_max_m"] - meta["elev_min_m"]) > 0.5
    return near & ndimage.binary_dilation(land, iterations=int(40 / meta["meters_per_pixel_approx"]))


def main():
    tdir, rdir = sys.argv[1:3]
    meta = json.load(open(f"{tdir}/city_meta.json"))
    ep = f"{tdir}/city_editions.json"
    doc = json.load(open(ep))
    usgs = [e for e in doc["editions"] if not e.get("rumsey")]
    new, keep = [], clip_mask(meta, tdir)
    for i, group in enumerate(GROUPS):
        tex = np.zeros((meta["height"], meta["width"], 3), np.uint8)
        sheets = []
        for gid in group:
            m = json.load(open(f"{rdir}/{gid}.json"))
            px = onto(Image.open(f"{rdir}/{m['image']}"), m["bounds"], meta)
            has = (px.astype(np.int32).sum(2) > 24) & keep
            tex[has] = px[has]
            sheets.append(dict(title=f"{m['author'].split(';')[0].split(',')[0]} {m['year']}: {m['title'].replace(' (Raster Image)', '')}",
                               year=m["year"], url=m.get("stanford_purl")))
        f = f"city_topo_r{i}.png"
        Image.fromarray(tex).save(f"{tdir}/{f}")
        new.append(dict(file=f, phase="pre", year=max(s["year"] for s in sheets), sheets=sheets, rumsey=True))
        print(f, [s["title"][:60] for s in sheets], f"{(tex.sum(2) > 0).mean():.0%} of the patch")
    doc["editions"] = new + usgs
    json.dump(doc, open(ep, "w"), indent=1)


if __name__ == "__main__":
    main()
