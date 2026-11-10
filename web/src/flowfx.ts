// Water moving through the landscape, and the peaks that divide it.
//
// FlowParticles: a few thousand drops that start on the streams and run downhill along the D8
// flow directions (flow.png), faster on bigger streams, until they reach a reservoir, the sea or
// the region's edge, then start again. Each takes the colour of the system whose reservoir it is
// heading for. Peaks: named summits, each placed on the highest ground near its listed position.
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Bounds, Frame, HeightGrid, yOf, mx, my } from "./geo";

const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];

export class FlowParticles {
  points: THREE.Points;
  private N: number;
  private cell: Int32Array; private t: Float32Array; private life: Float32Array;
  private pos: Float32Array; private col: Float32Array;
  private starts: Int32Array;
  private xs: Float32Array; private zs: Float32Array;   // scene x, z of each cell centre

  constructor(private W: number, private H: number, private dir: Uint8Array, private acc: Uint8Array,
              private first: Uint8Array, private ground: HeightGrid, b: Bounds, frame: Frame,
              private colourOf: (resId: number) => THREE.Color | null, n = 4000) {
    this.N = n;
    // starting cells: on streams (draining > ~1 km2), weighted toward the smaller ones
    const s: number[] = [];
    for (let i = 0; i < W * H; i++) if (acc[i] > 56 && dir[i]) s.push(i);
    this.starts = Int32Array.from(s);
    this.xs = new Float32Array(W); this.zs = new Float32Array(H);
    const X0 = mx(b.west), X1 = mx(b.east), Y0 = my(b.north), Y1 = my(b.south);
    for (let x = 0; x < W; x++) this.xs[x] = frame.mxz(X0 + ((X1 - X0) * (x + 0.5)) / W, 0)[0];
    for (let y = 0; y < H; y++) this.zs[y] = frame.mxz(0, Y0 + ((Y1 - Y0) * (y + 0.5)) / H)[1];
    this.cell = new Int32Array(n); this.t = new Float32Array(n); this.life = new Float32Array(n);
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) this.spawn(k, Math.random() * 8);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  private spawn(k: number, life = 8) {
    this.cell[k] = this.starts[(Math.random() * this.starts.length) | 0];
    this.t[k] = 0; this.life[k] = life;
  }

  private height(i: number) { return this.ground.data[i]; }

  /** Advance by dt seconds; `active(resId)` says whether that reservoir exists. */
  update(dt: number, active: (resId: number) => boolean) {
    const { W, dir, acc, first } = this;
    for (let k = 0; k < this.N; k++) {
      let i = this.cell[k];
      // cells per second: faster on bigger streams
      this.t[k] += dt * (2 + acc[i] / 24);
      this.life[k] -= dt;
      while (this.t[k] >= 1) {
        this.t[k] -= 1;
        const d = dir[i];
        if (!d) { this.spawn(k); i = this.cell[k]; break; }
        const x = i % W, y = (i - x) / W, nx = x + DX[d - 1], ny = y + DY[d - 1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) { this.spawn(k); i = this.cell[k]; break; }
        i = ny * W + nx;
        // into a reservoir that holds water: this drop has arrived
        if (first[i] && active(first[i]) && acc[i] > 200) { this.spawn(k); i = this.cell[k]; break; }
      }
      if (this.life[k] <= 0) { this.spawn(k); i = this.cell[k]; }
      this.cell[k] = i;
      // between this cell and the next one downstream
      const x = i % W, y = (i - x) / W, d = dir[i], f = this.t[k];
      const nx = d ? Math.min(W - 1, Math.max(0, x + DX[d - 1])) : x, ny = d ? Math.min(this.H - 1, Math.max(0, y + DY[d - 1])) : y;
      const j = ny * W + nx;
      this.pos[k * 3] = this.xs[x] + (this.xs[nx] - this.xs[x]) * f;
      this.pos[k * 3 + 1] = yOf(this.height(i) + (this.height(j) - this.height(i)) * f) + 0.02;
      this.pos[k * 3 + 2] = this.zs[y] + (this.zs[ny] - this.zs[y]) * f;
      const c = first[i] && active(first[i]) ? this.colourOf(first[i]) : null;
      const fade = Math.min(1, this.life[k] / 1.5, (8 - this.life[k]) / 0.5 + 0.2);
      // drops bound for a city reservoir in its system's colour; the rest faint
      const a = c ? fade : fade * 0.45;
      this.col[k * 3] = (c ? c.r : 0.75) * a; this.col[k * 3 + 1] = (c ? c.g : 0.88) * a; this.col[k * 3 + 2] = (c ? c.b : 1) * a;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

/** Named summits and ridges: [name, lon, lat, rank (1: shown from far away)]. Positions are
 *  approximate; each label moves to the highest ground within 1.5 km. */
const PEAKS: [string, number, number, number][] = [
  ["Slide Mountain", -74.386, 41.999, 1], ["Hunter Mountain", -74.231, 42.178, 1], ["Black Dome", -74.12, 42.27, 2],
  ["Thomas Cole", -74.14, 42.27, 3], ["Plateau Mountain", -74.21, 42.12, 3], ["Panther Mountain", -74.40, 42.06, 2],
  ["Wittenberg", -74.33, 42.02, 3], ["Cornell", -74.35, 42.01, 3], ["Peekamoose", -74.43, 41.93, 3], ["Table Mountain", -74.41, 41.94, 3],
  ["Balsam Lake Mountain", -74.59, 42.05, 3], ["Overlook Mountain", -74.12, 42.07, 2], ["Kaaterskill High Peak", -74.08, 42.13, 2],
  ["Windham High Peak", -74.18, 42.32, 3], ["Twin Mountain", -74.15, 42.15, 3], ["Indian Head", -74.12, 42.13, 3],
  ["Storm King", -74.00, 41.426, 1], ["Breakneck Ridge", -73.975, 41.447, 1], ["Bear Mountain", -73.99, 41.312, 2],
  ["Mount Beacon", -73.952, 41.487, 2], ["Schunemunk", -74.10, 41.40, 2], ["High Point", -74.662, 41.321, 2],
  ["Anthony's Nose", -73.96, 41.32, 3], ["Dunderberg", -73.97, 41.30, 3], ["Sugarloaf Hill", -73.94, 41.40, 3],
  ["Shawangunk Ridge", -74.22, 41.73, 2], ["The Palisades", -73.93, 40.90, 2],
];

export function buildPeaks(ground: HeightGrid, frame: Frame) {
  const group = new THREE.Group();
  const items: { o: CSS2DObject; rank: number; div: HTMLDivElement }[] = [];
  for (const [name, lon0, lat0, rank] of PEAKS) {
    let best = [lon0, lat0, -Infinity];
    for (let dy = -6; dy <= 6; dy++)
      for (let dx = -6; dx <= 6; dx++) {
        const lon = lon0 + dx * 0.0025, lat = lat0 + dy * 0.0019;   // ~210 m steps, ±1.3 km
        const h = ground.at(lon, lat);
        if (h > best[2]) best = [lon, lat, h];
      }
    const [lon, lat, h] = best;
    const [x, z] = frame.xz(lon, lat);
    const div = document.createElement("div");
    div.className = "label peak";
    div.innerHTML = `▲ ${name} <span>${Math.round(h).toLocaleString()} m</span>`;
    const o = new CSS2DObject(div);
    o.position.set(x, yOf(h) + 0.05, z);
    group.add(o);
    items.push({ o, rank, div });
  }
  return {
    group,
    /** show the major peaks from far away, the minor ones only up close */
    update(camDist: number) {
      for (const it of items) it.o.visible = camDist < (it.rank === 1 ? 260 : it.rank === 2 ? 120 : 60);
    },
  };
}

/** A sketch of the water table for the underground view: a subdued copy of the ground, near
 *  the surface along the valleys and deeper under the hills (halfway down to the nearby valley
 *  floors), so the hills read as a slow sponge draining to the streams. Not a measured surface. */
export function waterTableGrid(g: HeightGrid, step = 4): HeightGrid {
  const w = Math.floor(g.w / step), h = Math.floor(g.h / step);
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = g.data[(y * step) * g.w + x * step];
  const R = 8;   // ~2.8 km
  const minPass = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = -R; k <= R; k++) {
        const xx = x + k * dx, yy = y + k * dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) m = Math.min(m, src[yy * w + xx]);
      }
      out[y * w + x] = m;
    }
    return out;
  };
  const boxPass = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -R; k <= R; k++) {
        const xx = x + k * dx, yy = y + k * dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += src[yy * w + xx]; n++; }
      }
      out[y * w + x] = s / n;
    }
    return out;
  };
  const floor = boxPass(boxPass(minPass(minPass(z, 1, 0), 0, 1), 1, 0), 0, 1);
  const wt = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) {
    const f = Math.min(floor[i], z[i]);
    wt[i] = Math.max(-2, Math.min(z[i] - 2, f + 0.5 * (z[i] - f)));
  }
  return new HeightGrid(w, h, wt, g.b);
}
