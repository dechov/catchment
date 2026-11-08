"""Automatic checks for artifacts in the scene's data (web/public/data), to run before each push.

For every detail patch it looks for:
  - cliffs: ground in the pre-dam terrain far steeper than the same place today (a wrongly cut
    reservoir footprint or a bad floor leaves a wall; real cliffs are steep in both), except
    within 400 m of a dam, whose embankment stands steep against the old ground anyway;
  - water on hillsides: water-plane mask over ground standing well above the water level today;
  - map holes: parts of a map edition with no sheet (outside the feathered patch edge);
  - mask spill: a reservoir footprint reaching the patch border (a reservoir cut by its patch).
It prints one line per problem, with where to look (?view=@lon,lat,km), and exits 1 if any.

usage: python pipeline/check_scene.py <terrain_dir> [web_data_dir]
"""
import json, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage

tdir = sys.argv[1]
D = sys.argv[2] if len(sys.argv) > 2 else "web/public/data"
scene = json.load(open(f"{D}/scene.json"))
problems = []


def terrarium(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def modern(vid, shape):
    m = json.load(open(f"{tdir}/{vid}_meta.json"))
    v = np.asarray(Image.open(f"{tdir}/{vid}_height16.png").resize(shape[::-1], Image.BILINEAR)).astype(np.float64)
    return m["elev_min_m"] + v / 65535 * (m["elev_max_m"] - m["elev_min_m"])


def lonlat(b, shape, y, x):
    N = lambda lat: math.asinh(math.tan(math.radians(lat)))
    lon = b["west"] + (x + 0.5) / shape[1] * (b["east"] - b["west"])
    yn, ys = N(b["north"]), N(b["south"])
    lat = math.degrees(math.atan(math.sinh(yn + (y + 0.5) / shape[0] * (ys - yn))))
    return lon, lat


DAM_PTS = [p for d in scene["dams"] for c in (d["crests"] or [[[d["lon"], d["lat"]]]]) for p in c]


def near_dam(lon, lat, m=400):
    k = math.cos(math.radians(lat))
    return any(math.hypot((lo - lon) * k, la - lat) * 111_200 < m for lo, la in DAM_PTS)


def report(vid, kind, b, shape, comp, msg):
    ys, xs = np.nonzero(comp)
    lon, lat = lonlat(b, shape, ys.mean(), xs.mean())
    problems.append(f"{vid:13s} {kind:14s} {msg}  ?view=@{lon:.3f},{lat:.3f},4")


for v in scene["valleys"]:
    vid, b = v["id"], v["bounds"]
    pre = terrarium(f"{D}/{vid}_pre.png")
    H, W = pre.shape
    mpp = (b["east"] - b["west"]) * 111_200 * math.cos(math.radians((b["north"] + b["south"]) / 2)) / W
    now = modern(vid, pre.shape)
    mask = np.asarray(Image.open(f"{D}/{vid}_mask.png").convert("L")) > 127
    slope = lambda e: np.hypot(*np.gradient(e, mpp))
    s_pre, s_now = slope(pre), slope(now)
    # 1. cliffs that today's ground doesn't have, in clusters longer than ~150 m
    cliff = (s_pre > 0.9) & (s_pre - s_now > 0.6)
    lab, n = ndimage.label(ndimage.binary_dilation(cliff, iterations=1))
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        comp = lab[sl] == i
        if max(comp.shape) * mpp > 150 and comp.sum() > 20:
            full = np.zeros_like(cliff); full[sl] = comp
            lon, lat = lonlat(b, pre.shape, *np.argwhere(full).mean(0))
            if near_dam(lon, lat):   # a dam's own embankment and spillway stand steep against the old ground
                continue
            report(vid, "cliff", b, pre.shape, full, f"{comp.sum()} px, {max(comp.shape) * mpp:.0f} m long")
    # 2. water drawn over ground well above the water level
    if v["reservoir_id"] >= 0:
        water = np.asarray(Image.open(f"{D}/{vid}_water.png").convert("L").resize((W, H))) > 127
        high = water & (now > v["water_level_m"] + 8)
        lab, n = ndimage.label(high)
        for i in range(1, n + 1):
            comp = lab == i
            if comp.sum() * mpp * mpp > 5000:
                report(vid, "water-on-land", b, pre.shape, comp, f"{comp.sum() * mpp * mpp / 1e4:.1f} ha")
        # 4. the footprint touching the patch edge
        edge = np.zeros_like(mask); edge[:2] = edge[-2:] = True; edge[:, :2] = edge[:, -2:] = True
        if (mask & edge).sum() > 10:
            report(vid, "mask-at-edge", b, pre.shape, mask & edge, f"{(mask & edge).sum()} border px")
    # 3. map editions with holes inside the patch
    for ed in v.get("editions", []):
        m = np.asarray(Image.open(f"{D}/{ed['file']}").convert("L").resize((W // 4, H // 4)))
        inner = np.zeros(m.shape, bool)
        mh, mw = m.shape; inner[int(mh * .06):int(mh * .94), int(mw * .06):int(mw * .94)] = True
        hole = (m < 5) & inner
        if hole.sum() / inner.sum() > 0.02:
            big = np.zeros((H, W), bool); big[::4, ::4][:hole.shape[0], :hole.shape[1]] = hole
            report(vid, "map-hole", b, pre.shape, big, f"{ed['file']} ({ed['year']}): {hole.sum() / inner.sum():.0%} uncovered")

print("\n".join(problems) or "no problems found")
sys.exit(1 if problems else 0)
