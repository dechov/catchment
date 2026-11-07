"""Draw 20 ft contours of the reconstructed pre-dam terrain over the 1903/1905 topo maps, so the
reconstruction can be judged against the surveyed contours. Crop = the reservoir's bounding box.
usage: python pipeline/compare_contours.py <terrain_dir> <out.png>
"""
import json, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
tdir, out = sys.argv[1], sys.argv[2]
m = json.load(open(f"{tdir}/ashokan_predam_meta.json"))
v = np.asarray(Image.open(f"{tdir}/ashokan_predam_height16.png")).astype(np.float64)
e = m["elev_min_m"] + v / 65535 * (m["elev_max_m"] - m["elev_min_m"])
mask = np.asarray(Image.open(f"{tdir}/ashokan_reservoir_mask.png")) > 0
tex = np.asarray(Image.open(f"{tdir}/ashokan_topo_predam.png")).copy()
band = np.floor(e / (20 * 0.3048))
edge = (band != np.roll(band, 1, 0)) | (band != np.roll(band, 1, 1))
tex[edge & mask] = [220, 0, 120]
ys, xs = np.nonzero(mask)
crop = Image.fromarray(tex[ys.min() - 40:ys.max() + 40, xs.min() - 40:xs.max() + 40])
crop.thumbnail((2000, 1400)); crop.save(out); print(out, crop.size)
