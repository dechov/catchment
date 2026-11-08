"""Draw dams, reservoirs and schematic aqueducts over the regional hillshade to check alignment.
usage: python pipeline/preview_map.py <terrain_dir> <out.png>
"""
import json, math, os, sys
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tdir, out = sys.argv[1], sys.argv[2]
m = json.load(open(f"{tdir}/region_meta.json"))
img = Image.open(f"{tdir}/region_hillshade.png").convert("RGB")
scale = 1600 / img.height
img = img.resize((int(img.width * scale), 1600))
n = 2 ** m["zoom"] * 256
def ty(lat): r = math.radians(lat); return (1 - math.asinh(math.tan(r)) / math.pi) / 2 * n
X0 = (m["west"] + 180) / 360 * n; Y0 = ty(m["north"])
def px(lon, lat): return (((lon + 180) / 360 * n - X0) * scale, (ty(lat) - Y0) * scale)
COL = {"croton": (200, 90, 40), "catskill": (30, 120, 200), "delaware": (40, 150, 80), "modern": (150, 60, 170)}
d = ImageDraw.Draw(img)
for f in json.load(open(f"{ROOT}/data/aqueducts.geojson"))["features"]:
    d.line([px(*c) for c in f["geometry"]["coordinates"]], fill=COL[f["properties"]["system"]], width=3)
for f in json.load(open(f"{ROOT}/data/dams.geojson"))["features"]:
    x, y = px(*f["geometry"]["coordinates"]); d.rectangle([x - 3, y - 3, x + 3, y + 3], fill=(0, 0, 0))
for f in json.load(open(f"{ROOT}/data/timeline.json"))["features"]:
    if f["kind"] == "reservoir":
        x, y = px(f["lon"], f["lat"]); d.ellipse([x - 5, y - 5, x + 5, y + 5], outline=COL[f["system"]], width=2)
        d.text((x + 7, y - 6), f["name"].replace(" Reservoir", ""), fill=(0, 0, 0))
img.save(out); print(out, img.size)
