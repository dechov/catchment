"""Where every drop drains: flow directions, stream strength and reservoir catchments for the region.

From the region heightmap the scene uses (web/public/data/region_height.png) it:
  1. fills pits by priority flood (with a tiny gradient across flats, so every cell drains to
     the sea or the region's edge);
  2. takes each cell's D8 flow direction (the steepest of its eight neighbours) and the area
     draining through it (flow accumulation);
  3. labels each cell with the first NYC reservoir its water reaches, and each reservoir with the
     next one downstream (so the scene can merge catchments before a reservoir exists).

Writes into the web data folder:
  flow.png        R: D8 direction (0 = none, 1..8 = E, SE, S, SW, W, NW, N, NE), G: log2 of the
                  upstream area in cells (x8), B: the first reservoir downstream (id, 0 = none)
  catchments.json reservoir id -> {next: downstream reservoir id or 0, area_km2}

usage: python pipeline/catchments.py [web_data_dir]
"""
import heapq, json, math, sys
import numpy as np
from PIL import Image

D = sys.argv[1] if len(sys.argv) > 1 else "web/public/data"
scene = json.load(open(f"{D}/scene.json"))
rgb = np.asarray(Image.open(f"{D}/region_height.png").convert("RGB")).astype(np.float64)
z = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
H, W = z.shape
b = scene["region"]["bounds"]
mpp = (b["east"] - b["west"]) * 111_200 * math.cos(math.radians((b["north"] + b["south"]) / 2)) / W
ids = np.asarray(Image.open(f"{D}/region_reservoirs.png").convert("RGB").resize((W, H), Image.NEAREST))[..., 0].astype(np.int32)
print(f"{W}x{H} cells at {mpp:.0f} m")

# --- 1. priority flood ------------------------------------------------------------------------
DX = np.array([1, 1, 0, -1, -1, -1, 0, 1]); DY = np.array([0, 1, 1, 1, 0, -1, -1, -1])
EPS = 1e-4
filled = z.copy().ravel()
done = np.zeros(H * W, bool)
heap = []
sea = (z <= 0.5)
seed = sea.copy(); seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
for i in np.flatnonzero(seed.ravel()):
    heap.append((filled[i], int(i))); done[i] = True
heapq.heapify(heap)
nbr = [(int(dy * W + dx), int(dx)) for dx, dy in zip(DX, DY)]
while heap:
    e, i = heapq.heappop(heap)
    x = i % W
    for off, dx in nbr:
        j = i + off
        if j < 0 or j >= H * W or done[j] or not 0 <= x + dx < W:
            continue
        done[j] = True
        if filled[j] <= e: filled[j] = e + EPS
        heapq.heappush(heap, (filled[j], j))
F = filled.reshape(H, W)
print("filled")

# --- 2. D8 direction and accumulation ---------------------------------------------------------
pad = np.pad(F, 1, constant_values=np.inf)
best = np.zeros((H, W)); dirn = np.zeros((H, W), np.uint8)
for k, (dx, dy) in enumerate(zip(DX, DY)):
    nb = pad[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
    drop = (F - nb) / (math.sqrt(2) if dx and dy else 1)
    better = drop > best
    best[better] = drop[better]; dirn[better] = k + 1
dirn[sea] = 0
yy, xx = np.mgrid[:H, :W]
has = dirn > 0
tx = np.where(has, xx + DX[np.maximum(dirn, 1) - 1], xx); ty = np.where(has, yy + DY[np.maximum(dirn, 1) - 1], yy)
down = np.where(has, ty * W + tx, -1).ravel()
order = np.argsort(-F.ravel(), kind="stable")   # highest first: every cell before the one it drains to
acc = np.ones(H * W)
for i in order:
    j = down[i]
    if j >= 0: acc[j] += acc[i]
print("accumulated")

# --- 3. the first reservoir downstream --------------------------------------------------------
first = ids.ravel().copy()
first[(first <= 0) | (first >= 64)] = 0
for i in order[::-1]:   # lowest first: a cell takes its downstream cell's label unless it has one
    if first[i] == 0 and down[i] >= 0:
        first[i] = first[down[i]]
# each reservoir's next one downstream: follow the flow from its cells out of it
nxt, area = {}, {}
fl = first.reshape(H, W)
for r in scene["reservoirs"]:
    k = r["id"]
    cells = np.flatnonzero(ids.ravel() == k)
    area[k] = round(float((fl == k).sum()) * mpp * mpp / 1e6, 1)
    if not len(cells): nxt[k] = 0; continue
    # the outlet: the reservoir cell with the largest accumulation, then downstream out of it
    j = int(cells[np.argmax(acc[cells])]); n = 0
    while j >= 0 and ids.ravel()[j] == k and n < 100000: j = int(down[j]); n += 1
    nxt[k] = int(first[j]) if j >= 0 else 0
    print(f"{r['name']:32s} {area[k]:8.1f} km2 -> {next((q['name'] for q in scene['reservoirs'] if q['id'] == nxt[k]), '-')}")

G = np.clip(np.log2(acc.reshape(H, W)) * 8, 0, 255).astype(np.uint8)
Image.fromarray(np.stack([dirn, G, fl.astype(np.uint8)], -1)).save(f"{D}/flow.png", optimize=True)
json.dump({str(k): dict(next=nxt[k], area_km2=area[k]) for k in nxt}, open(f"{D}/catchments.json", "w"), indent=1)
print("wrote flow.png, catchments.json", f"cell {mpp:.0f} m")
