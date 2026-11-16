"""Regional map editions for the zoomed-out view: the USGS 1:250,000 sheets (1° x 2°) that cover the
whole region, warped onto the region's web-mercator grid and clipped to their neatlines.

The detailed valley maps only show up close (main.ts); from farther out the region is draped with
these instead. The series begins in the 1940s; before that, no single-scale series covers the
region (the 1:125,000 sheets of c.1900 cover only its New Jersey and Connecticut corners).

Sheets (USGS Historical Topographic Map Collection, via The National Map; public domain), in
<sheet_dir> as downloaded, named <ST>_<Name>_<id>_<year>_250000_geo.tif.

usage: python pipeline/regional_maps.py <sheet_dir> <web_data_dir>
writes <web_data_dir>/region_map<i>.jpg and region_maps.json
"""
import glob, json, math, os, re, sys
import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import reproject, Resampling, transform as warp_xy
from rasterio.transform import from_bounds

src_dir, out = sys.argv[1:3]
scene = json.load(open(f"{out}/scene.json"))
b = scene["region"]["bounds"]
R = 6378137
mx = lambda lon: math.radians(lon) * R
my = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
W = 3072
H = round(W * (my(b["north"]) - my(b["south"])) / (mx(b["east"]) - mx(b["west"])))
dst_tf = from_bounds(mx(b["west"]), my(b["south"]), mx(b["east"]), my(b["north"]), W, H)
# each pixel's lon/lat, for the neatline clip
lon = np.degrees(((np.arange(W) + 0.5) / W * (mx(b["east"]) - mx(b["west"])) + mx(b["west"])) / R)
lat = np.degrees(2 * np.arctan(np.exp(((np.arange(H) + 0.5) / H * (my(b["south"]) - my(b["north"])) + my(b["north"])) / R)) - math.pi / 2)

# the 1° x 2° cell of each sheet, from its name: the series' grid, by sheet
CELLS = {"Albany": (-74, 42), "Binghamton": (-76, 42), "Hartford": (-74, 41), "Scranton": (-76, 41),
         "New_York": (-74, 40), "Newark": (-76, 40)}
EDITIONS = [(1940, 1955), (1955, 1970)]   # c.1948 and c.1960
sheets = []
for f in sorted(glob.glob(f"{src_dir}/*_250000_geo.tif")):
    m = re.match(r"[A-Z]{2}_(.+)_(\d+)_(\d{4})_250000_geo\.tif", os.path.basename(f))
    sheets.append(dict(file=f, name=m.group(1), year=int(m.group(3))))
doc = []
for i, (y0, y1) in enumerate(EDITIONS):
    tex = np.zeros((3, H, W), np.uint8); used = []
    for s in [s for s in sheets if y0 <= s["year"] < y1]:
        w, so = CELLS[s["name"]]
        with rasterio.open(s["file"]) as r:
            band = np.zeros((3, H, W), np.uint8)
            for k in range(3):
                reproject(rasterio.band(r, k + 1), band[k], dst_transform=dst_tf, dst_crs="EPSG:3857", resampling=Resampling.average, dst_nodata=0)
        inside = ((lon[None, :] >= w) & (lon[None, :] < w + 2) & (lat[:, None] >= so) & (lat[:, None] < so + 1)) & (band.sum(0) > 0)
        # the sheets were printed in different styles (Scranton's with dark shaded relief): bring
        # each to the same overall tone, channel by channel, so their edges don't read as seams
        px = band[:, inside].astype(np.float32)
        TARGET_MEAN, TARGET_SD = np.array([200, 200, 175.]), np.array([38, 34, 40.])
        px = (px - px.mean(1, keepdims=True)) / (px.std(1, keepdims=True) + 1e-3) * TARGET_SD[:, None] + TARGET_MEAN[:, None]
        tex[:, inside] = np.clip(px, 0, 255).astype(np.uint8)
        used.append(dict(name=s["name"].replace("_", " "), year=s["year"]))
    fn = f"region_map{i}.jpg"
    Image.fromarray(tex.transpose(1, 2, 0)).save(f"{out}/{fn}", quality=82)
    year = round(sum(u["year"] for u in used) / len(used))
    doc.append(dict(file=fn, year=year, sheets=used))
    print(fn, year, used, f"{(tex.sum(0) > 0).mean():.0%} covered")
json.dump(dict(scale="1:250,000", source="USGS Historical Topographic Map Collection", editions=doc), open(f"{out}/region_maps.json", "w"), indent=1)
